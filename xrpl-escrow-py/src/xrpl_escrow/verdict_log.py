"""Check the oracle's public verdict log (EDR-014), the same rules as the TypeScript kit's
``src/verdict-log.ts``.

Each log entry has a sequence number, the hash of the entry before it, and a
signature by the oracle's verdict key, so an edited, removed or reordered entry
breaks the chain. The oracle puts the log's head (sequence number and hash) in
a memo on an AccountSet from its anchor account; :func:`latest_anchor` reads
that from a validated ledger, so a log copy can be compared with the ledger
without trusting the oracle. Entries hold hashes and outcomes only: no check
details, deliverables or secrets. Ledger data is data: only an exact anchor
memo with exactly the expected fields is read.
"""
import json
import re
from dataclasses import dataclass, field
from typing import Any

from xrpl.clients import WebsocketClient
from xrpl.models.requests import AccountTx

from .auth import canonical_json, sha256_hex, verify_payload

LOG_VERSION = 1
GENESIS_PREV = "0" * 64
ANCHOR_MEMO_TYPE = "xrpl-escrow/verdict-log-head"

_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_HEX = re.compile(r"^[0-9A-Fa-f]*$")
_MEMO_DATA = re.compile(r"^[0-9A-Fa-f]{2,2048}$")

Entry = dict[str, Any]


def entry_hash(entry: Entry) -> str:
    """sha256 of the entry's canonical JSON, signature included and ``hash`` left out."""
    return sha256_hex(canonical_json({k: v for k, v in entry.items() if k != "hash"}))


def verdict_hash(verdict: dict[str, Any]) -> str:
    """sha256 of the canonical JSON of a full signed verdict, as its log entry records it."""
    return sha256_hex(canonical_json(verdict))


@dataclass
class ChainCheck:
    ok: bool
    problem: str | None
    head: dict[str, Any] | None
    count: int


def check_chain(entries: list[Any], oracle_address: str | None) -> ChainCheck:
    """Check a whole log from its genesis entry: sequence numbers count up from 0, each entry
    names the hash of the one before, each hash is right, and every entry is signed by the
    pinned ``oracle_address``. Stops at the first problem."""
    n = len(entries)

    def fail(problem: str, i: int) -> ChainCheck:
        return ChainCheck(False, f"entry {i}: {problem}", None, n)

    if not oracle_address:
        return ChainCheck(False, "no pinned oracle address", None, n)
    if n == 0:
        return ChainCheck(False, "the log is empty", None, 0)
    prev = GENESIS_PREV
    for i, e in enumerate(entries):
        if not isinstance(e, dict):
            return fail("not an object", i)
        if e.get("v") != LOG_VERSION or isinstance(e.get("v"), bool):
            return fail(f"unknown log version {e.get('v')}", i)
        if e.get("seq") != i or isinstance(e.get("seq"), bool):
            return fail(f"sequence number is {e.get('seq')}, expected {i}", i)
        if e.get("prev") != prev:
            return fail("does not link to the entry before it", i)
        if e.get("kind") != ("genesis" if i == 0 else "verdict"):
            return fail(f"kind {e.get('kind')} is not allowed here", i)
        if e.get("oracle") != oracle_address:
            return fail(f"signed by {e.get('oracle')}, not the pinned oracle {oracle_address}", i)
        signature, public_key = e.get("signature"), e.get("publicKey")
        if not isinstance(signature, str) or not isinstance(public_key, str):
            return fail("has no signature", i)
        body = {k: v for k, v in e.items() if k not in ("hash", "signature")}
        try:
            if not verify_payload(body, signature, public_key, oracle_address):
                return fail("signature does not verify", i)
            expected = entry_hash(e)
        except ValueError:
            return fail("holds a value that canonical JSON can't encode", i)
        if e.get("hash") != expected:
            return fail("hash does not match its content", i)
        prev = e["hash"]
    return ChainCheck(True, None, {"seq": n - 1, "hash": prev}, n)


def anchor_problem(entries: list[Any], anchor: dict[str, Any], oracle_address: str) -> str | None:
    """None when the log holds the anchored entry with exactly the anchored hash, otherwise what is wrong."""
    if anchor.get("oracle") != oracle_address:
        return f"the anchor names oracle {anchor.get('oracle')}, not the pinned {oracle_address}"
    seq = anchor["seq"]
    if seq >= len(entries):
        return f"the anchor covers entry {seq}, but the log has only {len(entries)} entries"
    entry = entries[seq] if seq >= 0 else None
    if not isinstance(entry, dict):  # a problem, not a crash (Gpno N27)
        return f"entry {seq} is missing or not an object"
    if entry.get("hash") != anchor["hash"]:
        return f"entry {seq} has hash {entry.get('hash')}, the ledger anchored {anchor['hash']}"
    return None


