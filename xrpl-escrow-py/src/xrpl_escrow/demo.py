"""Python SDK demo on the XRP Ledger testnet, through the kit's local services.

    1. Pass and claim: the work passes the oracle's checks and the provider is paid.
    2. Fail and refund: the work fails, and after the deadline the client gets the price back.

Run from the xrpl-escrow-py folder, after ``npm install`` and ``npm run setup``
in ../xrpl-escrow:

    python -m xrpl_escrow.demo --start-services

Without --start-services it uses services you started yourself with
``npm run registry``, ``npm run oracle`` and ``npm run watcher``.
"""
import argparse
import sys
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .auth import sha256_hex
from .config import EXPLORER_TX, connect_testnet
from .env import load_or_fund_wallets, xrp_balance
from .escrow import get_escrow
from .http import ServiceError
from .kit import REGISTRY_URL, ORACLE_URL, EscrowKit, escrow_ref
from .services import ts_services

PRICE_DROPS = "10000000"  # 10 XRP


@dataclass
class Check:
    scenario: str
    label: str
    ok: bool
    detail: str = ""


def run(kit: EscrowKit, xrpl, wallets, log=print) -> list[Check]:
    checks: list[Check] = []
    scenario = ""
    payer, provider = wallets["client"], wallets["provider"]

    def check(label: str, ok: bool, detail: str = "") -> None:
        checks.append(Check(scenario, label, ok, detail))
        log(f"  {'PASS' if ok else 'FAIL'}  {label}{f' ({detail})' if detail else ''}")

    def balances() -> str:
        return f"client {xrp_balance(xrpl, payer.address):.6f} XRP, provider {xrp_balance(xrpl, provider.address):.6f} XRP"

    stamp = datetime.now(timezone.utc).isoformat()

    scenario = "1. Pass and claim"
    log(f"\n{scenario}: the work passes the oracle's checks and the provider claims 10 XRP")
    log(f"  before: {balances()}")
    provider_before = xrp_balance(xrpl, provider.address)
    work = f"python sdk deliverable {stamp}\n"
    job = kit.create_job(payer.address, provider.address, PRICE_DROPS, 300,
                         {"title": "python demo", "checks": [{"type": "sha256-match", "sha256": sha256_hex(work)}]})
    check("job registered as draft with the oracle's condition", job["status"] == "draft" and bool(job["condition"]), f"job {job['id']}")
    funded = kit.fund_job(job["id"], payer)
    check("EscrowCreate -> tesSUCCESS, watcher -> funded", funded.tx.code == "tesSUCCESS" and funded.job["status"] == "funded",
          f"{funded.tx.code} {EXPLORER_TX}{funded.tx.hash}")
    res = kit.deliver(job["id"], provider, work)
    check("oracle verdict is pass, signed by the pinned oracle address", res.verdict["verdict"] == "pass" and res.verdict_signature_valid,
          f"oracle {res.verdict['oracle']}")
    check("fulfillment released to the provider", res.fulfillment is not None)
    if res.fulfillment:
        paid = kit.claim(job["id"], provider, res.fulfillment)
        check("EscrowFinish -> tesSUCCESS, watcher -> paid", paid.tx.code == "tesSUCCESS" and paid.job["status"] == "paid",
              f"{paid.tx.code} {EXPLORER_TX}{paid.tx.hash}")
        check("escrow object is gone from the ledger", get_escrow(xrpl, escrow_ref(paid.job)) is None)
    gained = xrp_balance(xrpl, provider.address) - provider_before
    check("provider gains the price minus the finish fee", 9.99 < gained <= 10, f"+{gained:.6f} XRP")
    log(f"  after: {balances()}")

    scenario = "2. Fail and refund"
    log(f"\n{scenario}: the work fails the checks; the client is refunded after the deadline")
    log(f"  before: {balances()}")
    work = f"python sdk deliverable {stamp}, the one that was ordered\n"
    job = kit.create_job(payer.address, provider.address, PRICE_DROPS, 60,
                         {"title": "python demo", "checks": [{"type": "sha256-match", "sha256": sha256_hex(work)}]})
    funded = kit.fund_job(job["id"], payer)
    check("EscrowCreate -> tesSUCCESS, watcher -> funded", funded.tx.code == "tesSUCCESS" and funded.job["status"] == "funded",
          f"{funded.tx.code} {EXPLORER_TX}{funded.tx.hash}")
    client_after_create = xrp_balance(xrpl, payer.address)
    res = kit.deliver(job["id"], provider, "not what was ordered\n")
    check("oracle verdict is fail, signed, and no fulfillment", res.verdict["verdict"] == "fail" and res.verdict_signature_valid
          and res.fulfillment is None, res.verdict["checks"][0]["detail"])
    try:
        kit.request_verification(job["id"], payer)
        check("the client cannot get a verdict or fulfillment for the provider's job", False)
    except ServiceError as err:
        check("the client cannot get a verdict or fulfillment for the provider's job", err.status == 403, str(err.status))
    log("  waiting for a validated ledger past CancelAfter ...")
    refunded = kit.refund(job["id"], payer)
    check("EscrowCancel -> tesSUCCESS, watcher -> refunded", refunded.tx.code == "tesSUCCESS" and refunded.job["status"] == "refunded",
          f"{refunded.tx.code} {EXPLORER_TX}{refunded.tx.hash}")
    back = xrp_balance(xrpl, payer.address) - client_after_create
    check("client gets the price back minus the cancel fee", 9.99 < back <= 10, f"+{back:.6f} XRP")
    log(f"  after: {balances()}")
    return checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ts-kit", default=str(Path("..") / "xrpl-escrow"), help="the TypeScript kit folder (default ../xrpl-escrow)")
    parser.add_argument("--env", default=None, help="the .env with the testnet seeds (default <ts-kit>/.env)")
    parser.add_argument("--start-services", action="store_true", help="start the registry, oracle and watcher for this run")
    args = parser.parse_args(argv)
    env_file = Path(args.env) if args.env else Path(args.ts_kit) / ".env"
    if not env_file.exists():
        print(f"{env_file} not found: run `npm run setup` in {args.ts_kit} first", file=sys.stderr)
        return 2

    xrpl = connect_testnet()
    print(f"connected to {xrpl.url} (network_id checked = 1)")
    try:
        wallets = load_or_fund_wallets(xrpl, env_file)
        services = ts_services(args.ts_kit, env_file=env_file) if args.start_services else nullcontext(
            {"registryUrl": REGISTRY_URL, "oracleUrl": ORACLE_URL})
        with services as urls:
            kit = EscrowKit(xrpl=xrpl, registry_url=urls["registryUrl"], oracle_url=urls["oracleUrl"], env_file=env_file,
                            status_timeout=90)
            try:
                kit.oracle_info()
            except Exception:  # noqa: BLE001
                print(f"no oracle at {kit.oracle_url}: start the services or pass --start-services", file=sys.stderr)
                return 2
            print(f"oracle verdict key pinned to {kit.oracle_address}")
            checks = run(kit, xrpl, wallets)
    finally:
        xrpl.close()
    passed = sum(c.ok for c in checks)
    print(f"\n{passed}/{len(checks)} checks passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
