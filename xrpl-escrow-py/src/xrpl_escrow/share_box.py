"""Sealing a secret share to one oracle, the same scheme as the TypeScript kit's
src/share-box.ts (EDR-015): a fresh ephemeral X25519 key, ECDH with the oracle's
share key, HKDF-SHA256 (salt = ephemeral public || oracle public, info = the
context string) to an AES-256-GCM key, and the context string as associated data.
The context binds a box to one job, one oracle and one share index. Checked
against test/vectors/share-box.json. Uses pycryptodome, which xrpl-py already needs."""
import os
import re
from dataclasses import dataclass
from typing import Any

from Crypto.Cipher import AES
from Crypto.Hash import SHA256
from Crypto.Protocol.DH import key_agreement
from Crypto.Protocol.KDF import HKDF
from Crypto.PublicKey import ECC

from .auth import verify_payload

BOX_VERSION = 1
_HEX32 = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class BoxContext:
    job_id: str
    oracle: str  # the oracle's verdict address
    index: int  # the share's x value, 1..n


def box_context(ctx: BoxContext) -> str:
    return f"xrpl-escrow/share/v1|{ctx.job_id}|{ctx.oracle}|{ctx.index}"


def _private(hex_key: str) -> ECC.EccKey:
    if not _HEX32.fullmatch(hex_key):
        raise ValueError("an X25519 private key is 32 bytes of lowercase hex")
    return ECC.construct(curve="Curve25519", seed=bytes.fromhex(hex_key))


def _public(hex_key: str) -> ECC.EccKey:
    if not _HEX32.fullmatch(hex_key):
        raise ValueError("an X25519 public key is 32 bytes of lowercase hex")
    return ECC.construct(curve="Curve25519", point_x=int.from_bytes(bytes.fromhex(hex_key), "little"))


def _public_hex(key: ECC.EccKey) -> str:
    return key.public_key().export_key(format="raw").hex()


def share_key_public(private_hex: str) -> str:
    """The public share key for a private one (as ORACLE_SHARE_KEY holds it)."""
    return _public_hex(_private(private_hex))


def _aes_key(priv: ECC.EccKey, pub: ECC.EccKey, epk: str, rpk: str, info: str) -> bytes:
    shared = key_agreement(static_priv=priv, static_pub=pub, kdf=lambda z: z)
    return HKDF(shared, 32, bytes.fromhex(epk + rpk), SHA256, context=info.encode())


def seal(share: bytes, recipient: str, ctx: BoxContext, *, ephemeral: str | None = None, iv: str | None = None) -> dict[str, Any]:
    """Seal ``share`` to the oracle whose public share key is ``recipient``. Tests pass a fixed
    ``ephemeral`` private key and ``iv`` for vectors; never do that otherwise."""
    eph = _private(ephemeral) if ephemeral else ECC.generate(curve="Curve25519")
    epk = _public_hex(eph)
    info = box_context(ctx)
    key = _aes_key(eph, _public(recipient), epk, recipient, info)
    nonce = bytes.fromhex(iv) if iv else os.urandom(12)
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    cipher.update(info.encode())
    ct, tag = cipher.encrypt_and_digest(share)
    return {"v": BOX_VERSION, "epk": epk, "iv": nonce.hex(), "ct": ct.hex(), "tag": tag.hex()}


def open_box(box: dict[str, Any], private_key: str, ctx: BoxContext) -> bytes:
    """Open a box with an oracle's private share key (the oracle does this; here for tests)."""
    if not isinstance(box, dict) or box.get("v") != BOX_VERSION:
        raise ValueError("not a share box")
    priv = _private(private_key)
    info = box_context(ctx)
    key = _aes_key(priv, _public(box["epk"]), box["epk"], _public_hex(priv), info)
    cipher = AES.new(key, AES.MODE_GCM, nonce=bytes.fromhex(box["iv"]))
    cipher.update(info.encode())
    try:
        return cipher.decrypt_and_verify(bytes.fromhex(box["ct"]), bytes.fromhex(box["tag"]))
    except ValueError as err:
        raise ValueError("the share box does not open with this oracle's key for this job and index") from err


def verify_share_key(oracle: str, public_key: str, share_key: str, signature: str) -> bool:
    """True when ``share_key`` is vouched for by the verdict key behind ``public_key``, which must belong to ``oracle``."""
    if not isinstance(share_key, str) or not _HEX32.fullmatch(share_key) or not isinstance(signature, str):
        return False
    body = {"purpose": "xrpl-escrow/share-key", "oracle": oracle, "shareKey": share_key}
    return verify_payload(body, signature, public_key, oracle)