def anchor_history_problems(entries: list[Any], anchors: list[dict[str, Any]], oracle_address: str) -> list[str]:
    """Every anchor on the ledger must agree with the log, and only one genesis may be anchored (Gpno N29)."""
    problems: list[str] = []
    geneses = {a["hash"] for a in anchors if a.get("oracle") == oracle_address and a.get("seq") == 0}
    if len(geneses) > 1:
        problems.append(f"the ledger has {len(geneses)} different genesis entries anchored for this oracle: "
                        "it has published more than one log")
    for a in anchors:
        p = anchor_problem(entries, a, oracle_address)
        if p and p not in problems:
            problems.append(p)
    return problems


def entry_mismatch(entry: Entry, verdict: dict[str, Any]) -> str | None:
    """The first public field of a log entry that disagrees with the signed verdict it names (Gpno N26)."""
    if entry.get("kind") != "verdict":
        return "not a verdict entry"
    if entry.get("verdictHash") != verdict_hash(verdict):
        return "verdictHash"
    checks = [{"type": c.get("type"), "pass": c.get("pass")} for c in verdict.get("checks", [])]
    for name in ("jobId", "verdict", "evidenceHash", "condition", "provider", "issuedAt"):
        if entry.get(name) != verdict.get(name) or type(entry.get(name)) is not type(verdict.get(name)):
            return name
    try:
        if canonical_json(entry.get("checks")) != canonical_json(checks):
            return "checks"
    except ValueError:
        return "checks"
    return None


def find_verdict(entries: list[Entry], verdict: dict[str, Any]) -> tuple[Entry | None, str | None]:
    """(entry, None) when the log has this verdict with every public field matching; (None, why) when an entry
    names its hash but says something else; (None, None) when it is not there."""
    want = verdict_hash(verdict)
    for e in entries:
        if isinstance(e, dict) and e.get("kind") == "verdict" and e.get("verdictHash") == want:
            mismatch = entry_mismatch(e, verdict)
            if mismatch:
                return None, f"entry {e.get('seq')} names this verdict but its {mismatch} differs from it"
            return e, None
    return None, None


def verdict_in_log(entries: list[Entry], verdict: dict[str, Any]) -> Entry | None:
    """The log entry for this signed verdict, only if every public field matches it."""
    return find_verdict(entries, verdict)[0]


def _text_of_hex(value: str) -> str:
    return bytes.fromhex(value).decode("utf-8", errors="replace")


def parse_anchor_memo(memos: Any) -> dict[str, Any] | None:
    """The anchor memo in a transaction's Memos, or None if it has none or it is malformed."""
    if not isinstance(memos, list):
        return None
    for wrapper in memos:
        memo = wrapper.get("Memo") if isinstance(wrapper, dict) else None
        if not isinstance(memo, dict):
            continue
        memo_type, memo_data = memo.get("MemoType"), memo.get("MemoData")
        if not isinstance(memo_type, str) or not isinstance(memo_data, str):
            continue
        if not _HEX.match(memo_type) or len(memo_type) % 2 or _text_of_hex(memo_type) != ANCHOR_MEMO_TYPE:
            continue
        if not _MEMO_DATA.match(memo_data) or len(memo_data) % 2:
            return None
        try:
            data = json.loads(_text_of_hex(memo_data))
        except ValueError:
            return None
        if not isinstance(data, dict) or sorted(data) != ["hash", "oracle", "seq", "v"]:
            return None
        seq = data["seq"]
        if data["v"] != LOG_VERSION or isinstance(data["v"], bool) or not isinstance(seq, int) or isinstance(seq, bool):
            return None
        if seq < 0 or seq > 2**53 - 1 or not isinstance(data["hash"], str) or not _HEX64.match(data["hash"]):
            return None
        if not isinstance(data["oracle"], str):
            return None
        return {"v": data["v"], "seq": seq, "hash": data["hash"], "oracle": data["oracle"]}
    return None


def anchor_from_account_tx(t: dict[str, Any], anchor_address: str, oracle_address: str) -> dict[str, Any] | None:
    """The anchor in one ``account_tx`` row, if it is a validated, successful AccountSet from the anchor account."""
    tx = t.get("tx_json") or t.get("tx")
    meta = t.get("meta")
    if t.get("validated") is not True or not isinstance(tx, dict) or not isinstance(meta, dict):
        return None
    if meta.get("TransactionResult") != "tesSUCCESS":
        return None
    if tx.get("TransactionType") != "AccountSet" or tx.get("Account") != anchor_address:
        return None
    memo = parse_anchor_memo(tx.get("Memos"))
    if memo is None or memo["oracle"] != oracle_address:
        return None
    return {**memo, "txHash": str(t.get("hash") or tx.get("hash")),
            "ledgerIndex": int(t.get("ledger_index") or tx.get("ledger_index") or 0), "account": anchor_address}


