import hashlib

import pytest

from xrpl_escrow import condition_of_fulfillment, make_secret, to_condition, to_fulfillment

ZERO = bytes(32)


def test_known_vector_for_a_zero_secret():
    assert to_condition(ZERO) == "A0258020" + "66687AADF862BD776C8FC18B8E9F8E20089714856EE233B3902A591D0D5F2925" + "810120"
    assert to_fulfillment(ZERO) == "A0228020" + "00" * 32


def test_matches_the_typescript_kit(vectors):
    for v in vectors["conditions"]:
        secret = bytes.fromhex(v["secret"])
        assert to_condition(secret) == v["condition"]
        assert to_fulfillment(secret) == v["fulfillment"]
        assert condition_of_fulfillment(v["fulfillment"]) == v["condition"]


def test_condition_holds_the_sha256_of_the_secret():
    s = make_secret()
    assert to_condition(s)[8:72] == hashlib.sha256(s).hexdigest().upper()
    assert to_fulfillment(s)[8:] == s.hex().upper()


def test_rejects_secrets_that_are_not_32_bytes():
    with pytest.raises(ValueError):
        to_condition(bytes(31))
    with pytest.raises(ValueError):
        to_fulfillment(bytes(33))
    with pytest.raises(ValueError):
        condition_of_fulfillment("A0228020" + "00" * 31)


def test_fresh_secret_each_time():
    assert make_secret() != make_secret()
