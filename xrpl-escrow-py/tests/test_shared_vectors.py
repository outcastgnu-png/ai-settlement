"""Shamir splits and share boxes give the same bytes as the TypeScript kit (EDR-015)."""
import json
import os

import pytest
from xrpl.wallet import Wallet

from conftest import TS_KIT
from xrpl_escrow import combine_for_condition, to_condition, to_fulfillment
from xrpl_escrow.shamir import choose, combine, decode_share, encode_share, gf_div, gf_mul, split
from xrpl_escrow.share_box import BoxContext, open_box, seal, share_key_public

SHAMIR = json.loads((TS_KIT / "test" / "vectors" / "shamir.json").read_text(encoding="utf-8"))
BOXES = json.loads((TS_KIT / "test" / "vectors" / "share-box.json").read_text(encoding="utf-8"))


def test_field_inverses():
    for a in range(1, 256):
        assert gf_mul(a, gf_div(1, a)) == 1
    assert gf_mul(0x57, 0x83) == 0xC1


@pytest.mark.parametrize("case", SHAMIR["splits"], ids=lambda c: f"{c['k']}-of-{c['n']}")
def test_shamir_vectors(case):
    coeffs = bytes.fromhex(case["coefficients"])
    shares = split(bytes.fromhex(case["secret"]), case["k"], case["n"], lambda n: coeffs)
    assert [encode_share(s) for s in shares] == case["shares"]
    for pick in choose(case["shares"], case["k"]):
        assert combine(decode_share(h) for h in pick).hex() == case["secret"]


def test_any_k_rebuild_and_fewer_do_not():
    secret = os.urandom(32)
    shares = split(secret, 3, 5)
    assert all(combine(p) == secret for p in choose(shares, 3))
    assert all(combine(p) != secret for p in choose(shares, 2))
    with pytest.raises(ValueError, match="twice"):
        combine([shares[0], shares[0]])


@pytest.mark.parametrize("case", BOXES["boxes"], ids=lambda c: f"index-{c['context']['index']}")
def test_share_box_vectors(case):
    assert share_key_public(case["recipientPrivate"]) == case["recipientPublic"]
    ctx = BoxContext(case["context"]["jobId"], case["context"]["oracle"], case["context"]["index"])
    box = seal(bytes.fromhex(case["share"]), case["recipientPublic"], ctx, ephemeral=case["ephemeralPrivate"], iv=case["iv"])
    assert box == case["box"]
    assert open_box(case["box"], case["recipientPrivate"], ctx).hex() == case["share"]
    with pytest.raises(ValueError, match="does not open"):
        open_box(case["box"], case["recipientPrivate"], BoxContext(ctx.job_id, ctx.oracle, ctx.index + 1))


def test_combine_for_condition_uses_only_the_set():
    secret = os.urandom(32)
    shares = split(secret, 2, 3)
    oracle_set = [{"address": Wallet.create().address, "anchor": "r", "url": "u"} for _ in range(3)]
    own = [{"oracle": oracle_set[i]["address"], "share": encode_share(shares[i])} for i in range(3)]
    assert combine_for_condition(own[:1], oracle_set, 2, to_condition(secret)) is None
    assert combine_for_condition(own[1:], oracle_set, 2, to_condition(secret))[0] == to_fulfillment(secret)
    with pytest.raises(ValueError, match="not in the job's oracle set"):
        combine_for_condition([own[0], {"oracle": Wallet.create().address, "share": own[1]["share"]}], oracle_set, 2, to_condition(secret))
    with pytest.raises(ValueError, match="holds share 3"):
        combine_for_condition([own[0], {"oracle": oracle_set[2]["address"], "share": own[1]["share"]}], oracle_set, 2, to_condition(secret))
