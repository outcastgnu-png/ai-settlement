"""Signed job spec v1 (EDR-016), the same rules as the TypeScript kit's ``src/job-spec.ts``.

A job spec v1 states a job's acceptance criteria and the machine checks that decide
each one. The client writes it, the provider accepts it by signing its hash, the
client signs it too, and the hash goes on the ledger in a memo on the EscrowCreate.
Every oracle checks that memo before it verifies, and puts the hash in its signed
verdict and its log.

The spec hash is SHA-256 over the RFC 8785 (JCS) canonical form: keys sorted by
UTF-16 code unit, no spaces, strings escaped as ECMAScript does. A v1 spec holds
whole numbers only, so both SDKs format it byte for byte the same; both are checked
against ``test/vectors/job-spec.json``.

The kit judges the checks, never the words of a criterion. A subjective criterion
("useful research") is accepted only with at least one check both parties sign as
its stand-in. A spec is data: it is validated and hashed, never executed.
"""
import json
import os
import re
from typing import Any, Callable

from xrpl.core.addresscodec import is_valid_classic_address
from xrpl.core.keypairs import derive_classic_address, is_valid_message, sign
from xrpl.wallet import Wallet

from .auth import canonical_json, sha256_hex

SPEC_VERSION = 1
SPEC_MEMO_TYPE = "xrpl-escrow/job-spec"
SPEC_MEMO_FORMAT = "application/json"
SPEC_SIGN_PREFIX = "xrpl-escrow/job-spec"
MAX_CRITERIA = 8
MAX_SPEC_BYTES = 32_768
MAX_REVISION = 1000
MAX_CHECKS = 8
MAX_TX_CHECKS = 2
MAX_SIZE_BYTES = 10_000_000
MAX_CONTAINS_TEXT_BYTES = 256
CHECK_TYPES = ("sha256-match", "json-schema", "max-latency", "xrpl-tx-validated", "size-range", "contains-text")

_SPEC_KEYS = ("specVersion", "revision", "nonce", "title", "client", "provider", "priceDrops", "slaSeconds", "criteria", "rule")
_CRITERION_KEYS = ("id", "statement", "kind", "checks")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_NONCE = re.compile(r"^[0-9a-f]{32}$")
_DROPS = re.compile(r"^[1-9][0-9]{0,16}$")
_CRITERION_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_HEX_BYTES = re.compile(r"^(?:[0-9A-Fa-f]{2})*$")
_MEMO_DATA = re.compile(r"^(?:[0-9A-Fa-f]{2}){1,1024}$")

JobSpec = dict[str, Any]


def is_spec_v1(spec: Any) -> bool:
    """True for a job spec v1, as opposed to the Phase 1 to 5 ``{title?, checks}`` shape."""
    return isinstance(spec, dict) and "specVersion" in spec


def jcs(value: Any) -> str:
    """RFC 8785 canonical JSON. Raises ValueError on anything the two SDKs could encode differently
    (a float, an integer outside JavaScript's safe range, a lone surrogate)."""
    try:
        return canonical_json(value)
    except ValueError as err:
        if "integers" in str(err) or "float" in str(err):
            raise ValueError("a job spec holds whole numbers only") from None
        raise


def spec_hash(spec: JobSpec) -> str:
    """SHA-256 of the canonical form, lowercase hex."""
    return sha256_hex(jcs(spec))


def _hex_of(text: str) -> str:
    return text.encode("utf-8").hex().upper()


def _sign_message(digest: str) -> str:
    return _hex_of(f"{SPEC_SIGN_PREFIX}|v{SPEC_VERSION}|{digest}")


def sign_spec_hash(digest: str, wallet: Wallet) -> dict[str, str]:
    """Sign a spec hash with an XRPL wallet. The signer must have read the spec the hash is of."""
    if not _HEX64.match(digest):
        raise ValueError("a spec hash is 64 lowercase hex characters")
    return {"address": wallet.address, "publicKey": wallet.public_key, "signature": sign(_sign_message(digest), wallet.private_key)}


