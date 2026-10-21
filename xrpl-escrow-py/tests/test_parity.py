"""The Python SDK signs and verifies exactly what the TypeScript kit does."""
import copy

from xrpl.constants import CryptoAlgorithm
from xrpl.wallet import Wallet

from xrpl_escrow import canonical_json, replay_key, sha256_hex, sign_request, verify_verdict
from xrpl_escrow.auth import request_message, sign_payload, verify_payload


def wallet(v):
    return Wallet.from_entropy(v["entropy"], algorithm=CryptoAlgorithm(v["algorithm"]))


def test_content_hash(vectors):
    assert sha256_hex(vectors["content"]) == vectors["contentSha256"]


def test_signed_requests_are_byte_for_byte_the_same(vectors):
    for v in vectors["requests"]:
        w = wallet(v)
        assert (w.address, w.public_key) == (v["address"], v["publicKey"])
        assert request_message(v["action"], v["jobId"], v["timestamp"], v["payloadHash"]) == v["message"]
        auth = sign_request(w, v["action"], v["jobId"], v["payloadHash"], timestamp=v["timestamp"])
        assert auth == {"publicKey": v["publicKey"], "timestamp": v["timestamp"], "signature": v["signature"]}


def test_replay_key_matches_the_oracle(vectors):
    for v in vectors["requests"]:
        assert replay_key(v["publicKey"], v["action"], v["jobId"], v["timestamp"], v["payloadHash"]) == v["replayKey"]
        # Gpno N2: the key does not depend on how the signature or public key is written.
        assert replay_key(v["publicKey"].lower(), v["action"], v["jobId"], v["timestamp"], v["payloadHash"]) == v["replayKey"]


def test_canonical_json_matches_including_non_ascii(vectors):
    assert canonical_json(vectors["verdict"]["body"]) == vectors["verdict"]["canonical"]


def test_verdict_signature_matches_and_verifies(vectors):
    v = vectors["verdict"]
    body = v["body"]
    assert sign_payload(body, wallet(v)) == v["signature"]
    signed = {**body, "signature": v["signature"]}
    assert verify_verdict(signed, body["oracle"])
    assert verify_payload(body, v["signature"], body["publicKey"], body["oracle"])


def test_verdict_from_another_address_or_tampered_is_refused(vectors):
    v = vectors["verdict"]
    signed = {**v["body"], "signature": v["signature"]}
    assert not verify_verdict(signed, Wallet.create().address)
    assert not verify_verdict(signed, None)
    tampered = copy.deepcopy(signed)
    tampered["verdict"] = "fail"
    assert not verify_verdict(tampered, v["body"]["oracle"])
    tampered = copy.deepcopy(signed)
    tampered["checks"][1]["detail"] = "delivered in 12 ms"
    assert not verify_verdict(tampered, v["body"]["oracle"])
    garbage = {**signed, "signature": "00"}
    assert not verify_verdict(garbage, v["body"]["oracle"])


def test_canonical_json_refuses_values_javascript_would_encode_differently():
    import pytest

    for bad in (1e-7, 0.5, float("nan"), 2**53, -(2**53), "\ud800", {1: "x"}):
        with pytest.raises(ValueError):
            canonical_json({"v": bad} if not isinstance(bad, dict) else bad)
    assert canonical_json({"v": 2**53 - 1}) == '{"v":9007199254740991}'


def test_canonical_json_sorts_keys_like_javascript():
    # By code point U+FF61 comes first; by UTF-16 code unit (what JavaScript compares) the
    # emoji's high surrogate D83D comes first. The TypeScript kit prints {"😀":1,"｡":2}.
    assert canonical_json({"\uFF61": 2, "\U0001F600": 1}) == '{"\U0001F600":1,"\uFF61":2}'
