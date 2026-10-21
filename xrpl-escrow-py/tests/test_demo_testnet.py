"""The Python demo's two scenarios on the XRP Ledger testnet, through the
TypeScript kit's services started on spare ports with throwaway data.
Run with: python -m pytest --testnet"""
import tempfile
from pathlib import Path

import pytest

from xrpl_escrow import EscrowKit, connect_testnet, load_or_fund_wallets
from xrpl_escrow.demo import run
from xrpl_escrow.services import ts_services

from conftest import TS_KIT


@pytest.mark.testnet
def test_pass_claim_and_fail_refund_on_testnet():
    env_file = TS_KIT / ".env"
    if not env_file.exists():
        pytest.skip("run `npm run setup` in xrpl-escrow first")
    xrpl = connect_testnet()
    try:
        wallets = load_or_fund_wallets(xrpl, env_file)
        with tempfile.TemporaryDirectory() as data, ts_services(
            TS_KIT, registry_port=18811, oracle_port=18812, data_dir=Path(data), env_file=env_file, log=lambda _l: None,
        ) as urls:
            kit = EscrowKit(xrpl=xrpl, registry_url=urls["registryUrl"], oracle_url=urls["oracleUrl"], env_file=env_file,
                            status_timeout=90)
            checks = run(kit, xrpl, wallets, log=lambda _l: None)
    finally:
        xrpl.close()
    assert [f"{c.scenario}: {c.label} {c.detail}" for c in checks if not c.ok] == []
    assert len(checks) == 12
