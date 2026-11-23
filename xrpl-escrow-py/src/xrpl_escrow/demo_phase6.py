"""Python SDK demo of signed job specs (EDR-016) on the XRP Ledger testnet.

The Python client writes a job spec v1 (acceptance criteria and the checks behind each),
signs its hash, the Python provider signs it too, and the client locks XRP with the spec
hash in a memo on the EscrowCreate. The TypeScript kit's oracles check that memo before
they verify, and sign verdicts per criterion.

    1. Both sign, the work passes: finish.
    2. The provider hasn't signed: the SDK refuses to lock any XRP.
    3. The registry's spec is changed after the lock: the oracle refuses; refund after the deadline.
    4. A subjective criterion with no check: refused before any XRP moves.
    5. "At least 2 of 3 criteria": passes with one criterion failed; finish.
    6. A shared job (2 of 3) where oracle C is given a different spec: C refuses, A and B release; finish.

Run from the xrpl-escrow-py folder, after ``npm install`` and ``npm run setup`` in ../xrpl-escrow:

    python -m xrpl_escrow.demo_phase6
"""
import argparse
import http.server
import json
import sqlite3
import sys
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .auth import sha256_hex
from .config import EXPLORER_TX, connect_testnet
from .demo_phase5 import NAMES, PRICE_DROPS, Check, oracle_profiles
from .env import load_or_fund_wallets, xrp_balance
from .http import ServiceError
from .job_spec import is_spec_v1, ledger_tx_lookup, make_job_spec, parse_spec_memo, spec_hash
from .kit import EscrowKit
from .services import TsProcess

LOOSE = [{"id": "anything", "statement": "Anything at all", "kind": "objective", "checks": [{"type": "size-range", "minBytes": 1, "maxBytes": 1000000}]}]


def report(n: int) -> str:
    return json.dumps({"summary": f"Summary: testnet escrow fees, python run {n}", "sources": ["the EscrowCreate and EscrowFinish of this demo"],
                       "findings": ["a conditional EscrowFinish pays a higher fee", "a memo adds a few bytes and no fee tier"]})


def criteria(n: int) -> list[dict]:
    return [
        {"id": "format", "statement": "A JSON report with a summary, sources and findings", "kind": "objective",
         "checks": [{"type": "json-schema", "schema": {"type": "object", "properties": {"summary": {"type": "string"}, "sources": {"type": "array"},
                                                                                        "findings": {"type": "array"}},
                                                       "required": ["summary", "sources", "findings"]}}]},
        {"id": "useful", "statement": "The research is useful", "kind": "subjective",
         "checks": [{"type": "size-range", "minBytes": 100, "maxBytes": 20000}, {"type": "contains-text", "text": "Summary:"}]},
        {"id": "exact", "statement": "It is the exact report agreed in advance", "kind": "objective",
         "checks": [{"type": "sha256-match", "sha256": sha256_hex(report(n))}]},
    ]


