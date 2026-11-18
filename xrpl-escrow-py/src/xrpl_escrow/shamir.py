"""Shamir secret sharing over GF(256), the same field and encoding as the
TypeScript kit's src/shamir.ts (EDR-015): GF(2^8) with the AES reduction
polynomial 0x11B, share x-coordinates 1..n in the order of the job's oracle
set, and a share written as hex of ``[x, y_0, ..., y_31]``. Checked against
test/vectors/shamir.json."""
import os
import re
from dataclasses import dataclass
from itertools import combinations
from typing import Callable, Iterable

MAX_SHARES = 255

_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x ^= ((_x << 1) ^ (0x11B if _x & 0x80 else 0)) & 0x1FF
    _x &= 0xFF
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def gf_div(a: int, b: int) -> int:
    if b == 0:
        raise ZeroDivisionError("division by zero in GF(256)")
    if a == 0:
        return 0
    return _EXP[_LOG[a] + 255 - _LOG[b]]


@dataclass(frozen=True)
class Share:
    x: int
    y: bytes


def _check_params(k: int, n: int) -> None:
    if k < 2:
        raise ValueError("threshold must be at least 2 (one share would be the secret)")
    if n < k:
        raise ValueError("share count must be at least the threshold")
    if n > MAX_SHARES:
        raise ValueError(f"at most {MAX_SHARES} shares")


def split(secret: bytes, k: int, n: int, random: Callable[[int], bytes] = os.urandom) -> list[Share]:
    """Split ``secret`` into ``n`` shares, any ``k`` of which rebuild it. The coefficients
    come from ``random``, read as k-1 bytes per secret byte, in order (as in TypeScript)."""
    _check_params(k, n)
    if not secret:
        raise ValueError("secret must not be empty")
    coeffs = random(len(secret) * (k - 1))
    if len(coeffs) != len(secret) * (k - 1):
        raise ValueError("random source returned the wrong number of bytes")
    shares = []
    for x in range(1, n + 1):
        y = bytearray(len(secret))
        for i, s in enumerate(secret):
            acc = 0
            for j in range(k - 2, -1, -1):
                acc = gf_mul(acc, x) ^ coeffs[i * (k - 1) + j]
            y[i] = gf_mul(acc, x) ^ s
        shares.append(Share(x, bytes(y)))
    return shares


def combine(shares: Iterable[Share]) -> bytes:
    """Rebuild the secret from every share given (Lagrange at x = 0). It can't tell a
    wrong share from a right one: check the result against the job's condition."""
    shares = list(shares)
    if len(shares) < 2:
        raise ValueError("need at least 2 shares")
    length = len(shares[0].y)
    seen: set[int] = set()
    for s in shares:
        if not 1 <= s.x <= MAX_SHARES:
            raise ValueError(f"share x must be 1..{MAX_SHARES}")
        if s.x in seen:
            raise ValueError(f"share {s.x} is given twice")
        seen.add(s.x)
        if len(s.y) != length or length == 0:
            raise ValueError("shares have different lengths")
    out = bytearray(length)
    for sj in shares:
        basis = 1
        for sm in shares:
            if sm.x != sj.x:
                basis = gf_mul(basis, gf_div(sm.x, sm.x ^ sj.x))
        for i in range(length):
            out[i] ^= gf_mul(basis, sj.y[i])
    return bytes(out)


def encode_share(share: Share) -> str:
    return (bytes([share.x]) + share.y).hex()


def decode_share(text: str, length: int = 32) -> Share:
    if not isinstance(text, str) or not re.fullmatch(f"[0-9a-f]{{{2 * (length + 1)}}}", text):
        raise ValueError(f"a share is {length + 1} bytes of lowercase hex")
    raw = bytes.fromhex(text)
    if raw[0] == 0:
        raise ValueError("share x must not be 0")
    return Share(raw[0], raw[1:])


def choose(items: list, k: int) -> list[tuple]:
    """Every way to pick ``k`` items, in the same order as the TypeScript ``choose``."""
    return list(combinations(items, k))