def verify_spec_signature(digest: str, sig: Any, address: str) -> bool:
    """True when ``sig`` is ``address``'s signature over ``digest``."""
    if not isinstance(sig, dict) or not isinstance(sig.get("publicKey"), str) or not isinstance(sig.get("signature"), str):
        return False
    if sig.get("address") != address or not isinstance(digest, str) or not _HEX64.match(digest):
        return False
    try:
        return derive_classic_address(sig["publicKey"]) == address and is_valid_message(
            bytes.fromhex(_sign_message(digest)), bytes.fromhex(sig["signature"]), sig["publicKey"])
    except Exception:  # noqa: BLE001 - malformed input is simply not valid
        return False


def agreement_problems(spec: JobSpec, sigs: dict[str, Any] | None) -> list[str]:
    """Both parties' signatures over the spec's hash must check before any XRP is locked. Returns the problems."""
    sigs = sigs or {}
    digest = spec_hash(spec)
    problems = []
    if not verify_spec_signature(digest, sigs.get("client"), spec["client"]):
        problems.append(f"the client ({spec['client']}) has not signed spec {digest}")
    if not verify_spec_signature(digest, sigs.get("provider"), spec["provider"]):
        problems.append(f"the provider ({spec['provider']}) has not signed spec {digest}")
    return problems


