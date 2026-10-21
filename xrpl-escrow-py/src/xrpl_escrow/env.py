"""Testnet wallets and kit settings from a .env file (gitignored).

The Python SDK reads the same .env the TypeScript kit writes with
``npm run setup``: CLIENT_SEED, PROVIDER_SEED, ORACLE_SEED and the public
ORACLE_VERDICT_ADDRESS. Seeds are never printed.
"""
import os
from pathlib import Path

from dotenv import dotenv_values
from xrpl.clients import WebsocketClient
from xrpl.wallet import Wallet, generate_faucet_wallet

from .config import FAUCET_HOST

ROLES = ("client", "provider", "oracle")
#: Top up below this balance, the same as the TypeScript kit. Every paid job moves
#: 10 XRP from the client to the provider for good, and the TypeScript Phase 2 demo
#: locks three 10 XRP escrows at once.
MIN_BALANCE_XRP = 60


def read_env_file(path: str | os.PathLike[str] = ".env") -> dict[str, str]:
    """Values from the .env file, with the process environment taking precedence."""
    values = {k: v for k, v in dotenv_values(path).items() if v is not None} if Path(path).exists() else {}
    return {k: os.environ.get(k, v) for k, v in values.items()}


def xrp_balance(client: WebsocketClient, address: str) -> float:
    from xrpl.models.requests import AccountInfo

    res = client.request(AccountInfo(account=address, ledger_index="validated"))
    if not res.is_successful():
        return 0.0  # account not created yet
    return int(res.result["account_data"]["Balance"]) / 1_000_000


def load_or_fund_wallets(client: WebsocketClient, env_path: str | os.PathLike[str] = ".env") -> dict[str, Wallet]:
    """Load seeds from env_path, faucet-fund any missing or low wallet, and save new seeds back."""
    path = Path(env_path)
    env = {k: v for k, v in dotenv_values(path).items() if v is not None} if path.exists() else {}
    wallets: dict[str, Wallet] = {}
    for role in ROLES:
        seed = env.get(f"{role.upper()}_SEED")
        wallet = Wallet.from_seed(seed) if seed else Wallet.create()
        if xrp_balance(client, wallet.address) < MIN_BALANCE_XRP:
            generate_faucet_wallet(client, wallet, faucet_host=FAUCET_HOST)
        wallets[role] = wallet
    changed = any(env.get(f"{r.upper()}_SEED") != wallets[r].seed for r in ROLES)
    if changed:
        for role in ROLES:
            env[f"{role.upper()}_SEED"] = wallets[role].seed or ""
        body = "\n".join(f"{k}={v}" for k, v in env.items())
        path.write_text(f"# Testnet-only seeds created by the demo. Never put mainnet seeds here.\n{body}\n", encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    return wallets
