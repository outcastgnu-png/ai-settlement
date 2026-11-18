"""Python SDK demo of shared verification, 2 of 3 oracles (EDR-015), on the XRP Ledger testnet.

The Python client makes each job's secret, splits it into three shares and seals one to each of
the TypeScript kit's three local oracles; the Python provider collects their signed verdicts,
checks each one against its oracle's pinned address and its own verdict log, and combines two
shares into the fulfillment.

    1. All three pass: finish.
    2. Two pass, one fails (oracle C dissents, ORACLE_FAULT=fail): finish.
    3. One passes, two fail (B and C dissent): no fulfillment, refund after the deadline.
    4. Oracle C is stopped: A and B still release.

Run from the xrpl-escrow-py folder, after ``npm install`` and ``npm run setup`` in ../xrpl-escrow
(setup makes oracles B and C):

    python -m xrpl_escrow.demo_phase5
"""
import argparse
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from dotenv import dotenv_values

from .auth import sha256_hex
from .config import EXPLORER_TX, connect_testnet
from .env import load_or_fund_wallets, xrp_balance
from .kit import EscrowKit, SharedVerification
from .services import TsProcess

PRICE_DROPS = "5000000"  # 5 XRP
NAMES = ["A", "B", "C"]


@dataclass
class Check:
    scenario: str
    label: str
    ok: bool
    detail: str = ""


def oracle_profiles(ts_kit: Path, env_file: Path, data_dir: Path, port: int) -> list[dict]:
    """The same three local oracles as src/local-config.ts localOracleProfile()."""
    out = []
    for i, name in enumerate(["a", "b", "c"]):
        env = env_file if i == 0 else Path(f"{env_file}.oracle-{name}")
        data = data_dir if i == 0 else data_dir / f"oracle-{name}"
        values = dotenv_values(env) if env.exists() else {}
        if not values.get("ORACLE_VERDICT_ADDRESS") or not values.get("ORACLE_ANCHOR_ADDRESS"):
            raise RuntimeError(f"oracle {name}: {env} has no verdict or anchor address; run `npm run setup` in {ts_kit}")
        out.append({"env": env, "data": data, "port": port + i,
                    "ref": {"address": values["ORACLE_VERDICT_ADDRESS"], "anchor": values["ORACLE_ANCHOR_ADDRESS"], "url": f"http://127.0.0.1:{port + i}"}})
    return out


