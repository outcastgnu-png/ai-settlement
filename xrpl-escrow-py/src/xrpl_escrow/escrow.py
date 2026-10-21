"""The three native escrow transactions. Each is signed locally by the wallet
that sends it; nothing here ever holds anyone's funds."""
import time
from dataclasses import dataclass
from typing import Any

from xrpl.clients import WebsocketClient
from xrpl.models.requests import Ledger, LedgerEntry, Tx
from xrpl.models.requests.ledger_entry import Escrow as EscrowLocator
from xrpl.models.transactions import EscrowCancel, EscrowCreate, EscrowFinish, Transaction
from xrpl.transaction import autofill_and_sign, submit
from xrpl.wallet import Wallet

from .config import now_ripple_time


@dataclass(frozen=True)
class TxResult:
    hash: str
    code: str  # engine result from the validated ledger, e.g. tesSUCCESS
    sequence: int


@dataclass(frozen=True)
class EscrowRef:
    owner: str
    offer_sequence: int
    condition: str
    cancel_after: int  # Ripple epoch seconds


def submit_validated(client: WebsocketClient, wallet: Wallet, tx: Transaction) -> TxResult:
    """Sign and submit, then return the result recorded in a validated ledger.

    A tec* result is a normal return value here, never an exception, so callers
    can check ``code`` the same way for every outcome. A tem*, tef* or tel* answer
    from the server raises at once, with that code.
    """
    signed = autofill_and_sign(tx, client, wallet)
    sequence = int(signed.sequence or 0)
    last_ledger = int(signed.last_ledger_sequence or 0)
    tx_hash = signed.get_hash()
    preliminary = str(submit(signed, client).result.get("engine_result", ""))
    if preliminary.startswith(("tem", "tef", "tel")):
        # Rejected outright: it can never reach a ledger, so say why now instead of
        # waiting for LastLedgerSequence and calling it expired.
        raise RuntimeError(f"transaction {tx_hash} was rejected before reaching a ledger: {preliminary}")
    while True:
        res = client.request(Tx(transaction=tx_hash))
        if res.is_successful() and res.result.get("validated"):
            return TxResult(tx_hash, str(res.result.get("meta", {}).get("TransactionResult", "unknown")), sequence)
        validated = client.request(Ledger(ledger_index="validated")).result["ledger_index"]
        if int(validated) > last_ledger:
            raise RuntimeError(f"transaction {tx_hash} expired without making it into a validated ledger")
        time.sleep(1)


def create_escrow(
    client: WebsocketClient, payer: Wallet, provider: str, drops: str, condition: str, sla_seconds: int,
) -> tuple[TxResult, EscrowRef]:
    """Client locks ``drops`` for ``provider``, unlockable with ``condition`` until ``sla_seconds`` from now."""
    cancel_after = now_ripple_time() + sla_seconds
    tx = EscrowCreate(account=payer.address, destination=provider, amount=drops, condition=condition, cancel_after=cancel_after)
    result = submit_validated(client, payer, tx)
    return result, EscrowRef(payer.address, result.sequence, condition, cancel_after)


def finish_escrow(client: WebsocketClient, sender: Wallet, escrow: EscrowRef, fulfillment: str) -> TxResult:
    """Anyone holding the fulfillment can finish; autofill sets the higher conditional fee."""
    tx = EscrowFinish(
        account=sender.address, owner=escrow.owner, offer_sequence=escrow.offer_sequence,
        condition=escrow.condition, fulfillment=fulfillment,
    )
    return submit_validated(client, sender, tx)


def cancel_escrow(client: WebsocketClient, sender: Wallet, escrow: EscrowRef) -> TxResult:
    """Anyone can cancel once a validated ledger has closed after CancelAfter."""
    tx = EscrowCancel(account=sender.address, owner=escrow.owner, offer_sequence=escrow.offer_sequence)
    return submit_validated(client, sender, tx)


def get_escrow(client: WebsocketClient, escrow: EscrowRef) -> dict[str, Any] | None:
    """The escrow's ledger object in the latest validated ledger, or None once it is finished or cancelled."""
    res = client.request(LedgerEntry(escrow=EscrowLocator(owner=escrow.owner, seq=escrow.offer_sequence), ledger_index="validated"))
    if res.is_successful():
        return res.result["node"]
    if res.result.get("error") == "entryNotFound":
        return None
    raise RuntimeError(f"ledger_entry failed: {res.result.get('error')}")


def wait_past_cancel_after(client: WebsocketClient, escrow: EscrowRef) -> None:
    """Ledger close time lags real time, so wait for a validated ledger that closed after CancelAfter."""
    while True:
        ledger = client.request(Ledger(ledger_index="validated")).result["ledger"]
        if int(ledger["close_time"]) > escrow.cancel_after:
            return
        time.sleep(2)
