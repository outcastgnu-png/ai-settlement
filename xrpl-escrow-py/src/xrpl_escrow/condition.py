"""PREIMAGE-SHA-256 crypto-conditions, the condition type XRPL escrows accept.

The DER encoding for a 32-byte secret is fixed, so it is written out by hand,
exactly as the TypeScript kit does:

    condition   = A0 25 | 80 20 <sha256(secret)> | 81 01 20
    fulfillment = A0 22 | 80 20 <secret>
"""
import hashlib
import secrets

SECRET_LENGTH = 32


def make_secret() -> bytes:
    return secrets.token_bytes(SECRET_LENGTH)


def _check_length(secret: bytes) -> None:
    if len(secret) != SECRET_LENGTH:
        raise ValueError(f"secret must be {SECRET_LENGTH} bytes")


def to_condition(secret: bytes) -> str:
    """Uppercase hex for EscrowCreate.Condition and EscrowFinish.Condition."""
    _check_length(secret)
    fingerprint = hashlib.sha256(secret).digest()
    return (bytes([0xA0, 0x25, 0x80, 0x20]) + fingerprint + bytes([0x81, 0x01, SECRET_LENGTH])).hex().upper()


def to_fulfillment(secret: bytes) -> str:
    """Uppercase hex for EscrowFinish.Fulfillment."""
    _check_length(secret)
    return (bytes([0xA0, 0x22, 0x80, 0x20]) + secret).hex().upper()


def condition_of_fulfillment(fulfillment: str) -> str:
    """The condition a PREIMAGE-SHA-256 fulfillment opens (raises if it is not one)."""
    raw = bytes.fromhex(fulfillment)
    if len(raw) != 4 + SECRET_LENGTH or raw[:4] != bytes([0xA0, 0x22, 0x80, 0x20]):
        raise ValueError("not a 32-byte PREIMAGE-SHA-256 fulfillment")
    return to_condition(raw[4:])