def run(xrpl, wallets, ts_kit: Path, env_file: Path, data_dir: Path, *, registry_port: int = 8831, oracle_port: int = 8832,
        log=print) -> list[Check]:
    checks: list[Check] = []
    scenario = ""
    payer, provider = wallets["client"], wallets["provider"]
    registry_url = f"http://127.0.0.1:{registry_port}"
    profiles = oracle_profiles(ts_kit, env_file, data_dir, oracle_port)
    oracle_set = [p["ref"] for p in profiles]
    common = {"REGISTRY_PORT": str(registry_port), "REGISTRY_URL": registry_url, "JOBS_DB": str(data_dir / "jobs.db"), "ANCHOR_INTERVAL_MS": "4000"}

    def check(label: str, ok: bool, detail: str = "") -> None:
        checks.append(Check(scenario, label, ok, detail))
        log(f"  {'PASS' if ok else 'FAIL'}  {label}{f' ({detail})' if detail else ''}")

    def oracle(i: int, fault: bool) -> TsProcess:
        p = profiles[i]
        d = p["data"]
        env = {**common, "ENV_FILE": str(p["env"]), "DATA_DIR": str(d), "ORACLE_PORT": str(p["port"]), "ORACLE_FAULT": "fail" if fault else "",
               "VAULT_FILE": str(d / "oracle-vault.json"), "VERDICT_LOG": str(d / "verdicts.jsonl"), "VERDICT_CHAIN": str(d / "verdict-log.jsonl"),
               "ANCHOR_FILE": str(d / "verdict-anchors.jsonl"), "REPLAY_FILE": str(d / "oracle-replay.json")}
        return TsProcess(ts_kit, f"oracle {NAMES[i]}", "src/oracle/server.ts", env, health_url=p["ref"]["url"], log=log).start()

    kit = EscrowKit(xrpl=xrpl, registry_url=registry_url, env_file=env_file, status_timeout=90)
    work = f"python shared-verification report {datetime.now(timezone.utc).isoformat()}\n"
    spec = {"title": "python phase 5 demo", "checks": [{"type": "sha256-match", "sha256": sha256_hex(work)}]}

    def funded_job(sla: int) -> dict:
        job = kit.create_shared_job(client=payer.address, provider=provider.address, price_drops=PRICE_DROPS, sla_seconds=sla, spec=spec,
                                    oracles=oracle_set, threshold=2, client_wallet=payer)
        check("client split the secret 2 of 3; every oracle took its sealed share", job["threshold"] == 2, f"job {job['id']}")
        funded = kit.fund_job(job["id"], payer)
        check("EscrowCreate -> tesSUCCESS, watcher -> funded", funded.tx.code == "tesSUCCESS" and funded.job["status"] == "funded",
              f"{funded.tx.code} {EXPLORER_TX}{funded.tx.hash}")
        return funded.job

    def report(res: SharedVerification) -> None:
        for r in res.reports:
            log_part = ""
            if r.log is not None:
                anchor = r.log.anchor
                log_part = f"; log head entry {r.log.head['seq'] if r.log.head else '?'}" + (
                    f", last anchor entry {anchor['seq']} {EXPLORER_TX}{anchor['txHash']}" if anchor else ", no anchor yet")
            log(f"    oracle {NAMES[r.index - 1]} {r.oracle['address']}: {r.status}{', share used' if r.used else ''}{log_part}"
                f"{'; ' + '; '.join(r.problems) if r.problems else ''}")

    def claim(job: dict, res: SharedVerification) -> None:
        check("fulfillment combined from two shares", res.fulfillment is not None,
              "shares of " + " and ".join(NAMES[r.index - 1] for r in res.reports if r.used))
        if not res.fulfillment:
            return
        before = xrp_balance(xrpl, provider.address)
        paid = kit.claim(job["id"], provider, res.fulfillment)
        check("EscrowFinish -> tesSUCCESS, watcher -> paid", paid.tx.code == "tesSUCCESS" and paid.job["status"] == "paid",
              f"{paid.tx.code} {EXPLORER_TX}{paid.tx.hash}")
        gained = xrp_balance(xrpl, provider.address) - before
        check("provider gains the price minus the finish fee", 4.99 < gained <= 5, f"+{gained:.6f} XRP")

    env_main = {**common, "ENV_FILE": str(env_file)}
    services = [TsProcess(ts_kit, "registry", "src/registry/server.ts", env_main, health_url=registry_url, log=log).start(),
                TsProcess(ts_kit, "watcher", "src/watcher.ts", env_main, ready_text="[watcher] connected", log=log).start()]
    oracles = [oracle(0, False), oracle(1, False), oracle(2, True)]
    try:
        scenario = "2. Two pass, one fails"
        log(f"\n{scenario}: oracle C dissents (ORACLE_FAULT=fail)")
        job2 = funded_job(300)
        d2 = kit.deliver_shared(job2["id"], provider, work)
        report(d2)
        check("A and B pass, C fails; registry -> verified_pass", len(d2.passed) == 2 and d2.failed == [oracle_set[2]["address"]]
              and d2.job["status"] == "verified_pass")
        claim(job2, d2)

        oracles[1].stop()
        oracles[1] = oracle(1, True)
        scenario = "3. One passes, two fail"
        log(f"\n{scenario}: oracles B and C dissent")
        job3 = funded_job(60)
        d3 = kit.deliver_shared(job3["id"], provider, work)
        report(d3)
        check("only A passes: no fulfillment, registry -> verified_fail", len(d3.passed) == 1 and d3.fulfillment is None
              and d3.job["status"] == "verified_fail")

        for i in (1, 2):
            oracles[i].stop()
            oracles[i] = oracle(i, False)
        scenario = "1. All three pass"
        log(f"\n{scenario}")
        job1 = funded_job(300)
        d1 = kit.deliver_shared(job1["id"], provider, work)
        report(d1)
        check("all three pass and every verdict log checks", len(d1.passed) == 3 and not d1.rejected)
        claim(job1, d1)

        scenario = "4. One oracle stopped"
        log(f"\n{scenario}: oracle C is stopped after it took its share")
        job4 = funded_job(300)
        oracles[2].stop()
        d4 = kit.deliver_shared(job4["id"], provider, work, attempts=1)
        report(d4)
        check("C unreachable, A and B pass", d4.unreachable == [oracle_set[2]["address"]] and len(d4.passed) == 2)
        claim(job4, d4)

        scenario = "3. One passes, two fail"
        log(f"\n{scenario} (after the deadline)")
        client_before = xrp_balance(xrpl, payer.address)
        refunded = kit.refund(job3["id"], payer)
        check("EscrowCancel -> tesSUCCESS, watcher -> refunded", refunded.tx.code == "tesSUCCESS" and refunded.job["status"] == "refunded",
              f"{refunded.tx.code} {EXPLORER_TX}{refunded.tx.hash}")
        back = xrp_balance(xrpl, payer.address) - client_before
        check("client gets the price back minus the cancel fee", 4.99 < back <= 5, f"+{back:.6f} XRP")
        splits = {s["jobId"] for s in kit.split_jobs()}
        check("the splits list has jobs 2 and 3, not job 1", job2["id"] in splits and job3["id"] in splits and job1["id"] not in splits)
    finally:
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
    print(f"connected to {xrpl.url} (network_id checked = 1)")
    try:
        wallets = load_or_fund_wallets(xrpl, env_file)
        checks = run(xrpl, wallets, ts_kit, env_file, Path(args.data).resolve() if args.data else ts_kit / "data")
    finally:
        xrpl.close()
    passed = sum(c.ok for c in checks)
    print(f"\n{passed}/{len(checks)} checks passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