def _whole(v: Any, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _utf8_len(text: str) -> int:
    return len(text.encode("utf-8", errors="surrogatepass"))


def check_problem(c: Any) -> str | None:
    """What is wrong with one check, or None. The full JSON Schema policy is the registry's
    (``src/schema-policy.ts``); here a json-schema check needs a schema object."""
    if not isinstance(c, dict) or c.get("type") not in CHECK_TYPES:
        return f"a check must be one of: {', '.join(CHECK_TYPES)}"
    t = c["type"]
    if t == "sha256-match":
        ok = isinstance(c.get("sha256"), str) and re.fullmatch(r"[0-9a-fA-F]{64}", c["sha256"]) is not None
        return None if ok else "sha256-match needs sha256, 64 hex characters"
    if t == "json-schema":
        return None if isinstance(c.get("schema"), dict) else "json-schema needs a schema object"
    if t == "xrpl-tx-validated":
        keys = {"type", "txType", "destination", "minDrops", "account", "destinationTag", "memo"}
        ok = (set(c) <= keys and c.get("txType") in ("Payment", "EscrowCreate") and isinstance(c.get("destination"), str)
              and is_valid_classic_address(c["destination"]) and isinstance(c.get("minDrops"), str) and _DROPS.match(c["minDrops"]) is not None)
        return None if ok else "xrpl-tx-validated has a missing or malformed field"
    if t == "size-range":
        if set(c) - {"type", "minBytes", "maxBytes"}:
            return "size-range takes only minBytes and maxBytes"
        if not _whole(c.get("minBytes"), 0, MAX_SIZE_BYTES) or not _whole(c.get("maxBytes"), 1, MAX_SIZE_BYTES) or c["minBytes"] > c["maxBytes"]:
            return f"size-range needs whole numbers 0 <= minBytes <= maxBytes <= {MAX_SIZE_BYTES}"
        return None
    if t == "contains-text":
        if set(c) - {"type", "text"}:
            return "contains-text takes only text"
        text = c.get("text")
        if not isinstance(text, str) or not text or _utf8_len(text) > MAX_CONTAINS_TEXT_BYTES:
            return f"contains-text needs text of 1 to {MAX_CONTAINS_TEXT_BYTES} bytes (literal, case-sensitive, no regex)"
        return None
    max_ms = c.get("maxMs")  # max-latency
    return None if isinstance(max_ms, (int, float)) and not isinstance(max_ms, bool) and max_ms > 0 else "max-latency needs maxMs above 0"


def spec_problem(spec: Any) -> str | None:
    """What is wrong with a job spec v1, or None if it is acceptable. Same rules as the TypeScript kit."""
    if not isinstance(spec, dict):
        return "the job spec must be a JSON object"
    if spec.get("specVersion") != SPEC_VERSION or isinstance(spec.get("specVersion"), bool):
        return f"specVersion must be {SPEC_VERSION}"
    extra = [k for k in spec if k not in _SPEC_KEYS]
    if extra:
        return f"the job spec has unknown fields: {', '.join(extra)}"
    missing = [k for k in _SPEC_KEYS if k not in spec]
    if missing:
        return f"the job spec is missing: {', '.join(missing)}"
    if not _whole(spec["revision"], 1, MAX_REVISION):
        return f"revision must be a whole number from 1 to {MAX_REVISION}"
    if not isinstance(spec["nonce"], str) or not _NONCE.match(spec["nonce"]):
        return "nonce must be 32 lowercase hex characters"
    if not isinstance(spec["title"], str) or not 1 <= _js_len(spec["title"]) <= 200:
        return "title must be 1 to 200 characters"
    for role in ("client", "provider"):
        if not isinstance(spec[role], str) or not is_valid_classic_address(spec[role]):
            return f"{role} must be an XRPL address"
    if spec["client"] == spec["provider"]:
        return "client and provider must differ"
    if not isinstance(spec["priceDrops"], str) or not _DROPS.match(spec["priceDrops"]):
        return "priceDrops must be a positive drop string"
    if not _whole(spec["slaSeconds"], 30, 86_400):
        return "slaSeconds must be an integer from 30 to 86400"
    criteria = spec["criteria"]
    if not isinstance(criteria, list) or not 1 <= len(criteria) <= MAX_CRITERIA:
        return f"criteria must list 1 to {MAX_CRITERIA} criteria"
    ids: set[str] = set()
    all_checks: list[Any] = []
    for i, c in enumerate(criteria):
        at = f"criterion {i + 1}"
        if not isinstance(c, dict):
            return f"{at} must be an object"
        if any(k not in _CRITERION_KEYS for k in c):
            return f"{at} may hold only {', '.join(_CRITERION_KEYS)}"
        cid = c.get("id")
        if not isinstance(cid, str) or not _CRITERION_ID.match(cid):
            return f"{at}: id must be 1 to 32 of a-z, 0-9 and -, starting with a letter or digit"
        if cid in ids:
            return f"{at}: id {cid} is used twice"
        ids.add(cid)
        statement = c.get("statement")
        if not isinstance(statement, str) or not statement.strip() or _js_len(statement) > 500:
            return f"{at} ({cid}): statement must be 1 to 500 characters"
        if c.get("kind") not in ("objective", "subjective"):
            return f"{at} ({cid}): kind must be objective or subjective"
        checks = c.get("checks")
        if not isinstance(checks, list):
            return f"{at} ({cid}): checks must be a list"
        if not checks:
            if c["kind"] == "subjective":
                return (f'criterion {cid} is subjective ("{statement}") and names no check. This kit can\'t judge that statement: '
                        "add at least one check that both parties accept as its stand-in (a json-schema with required sections, "
                        "a size-range, contains-text, or a source transaction), or leave the criterion out")
            return f"criterion {cid} is objective but names no check; add the check that decides it"
        for check in checks:
            p = check_problem(check)
            if p:
                return f"{at} ({cid}): {p}"
        all_checks.extend(checks)
    if len(all_checks) > MAX_CHECKS:
        return f"the criteria together may hold at most {MAX_CHECKS} checks"
    if sum(1 for c in all_checks if c.get("type") == "xrpl-tx-validated") > MAX_TX_CHECKS:
        return f"the criteria together may hold at most {MAX_TX_CHECKS} xrpl-tx-validated checks"
    rule = spec["rule"]
    if rule != "all":
        if not isinstance(rule, dict) or list(rule) != ["atLeast"] or not _whole(rule["atLeast"], 1, len(criteria)):
            return f'rule must be "all" or {{"atLeast": n}} with n from 1 to the number of criteria ({len(criteria)})'
    try:
        text = jcs(spec)
    except ValueError as err:
        return str(err)
    if len(text.encode("utf-8")) > MAX_SPEC_BYTES:
        return f"the job spec is larger than {MAX_SPEC_BYTES} bytes"
    return None


def _js_len(text: str) -> int:
    """String length as JavaScript counts it (UTF-16 code units), so limits agree with the TypeScript kit."""
    return len(text.encode("utf-16-le", errors="surrogatepass")) // 2


def make_job_spec(*, title: str, client: str, provider: str, price_drops: str, sla_seconds: int,
                  criteria: list[dict[str, Any]], rule: Any = "all") -> JobSpec:
    """A new spec at revision 1 with a fresh nonce. Raises ValueError with the reason if it is not acceptable."""
    spec = {"specVersion": 1, "revision": 1, "nonce": os.urandom(16).hex(), "title": title, "client": client, "provider": provider,
            "priceDrops": price_drops, "slaSeconds": sla_seconds, "criteria": criteria, "rule": rule}
    problem = spec_problem(spec)
    if problem:
        raise ValueError(problem)
    return spec


def revise_job_spec(spec: JobSpec, **changes: Any) -> JobSpec:
    """The next revision of a spec. Client, provider and nonce stay; the old signatures don't carry over.
    ``price_drops`` and ``sla_seconds`` may be given in Python style."""
    aliases = {"price_drops": "priceDrops", "sla_seconds": "slaSeconds"}
    changes = {aliases.get(k, k): v for k, v in changes.items()}
    for fixed in ("specVersion", "revision", "nonce", "client", "provider"):
        if fixed in changes:
            raise ValueError(f"a revision keeps {fixed}")
    nxt = {**spec, **changes, "revision": spec["revision"] + 1}
    problem = spec_problem(nxt)
    if problem:
        raise ValueError(problem)
    return nxt


def meets_rule(rule: Any, results: list[dict[str, Any]]) -> bool:
    """Whether criterion results meet the spec's rule ("all", or {"atLeast": n})."""
    passed = sum(1 for r in results if r.get("pass") is True)
    if rule == "all":
        return bool(results) and passed == len(results)
    return passed >= rule["atLeast"]


def spec_memos(spec: JobSpec) -> list[dict[str, Any]]:
    """The Memos field of the EscrowCreate for this spec: one memo with its hash and version, as hex."""
    memo = {"specHash": spec_hash(spec), "specVersion": spec["specVersion"], "revision": spec["revision"]}
    return [{"Memo": {"MemoType": _hex_of(SPEC_MEMO_TYPE), "MemoFormat": _hex_of(SPEC_MEMO_FORMAT), "MemoData": _hex_of(jcs(memo))}}]


def parse_spec_memo(memos: Any) -> dict[str, Any] | None:
    """The spec memo in a transaction's Memos, None when there is none, or ``{"problem": ...}``.
    Ledger data is data: only the exact memo type is read, its MemoFormat must be application/json,
    its JSON must have exactly the expected fields and be byte for byte the canonical (RFC 8785) form
    that ``spec_memos()`` writes (so duplicate keys, spacing or another key order are refused), and
    more than one spec memo is refused. Memos of other types beside it are ignored."""
    if memos is None:
        return None
    if not isinstance(memos, list):
        return {"problem": "Memos is not a list"}
    found = []
    for wrapper in memos:
        memo = wrapper.get("Memo") if isinstance(wrapper, dict) else None
        if not isinstance(memo, dict) or not isinstance(memo.get("MemoType"), str):
            continue
        mt = memo["MemoType"]
        if not _HEX_BYTES.match(mt) or bytes.fromhex(mt).decode("utf-8", errors="replace") != SPEC_MEMO_TYPE:
            continue
        fmt = memo.get("MemoFormat")
        if (not isinstance(fmt, str) or not fmt or not _HEX_BYTES.match(fmt)
                or bytes.fromhex(fmt).decode("utf-8", errors="replace") != SPEC_MEMO_FORMAT):
            return {"problem": f"the spec memo's format is not {SPEC_MEMO_FORMAT}"}
        data = memo.get("MemoData")
        if not isinstance(data, str) or not _MEMO_DATA.match(data):
            return {"problem": "the spec memo's data is not hex"}
        try:
            text = bytes.fromhex(data).decode("utf-8")
            d = json.loads(text)
        except ValueError:
            return {"problem": "the spec memo's data is not JSON"}
        if not isinstance(d, dict) or sorted(d) != ["revision", "specHash", "specVersion"]:
            return {"problem": "the spec memo has the wrong fields"}
        if (not isinstance(d["specHash"], str) or not _HEX64.match(d["specHash"]) or d["specVersion"] != SPEC_VERSION
                or isinstance(d["specVersion"], bool) or not _whole(d["revision"], 1, 2**53 - 1)):
            return {"problem": "the spec memo has a malformed field"}
        parsed = {"specHash": d["specHash"], "specVersion": d["specVersion"], "revision": d["revision"]}
        if jcs(parsed) != text:
            return {"problem": "the spec memo's data is not canonical JSON (RFC 8785): duplicate keys, spacing or key order"}
        found.append(parsed)
    if len(found) > 1:
        return {"problem": "the EscrowCreate carries more than one spec memo"}
    return found[0] if found else None


TxLookup = Callable[[str], dict[str, Any]]
"""Looks a transaction up by hash: ``{"found": bool, "validated": bool, "tx": {...}, "meta": {...}}``."""


def escrow_create_spec_memo(lookup_tx: TxLookup, tx_hash: str | None, *, owner: str, destination: str, condition: str,
                            offer_sequence: int | None = None, amount: str | None = None) -> dict[str, Any]:
    """Read the spec memo of the EscrowCreate ``tx_hash`` after checking, in a validated ledger, that it is the
    job's EscrowCreate (from the client, to the provider, with the condition) and succeeded.
    Returns ``{"memo": ...}`` or ``{"problem": ...}``."""
    if not isinstance(tx_hash, str) or not re.fullmatch(r"[0-9A-Fa-f]{64}", tx_hash):
        return {"problem": "no EscrowCreate transaction hash for the job"}
    found = lookup_tx(tx_hash)
    if not found.get("found"):
        return {"problem": f"EscrowCreate {tx_hash} is not on the ledger"}
    if not found.get("validated"):
        return {"problem": f"EscrowCreate {tx_hash} is not in a validated ledger"}
    tx, meta = found.get("tx") or {}, found.get("meta") or {}
    if meta.get("TransactionResult") != "tesSUCCESS":
        return {"problem": f"transaction {tx_hash} did not succeed"}
    if tx.get("TransactionType") != "EscrowCreate":
        return {"problem": f"transaction {tx_hash} is a {tx.get('TransactionType')}, not an EscrowCreate"}
    if tx.get("Account") != owner:
        return {"problem": "the EscrowCreate was not sent by the job's client"}
    if tx.get("Destination") != destination:
        return {"problem": "the EscrowCreate does not pay the job's provider"}
    if tx.get("Condition") != condition:
        return {"problem": "the EscrowCreate does not carry the job's condition"}
    if offer_sequence is not None and tx.get("Sequence") != offer_sequence:
        return {"problem": "the EscrowCreate's sequence is not the job's escrow sequence"}
    if amount is not None and tx.get("Amount") != amount:
        return {"problem": "the EscrowCreate's amount is not the job's price"}
    memo = parse_spec_memo(tx.get("Memos"))
    if memo is None:
        return {"problem": "the EscrowCreate carries no job spec memo"}
    if "problem" in memo:
        return memo
    return {"memo": memo}


def ledger_tx_lookup(client: Any) -> TxLookup:
    """A TxLookup on an xrpl-py client. Only a validated answer counts."""
    from xrpl.models.requests import Tx

    def lookup(tx_hash: str) -> dict[str, Any]:
        res = client.request(Tx(transaction=tx_hash))
        if not res.is_successful():
            return {"found": False}
        r = res.result
        tx = r.get("tx_json") or r
        return {"found": True, "validated": r.get("validated") is True, "tx": tx, "meta": r.get("meta")}

    return lookup
