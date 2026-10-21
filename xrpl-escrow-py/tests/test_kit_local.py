"""The Python SDK against the real TypeScript registry and oracle (stub ledger, no testnet)."""
import pytest
from xrpl.constants import CryptoAlgorithm
from xrpl.wallet import Wallet

from xrpl_escrow import EscrowKit, ServiceError, escrow_ref, sha256_hex, sign_request, verify_verdict
from xrpl_escrow.http import call_json

CLIENT = Wallet.create()
PROVIDER = Wallet.create(CryptoAlgorithm.SECP256K1)
SPEC = {"checks": [{"type": "sha256-match", "sha256": sha256_hex("the work")}]}


@pytest.fixture(scope="module")
def kit(local_services):
    return EscrowKit(
        registry_url=local_services["registryUrl"], oracle_url=local_services["oracleUrl"],
        oracle_address=local_services["oracleAddress"], status_timeout=0.3,
    )


def new_job(kit):
    return kit.create_job(CLIENT.address, PROVIDER.address, "5000000", 60, SPEC)


def test_create_job_registers_a_draft_with_the_oracles_condition(kit):
    job = new_job(kit)
    assert job["status"] == "draft"
    assert len(job["condition"]) == 78 and job["condition"].startswith("A0258020")
    with pytest.raises(ValueError, match="no escrow"):
        escrow_ref(job)


def test_ledger_calls_need_an_xrpl_client(kit):
    job = new_job(kit)
    with pytest.raises(RuntimeError, match="xrpl client"):
        kit.fund_job(job["id"], CLIENT)
    with pytest.raises(ValueError, match="only the job's client"):
        kit.fund_job(job["id"], PROVIDER)


def test_deliver_returns_a_checked_signed_pass_with_the_fulfillment(kit, mark_funded):
    job = new_job(kit)
    mark_funded(job["id"])
    res = kit.deliver(job["id"], PROVIDER, "the work")
    assert res.job["status"] == "verified_pass"
    assert res.verdict["verdict"] == "pass"
    assert res.verdict_signature_valid
    assert res.fulfillment is not None and res.fulfillment.startswith("A0228020")
    ref = escrow_ref(res.job)
    assert (ref.owner, ref.offer_sequence, ref.condition, ref.cancel_after) == (CLIENT.address, 7, job["condition"], 900_000_000)


def test_deliver_returns_a_signed_fail_with_no_fulfillment(kit, mark_funded):
    job = new_job(kit)
    mark_funded(job["id"], 8)
    res = kit.deliver(job["id"], PROVIDER, "something else")
    assert res.fulfillment is None and res.verdict_signature_valid
    assert res.job["status"] == "verified_fail"
    assert verify_verdict(res.verdict, kit.oracle_address)


def test_does_not_trust_a_verdict_from_another_oracle_address(kit, mark_funded):
    other = EscrowKit(registry_url=kit.registry_url, oracle_url=kit.oracle_url, oracle_address=Wallet.create().address)
    job = new_job(kit)
    mark_funded(job["id"], 10)
    res = other.deliver(job["id"], PROVIDER, "the work")
    assert res.verdict["verdict"] == "pass"
    assert not res.verdict_signature_valid


def test_deliver_is_refused_for_a_non_provider_and_before_funding(kit, mark_funded):
    job = new_job(kit)
    with pytest.raises(ServiceError, match="only when funded"):
        kit.deliver(job["id"], PROVIDER, "the work")
    mark_funded(job["id"], 9)
    with pytest.raises(ServiceError, match="provider") as err:
        kit.deliver(job["id"], CLIENT, "the work")
    assert err.value.status == 403


def test_a_python_signed_verify_request_works_once(kit, mark_funded):
    job = new_job(kit)
    mark_funded(job["id"], 11)
    kit.deliver(job["id"], PROVIDER, "the work")
    auth = sign_request(PROVIDER, "verify", job["id"])
    url = f"{kit.oracle_url}/verify/{job['id']}"
    assert call_json("POST", url, {"auth": auth})["verdict"]["verdict"] == "pass"
    for variant in (auth, {**auth, "signature": auth["signature"].lower()}):
        with pytest.raises(ServiceError, match="already used"):
            call_json("POST", url, {"auth": variant})


def test_wait_for_status_times_out_with_the_current_status(kit):
    job = new_job(kit)
    with pytest.raises(TimeoutError, match="is draft"):
        kit.wait_for_status(job["id"], ["paid"], 0.1)


def test_reports_provider_reputation(kit):
    rep = kit.reputation(PROVIDER.address)
    assert rep["provider"] == PROVIDER.address
    assert rep["passed"] >= 3 and rep["failed"] == 1


def test_claim_refuses_a_fulfillment_that_does_not_open_the_jobs_condition(kit, mark_funded):
    from xrpl_escrow import to_fulfillment

    job = new_job(kit)
    mark_funded(job["id"], 12)
    for bad in (to_fulfillment(bytes(32)), "A0228020", "not hex"):
        with pytest.raises(ValueError, match="does not open"):
            kit.claim(job["id"], PROVIDER, bad)  # refused before any ledger call
