"""The Python demo's two scenarios on the XRP Ledger testnet, through the
TypeScript kit's services started on spare ports with throwaway data.
Run with: python -m pytest --testnet"""
import re
import tempfile
from pathlib import Path

import pytest
from xrpl.constants import CryptoAlgorithm
from xrpl.wallet import Wallet, generate_faucet_wallet

from xrpl_escrow.config import FAUCET_HOST

from xrpl_escrow import EscrowKit, connect_testnet, load_or_fund_wallets
from xrpl_escrow.demo import run
from xrpl_escrow.services import ts_services

from conftest import TS_KIT


def throwaway_oracle_env(xrpl, base: Path, folder: Path) -> Path:
    """A copy of .env with a fresh verdict key and a fresh faucet-funded anchor wallet. The services start a
    new verdict log in a temp folder, and one anchor account anchors one log (Gpno N29)."""
    keep = [line for line in base.read_text(encoding="utf-8").splitlines()
            if line and not re.match(r"^ORACLE_(VERDICT|ANCHOR)_(SEED|ADDRESS)=", line)]
    verdict_key = Wallet.create(CryptoAlgorithm.ED25519)
    anchor = Wallet.create()
    generate_faucet_wallet(xrpl, anchor, faucet_host=FAUCET_HOST)
    env_file = folder / ".env"
    env_file.write_text("\n".join([*keep, f"ORACLE_VERDICT_SEED={verdict_key.seed}", f"ORACLE_VERDICT_ADDRESS={verdict_key.address}",
                                    f"ORACLE_ANCHOR_SEED={anchor.seed}", f"ORACLE_ANCHOR_ADDRESS={anchor.address}"]) + "\n",
                        encoding="utf-8")
    return env_file


@pytest.mark.testnet
def test_pass_claim_and_fail_refund_on_testnet():
    base_env = TS_KIT / ".env"
    if not base_env.exists():
        pytest.skip("run `npm run setup` in xrpl-escrow first")
    xrpl = connect_testnet()
    try:
        wallets = load_or_fund_wallets(xrpl, base_env)
        with tempfile.TemporaryDirectory() as data, tempfile.TemporaryDirectory() as keys, ts_services(
            TS_KIT, registry_port=18811, oracle_port=18812, data_dir=Path(data),
            env_file=(env_file := throwaway_oracle_env(xrpl, base_env, Path(keys))), log=lambda _l: None,
        ) as urls:
            kit = EscrowKit(xrpl=xrpl, registry_url=urls["registryUrl"], oracle_url=urls["oracleUrl"], env_file=env_file,
                            status_timeout=90)
            checks = run(kit, xrpl, wallets, log=lambda _l: None)
    finally:
        xrpl.close()
    assert [f"{c.scenario}: {c.label} {c.detail}" for c in checks if not c.ok] == []
    assert len(checks) == 16