def start_tamper_proxy(registry_url: str) -> tuple[http.server.ThreadingHTTPServer, str]:
    """For this demo only: forwards to the registry on 127.0.0.1 but serves every job's v1 spec loosened."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):  # quiet
            pass

        def _forward(self):
            body = self.rfile.read(int(self.headers.get("content-length") or 0)) or None
            headers = {k: v for k, v in (("content-type", self.headers.get("content-type")), ("authorization", self.headers.get("authorization"))) if v}
            req = urllib.request.Request(f"{registry_url}{self.path}", data=body, method=self.command, headers=headers)
            try:
                with opener.open(req) as res:
                    status, text = res.status, res.read()
            except urllib.error.HTTPError as err:
                status, text = err.code, err.read()
            if self.command == "GET" and self.path.count("/") == 2 and self.path.startswith("/jobs/") and status == 200:
                job = json.loads(text)
                if is_spec_v1(job.get("spec")):
                    job["spec"] = {**job["spec"], "criteria": LOOSE, "rule": "all"}
                text = json.dumps(job).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(text)))
            self.end_headers()
            self.wfile.write(text)

        do_GET = do_POST = do_PUT = _forward

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def run(xrpl, wallets, ts_kit: Path, env_file: Path, data_dir: Path, *, registry_port: int = 8841, oracle_port: int = 8842,
        log=print) -> list[Check]:
    checks: list[Check] = []
    scenario = ""
    payer, provider = wallets["client"], wallets["provider"]
    registry_url = f"http://127.0.0.1:{registry_port}"
    profiles = oracle_profiles(ts_kit, env_file, data_dir, oracle_port)
    oracle_set = [p["ref"] for p in profiles]
    jobs_db = data_dir / "jobs-phase6-py.db"
    common = {"REGISTRY_PORT": str(registry_port), "REGISTRY_URL": registry_url, "JOBS_DB": str(jobs_db), "ANCHOR_INTERVAL_MS": "4000"}
    lookup = ledger_tx_lookup(xrpl)

    def check(label: str, ok: bool, detail: str = "") -> bool:
        checks.append(Check(scenario, label, ok, detail))
        log(f"  {'PASS' if ok else 'FAIL'}  {label}{f' ({detail})' if detail else ''}")
        return ok

    def oracle(i: int, registry: str = registry_url) -> TsProcess:
        p = profiles[i]
        d = p["data"]
        env = {**common, "REGISTRY_URL": registry, "ENV_FILE": str(p["env"]), "DATA_DIR": str(d), "ORACLE_PORT": str(p["port"]), "ORACLE_FAULT": "",
               "VAULT_FILE": str(d / "oracle-vault.json"), "VERDICT_LOG": str(d / "verdicts.jsonl"), "VERDICT_CHAIN": str(d / "verdict-log.jsonl"),
               "ANCHOR_FILE": str(d / "verdict-anchors.jsonl"), "REPLAY_FILE": str(d / "oracle-replay.json")}
        return TsProcess(ts_kit, f"oracle {NAMES[i]}", "src/oracle/server.ts", env, health_url=p["ref"]["url"], log=log).start()

    kit = EscrowKit(xrpl=xrpl, registry_url=registry_url, oracle_url=oracle_set[0]["url"], oracle_address=oracle_set[0]["address"],
                    anchor_address=oracle_set[0]["anchor"], env_file=env_file, status_timeout=90)

    def spec(n: int, sla: int, rule="all") -> dict:
        return make_job_spec(title=f"Python Phase 6 demo job {n}", client=payer.address, provider=provider.address, price_drops=PRICE_DROPS,
                             sla_seconds=sla, criteria=criteria(n), rule=rule)

    def show_spec(s: dict) -> None:
        log(f"    spec v{s['specVersion']} revision {s['revision']}, hash {spec_hash(s)}; rule: {s['rule']}")
        for c in s["criteria"]:
            log(f"      {c['id']} ({c['kind']}): \"{c['statement']}\" decided by {', '.join(x['type'] for x in c['checks'])}")

    def show_verdict(who: str, v: dict | None) -> None:
        if not v:
            return
        log(f"    {who}: {v['verdict']} on spec {v.get('specHash')} revision {v.get('specRevision')}, judged the {v.get('judged')}")
        for c in v.get("criteria") or []:
            parts = ", ".join(f"{r['type']}: {'pass' if r['pass'] else 'fail'}" for r in v["checks"] if r.get("criterion") == c["id"])
            log(f"      {c['id']} ({c['kind']}): {'pass' if c['pass'] else 'fail'} [{parts}]")

    def signed_funded_job(s: dict, shared: bool = False) -> dict:
        show_spec(s)
        if shared:
            draft = kit.create_shared_job(spec=s, oracles=oracle_set, threshold=2, client_wallet=payer)
        else:
            draft = kit.create_signed_job(s, payer)
        signed = kit.sign_spec(draft["id"], provider, spec_hash(s))
        sigs = signed.get("specSignatures") or {}
        check("client and provider both signed the spec hash", bool(sigs.get("client")) and bool(sigs.get("provider")),
              f"client {sigs.get('client', {}).get('address')}, provider {sigs.get('provider', {}).get('address')}")
        funded = kit.fund_job(draft["id"], payer, spec_hash_pin=spec_hash(s))
        check("EscrowCreate with the spec memo -> tesSUCCESS, watcher -> funded", funded.tx.code == "tesSUCCESS" and funded.job["status"] == "funded",
              f"{funded.tx.code} {EXPLORER_TX}{funded.tx.hash}")
        found = lookup(funded.tx.hash)
        memo = parse_spec_memo((found.get("tx") or {}).get("Memos")) if found.get("found") else None
        check("the validated EscrowCreate's memo holds the spec hash", bool(memo) and memo.get("specHash") == spec_hash(s), json.dumps(memo))
        return funded.job

    def claim(job: dict, fulfillment: str | None) -> None:
        if not check("fulfillment released", fulfillment is not None):
            return
        before = xrp_balance(xrpl, provider.address)
        paid = kit.claim(job["id"], provider, fulfillment)
        check("EscrowFinish -> tesSUCCESS, watcher -> paid", paid.tx.code == "tesSUCCESS" and paid.job["status"] == "paid",
              f"{paid.tx.code} {EXPLORER_TX}{paid.tx.hash}")
        gained = xrp_balance(xrpl, provider.address) - before
        check("provider gains the price minus the finish fee", 4.99 < gained <= 5, f"+{gained:.6f} XRP")

    env_main = {**common, "ENV_FILE": str(env_file)}
    services = [TsProcess(ts_kit, "registry", "src/registry/server.ts", env_main, health_url=registry_url, log=log).start(),
                TsProcess(ts_kit, "watcher", "src/watcher.ts", env_main, ready_text="[watcher] connected", log=log).start()]
    oracles = [oracle(0), oracle(1), oracle(2)]
    proxy = None
    try:
        scenario = "3. Spec changed after the lock"
        log(f"\n{scenario}")
        s3 = spec(3, 60)
        job3 = signed_funded_job(s3)
        with sqlite3.connect(jobs_db) as db:
            db.execute("UPDATE jobs SET spec = ? WHERE id = ?", (json.dumps({**s3, "criteria": LOOSE, "rule": "all"}), job3["id"]))
        try:
            kit.deliver(job3["id"], provider, "not the report")
            check("the oracle refuses the job and signs nothing", False, "it verified")
        except ServiceError as err:
            check("the oracle refuses the job and signs nothing", err.status == 409 and "not the spec locked on the ledger" in str(err), str(err))

        scenario = "1. Both sign, the work passes"
        log(f"\n{scenario}")
        job1 = signed_funded_job(spec(1, 300))
        d1 = kit.deliver(job1["id"], provider, report(1))
        show_verdict("oracle A", d1.verdict)
        check("signed verdict: pass on the signed spec hash, every criterion passed",
              d1.verdict_signature_valid and d1.spec_matches and all(c["pass"] for c in d1.verdict["criteria"]))
        claim(job1, d1.fulfillment)
        logv = kit.verify_verdict_log(verdict=d1.verdict, job=kit.get_job(job1["id"]), allow_unanchored=True)
        check("the verdict is a v2 entry in oracle A's log and its spec hash is the EscrowCreate memo's",
              logv.ok and logv.spec_on_ledger is True and (logv.verdict_entry or {}).get("v") == 2, "; ".join(logv.problems))

        scenario = "2. The provider hasn't signed"
        log(f"\n{scenario}")
        s2 = spec(2, 300)
        job2 = kit.create_signed_job(s2, payer)
        before = xrp_balance(xrpl, payer.address)
        try:
            kit.fund_job(job2["id"], payer)
            check("the SDK refuses to lock XRP", False, "it funded")
        except ValueError as err:
            check("the SDK refuses to lock XRP", "provider" in str(err) and "has not signed" in str(err), str(err))
        check("no EscrowCreate was sent: the client's balance is unchanged", xrp_balance(xrpl, payer.address) == before)

        scenario = "4. Subjective criterion with no check"
        log(f"\n{scenario}")
        try:
            make_job_spec(title="vague", client=payer.address, provider=provider.address, price_drops=PRICE_DROPS, sla_seconds=300,
                          criteria=[{"id": "useful", "statement": "The research is useful", "kind": "subjective", "checks": []}])
            check("refused before anything is sent", False, "accepted")
        except ValueError as err:
            check("refused before anything is sent", "can't judge that statement" in str(err), str(err))

        scenario = "5. At least 2 of 3 criteria"
        log(f"\n{scenario}")
        job5 = signed_funded_job(spec(5, 300, {"atLeast": 2}))
        d5 = kit.deliver(job5["id"], provider, report(55))
        show_verdict("oracle A", d5.verdict)
        check("format pass, useful pass, exact fail; the rule is met",
              [c["pass"] for c in d5.verdict["criteria"]] == [True, True, False] and d5.verdict["verdict"] == "pass")
        claim(job5, d5.fulfillment)

        scenario = "6. Shared job, one oracle given a different spec"
        log(f"\n{scenario}: oracle C reads jobs through a stand-in registry that loosens every spec")
        proxy, proxy_url = start_tamper_proxy(registry_url)
        oracles[2].stop()
        oracles[2] = oracle(2, proxy_url)
        s6 = spec(6, 300)
        job6 = signed_funded_job(s6, shared=True)
        d6 = kit.deliver_shared(job6["id"], provider, report(6))
        for r in d6.reports:
            if r.verdict:
                show_verdict(f"oracle {NAMES[r.index - 1]}", r.verdict)
            else:
                log(f"    oracle {NAMES[r.index - 1]}: {r.status}: {'; '.join(r.problems or [])}")
        check("oracle C refuses: its spec is not the one locked on the ledger",
              d6.refused == [oracle_set[2]["address"]] and "not the spec locked on the ledger" in " ".join(d6.reports[2].problems or []))
        check("A and B pass on the signed spec hash, and their verdicts match the memo",
              len(d6.passed) == 2 and all(r.verdict["specHash"] == spec_hash(s6) and r.log.spec_on_ledger for r in d6.reports[:2]))
        claim(job6, d6.fulfillment)

        scenario = "3. Spec changed after the lock"
        log(f"\n{scenario} (after the deadline)")
        refunded = kit.refund(job3["id"], payer)
        check("EscrowCancel -> tesSUCCESS, watcher -> refunded", refunded.tx.code == "tesSUCCESS" and refunded.job["status"] == "refunded",
              f"{refunded.tx.code} {EXPLORER_TX}{refunded.tx.hash}")
    finally:
        if proxy:
            proxy.shutdown()
        for p in [services[1], *oracles, services[0]]:
            p.stop()
    return checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ts-kit", default=str(Path("..") / "xrpl-escrow"), help="the TypeScript kit folder (default ../xrpl-escrow)")
    parser.add_argument("--env", default=None, help="the .env with the testnet seeds (default <ts-kit>/.env)")
    parser.add_argument("--data", default=None, help="oracle A's data folder (default <ts-kit>/data)")
    args = parser.parse_args(argv)
    ts_kit = Path(args.ts_kit).resolve()
    env_file = Path(args.env).resolve() if args.env else ts_kit / ".env"
    if not Path(f"{env_file}.oracle-c").exists():
        print(f"oracles B and C are not set up: run `npm run setup` in {ts_kit} first", file=sys.stderr)
        return 2
    xrpl = connect_testnet()
    print(f"python -m xrpl_escrow.demo_phase6, {datetime.now(timezone.utc).isoformat()}")
    print(f"connected to {xrpl.url} (network_id checked = 1)")
    try:
        wallets = load_or_fund_wallets(xrpl, env_file)
        checks = run(xrpl, wallets, ts_kit, env_file, Path(args.data).resolve() if args.data else ts_kit / "data")
    finally:
        xrpl.close()
    passed = sum(c.ok for c in checks)
    print(f"\n{passed}/{len(checks)} checks passed")
    for c in checks:
        if not c.ok:
            print(f"  FAILED  {c.scenario}: {c.label} {c.detail}")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
