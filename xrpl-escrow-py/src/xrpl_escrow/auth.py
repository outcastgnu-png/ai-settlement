"""Signed requests and signed verdicts, in the same format as the TypeScript kit.

A provider proves who it is by signing ``<action>|<jobId>|<timestamp>|<payloadHash>``
(UTF-8, as hex) with its wallet key. The oracle signs its verdicts over
canonical JSON (sorted keys, no spaces) with its own ed25519 verdict key.
"""
import hashlib
import json
import time
from typing import Any

from xrpl.core.keypairs import derive_classic_address, is_valid_message, sign
from xrpl.wallet import Wallet


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _hex_of(text: str) -> str:
    return text.encode("utf-8").hex().upper()


def request_message(action: str, job_id: str, timestamp: int, payload_hash: str) -> str:
    return _hex_of(f"{action}|{job_id}|{timestamp}|{payload_hash}")


def sign_request(wallet: Wallet, action: str, job_id: str, payload_hash: str = "", timestamp: int | None = None) -> dict[str, Any]:
    """The ``auth`` object the registry and the oracle expect: {publicKey, timestamp, signature}."""
    ts = int(time.time() * 1000) if timestamp is None else timestamp
    return {
        "publicKey": wallet.public_key,
        "timestamp": ts,
        "signature": sign(request_message(action, job_id, ts, payload_hash), wallet.private_key),
    }


def replay_key(public_key: str, action: str, job_id: str, timestamp: int, payload_hash: str) -> str:
    """What the oracle remembers a signed request by: the signer and the exact message signed."""
    return sha256_hex(f"{public_key.upper()}|{request_message(action, job_id, timestamp, payload_hash)}")


_MAX_SAFE_INTEGER = 2**53 - 1


def canonical_json(value: Any) -> str:
    """JSON with sorted keys and no spaces, byte for byte what the TypeScript kit signs.

    Only the value types a verdict contains are supported: objects, lists, strings,
    integers within JavaScript's safe range, booleans and null. Anything else (a float,
    NaN, a huge integer, a lone surrogate) raises ValueError rather than risk encoding
    it differently from JavaScript. Keys sort by UTF-16 code unit, as JavaScript sorts them.
    """
    if isinstance(value, dict):
        for k in value:
            if not isinstance(k, str):
                raise ValueError("canonical_json keys must be strings")
        keys = sorted(value, key=lambda k: _utf16(k))
        return "{" + ",".join(f"{_string(k)}:{canonical_json(value[k])}" for k in keys) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, str):
        return _string(value)
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) > _MAX_SAFE_INTEGER:
            raise ValueError("canonical_json integers must be within JavaScript's safe range")
        return str(value)
    raise ValueError(f"canonical_json cannot encode {type(value).__name__}")


def _utf16(text: str) -> bytes:
    return text.encode("utf-16-be", errors="surrogatepass")


def _string(text: str) -> str:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("canonical_json strings must not hold lone surrogates") from None
    return json.dumps(text, ensure_ascii=False)


def sign_payload(payload: Any, wallet: Wallet) -> str:
    return sign(_hex_of(canonical_json(payload)), wallet.private_key)


def verify_payload(payload: Any, signature: str, public_key: str, address: str) -> bool:
    """True if ``signature`` over ``payload`` was made by the key behind ``public_key``, which must belong to ``address``."""
    try:
        if derive_classic_address(public_key) != address:
            return False
        return is_valid_message(bytes.fromhex(_hex_of(canonical_json(payload))), bytes.fromhex(signature), public_key)
    except Exception:  # noqa: BLE001 - any malformed input is simply not valid
        return False


def verify_verdict(verdict: dict[str, Any], oracle_address: str | None) -> bool:
    """Check a verdict's signature, and that it came from the pinned ``oracle_address``."""
    if not oracle_address or verdict.get("oracle") != oracle_address:
        return False
    unsigned = {k: v for k, v in verdict.items() if k != "signature"}
    return verify_payload(unsigned, str(verdict.get("signature", "")), str(verdict.get("publicKey", "")), oracle_address)