def list_anchors(
    client: WebsocketClient, anchor_address: str, oracle_address: str, max_tx: int = 400,
) -> tuple[list[dict[str, Any]], bool]:
    """Every anchor for ``oracle_address`` among the anchor account's latest ``max_tx`` transactions, newest
    first, read from validated ledgers. The flag is False when older transactions were not read."""
    anchors: list[dict[str, Any]] = []
    marker = None
    seen = 0
    while True:
        res = client.request(AccountTx(account=anchor_address, ledger_index_min=-1, ledger_index_max=-1,
                                       limit=100, forward=False, marker=marker))
        if not res.is_successful():
            raise RuntimeError(f"account_tx failed: {res.result.get('error')}")
        for t in res.result.get("transactions", []):
            seen += 1
            anchor = anchor_from_account_tx(t, anchor_address, oracle_address)
            if anchor is not None:
                anchors.append(anchor)
        marker = res.result.get("marker")
        if not marker or seen >= max_tx:
            return anchors, not marker


def latest_anchor(client: WebsocketClient, anchor_address: str, oracle_address: str, max_tx: int = 400) -> dict[str, Any] | None:
    """The newest anchor of ``oracle_address``'s log, read from validated ledgers."""
    anchors, _ = list_anchors(client, anchor_address, oracle_address, max_tx)
    return anchors[0] if anchors else None


@dataclass
class LogVerification:
    """``ok`` is True when the chain and every signature check, every anchor found on the ledger agrees
    with the log (one genesis only), and (if a verdict was given) that verdict is in the log with matching
    fields and at or before the newest anchor. ``unanchored`` counts entries written after the newest
    anchor: checked for chain and signature, not yet pinned on the ledger."""

    ok: bool
    problems: list[str] = field(default_factory=list)
    count: int = 0
    head: dict[str, Any] | None = None
    anchor: dict[str, Any] | None = None
    unanchored: int | None = None
    anchors: list[dict[str, Any]] = field(default_factory=list)
    lookback_complete: bool = True
    verdict_entry: Entry | None = None
    verdict_anchored: bool | None = None


def verify_verdict_log(
    entries: list[Entry],
    oracle_address: str | None,
    anchors: list[dict[str, Any]] | dict[str, Any] | None,
    *,
    anchor_address: str | None = None,
    verdict: dict[str, Any] | None = None,
    require_anchor: bool = True,
    allow_unanchored: bool = False,
    lookback_complete: bool = True,
) -> LogVerification:
    """Check a fetched log against the pinned oracle address and the anchors read from the ledger
    (newest first; a single anchor dict or None is accepted too)."""
    if anchors is None:
        anchors = []
    elif isinstance(anchors, dict):
        anchors = [anchors]
    problems: list[str] = []
    if not oracle_address:
        problems.append("no pinned oracle address (ORACLE_VERDICT_ADDRESS)")
    chain = check_chain(entries, oracle_address)
    if oracle_address and not chain.ok:
        problems.append(str(chain.problem))
    if not anchor_address:
        problems.append("no pinned anchor account (ORACLE_ANCHOR_ADDRESS)")
    elif oracle_address:
        problems.extend(anchor_history_problems(entries, anchors, oracle_address))
        if not anchors and require_anchor:
            problems.append(f"no anchor from {anchor_address} found on a validated ledger")
    anchor = anchors[0] if anchors else None
    result = LogVerification(False, problems, len(entries), chain.head, anchor,
                             len(entries) - 1 - anchor["seq"] if anchor else None, list(anchors), lookback_complete)
    if verdict is not None:
        entry, mismatch = find_verdict(entries, verdict)
        result.verdict_entry = entry
        result.verdict_anchored = bool(entry and anchor and entry["seq"] <= anchor["seq"])
        if mismatch:
            problems.append(mismatch)
        elif entry is None:
            problems.append(f"verdict for job {verdict.get('jobId')} is not in the log")
        elif not result.verdict_anchored and not allow_unanchored:
            problems.append(f"verdict for job {verdict.get('jobId')} is entry {entry['seq']}, after the newest anchor; "
                            "it is not pinned on the ledger yet")
    result.ok = not problems
    return result
