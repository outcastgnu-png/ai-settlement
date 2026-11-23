"""The Python SDK's shared verification (EDR-015) against the real TypeScript registry and three
oracles (stub ledger, no testnet). Oracle 3 dissents: it was started with ORACLE_FAULT=fail."""
import json
import os
import shutil
import subprocess
import urllib.request

import pytest
from xrpl.wallet import Wallet

from conftest import TS_KIT
from xrpl_escrow import EscrowKit, sha256_hex

CLIENT = Wallet.create()
PROVIDER = Wallet.create()
WORK = "the work"
SPEC = {"checks": [{"type": "sha256-match", "sha256": sha256_hex(WORK)}]}


@pytest.fixture(scope="module")
def shared():
    node = shutil.which("node")
    if node is None or not (TS_KIT / "node_modules" / "tsx").exists():
        pytest.skip("needs Node and `npm install` in xrpl-escrow")
    proc = subprocess.Popen([node, "--import", "tsx", "test/py-shared-harness.ts"], cwd=TS_KIT, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, env={**os.environ, "NODE_NO_WARNINGS": "1"})
    try:
        yield json.loads(proc.stdout.readline())
    finally:
        proc.stdin.close()
        proc.wait(timeout=30)


@pytest.fixture(scope="module")
def kit(shared):
    # Fresh oracles have no anchors yet; the default (not strict) mode accepts that when the log checks.
    return EscrowKit(registry_url=shared["registryUrl"], oracle_address="unused", anchor_address="unused", status_timeout=0.3,
                     list_anchors_fn=lambda anchor, oracle: ([], True))


_seq = iter(range(500, 10_000))


def funded_job(shared, kit):
    job = kit.create_shared_job(client=CLIENT.address, provider=PROVIDER.address, price_drops="5000000", sla_seconds=60, spec=SPEC,
                                oracles=shared["oracles"], threshold=2, client_wallet=CLIENT)
    body = {"source": "ledger", "status": "funded", "offerSequence": next(_seq), "cancelAfter": 900_000_000, "txHash": "AB" * 32}
    req = urllib.request.Request(f"{shared['registryUrl']}/jobs/{job['id']}/events", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {shared['watcherToken']}"})
    urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req).read()
    return job


def test_python_client_creates_a_shared_job_the_ts_oracles_accept(shared, kit):
    job = funded_job(shared, kit)
    assert job["threshold"] == 2 and job["oracles"] == shared["oracles"]


def test_two_pass_one_dissents_and_the_fulfillment_opens_the_condition(shared, kit):
    job = funded_job(shared, kit)
    res = kit.deliver_shared(job["id"], PROVIDER, WORK)
    assert [r.problems for r in res.reports] == [[], [], []]
    assert res.passed == [o["address"] for o in shared["oracles"][:2]]
    assert res.failed == [shared["oracles"][2]["address"]]
    assert res.fulfillment and res.fulfillment.startswith("A0228020")
    assert res.job["status"] == "verified_pass"
    assert any(s["jobId"] == job["id"] for s in kit.split_jobs())
    assert len(kit.job_verdicts(job["id"])) == 3


def test_bad_work_releases_nothing(shared, kit):
    job = funded_job(shared, kit)
    res = kit.deliver_shared(job["id"], PROVIDER, "something else")
    assert res.fulfillment is None and len(res.failed) == 3
    assert res.job["status"] == "verified_fail"


def test_strict_mode_needs_an_anchor(shared, kit):
    job = funded_job(shared, kit)
    res = kit.deliver_shared(job["id"], PROVIDER, WORK, require_anchored=True)
    assert res.fulfillment is None
    assert len(res.rejected) == 3
    assert all(any("no anchor" in p for p in r.problems) for r in res.reports)


def test_a_signed_spec_shared_job_two_of_three_with_the_spec_checked_on_the_ledger(shared):
    """EDR-016: the Python client signs the spec, the provider accepts it, every verdict names it, and the
    provider checks each verdict's spec hash against the memo on the job's EscrowCreate (stand-in ledger)."""
    from xrpl_escrow import make_job_spec, spec_hash, spec_memos

    created: dict[str, dict] = {}

    def lookup(tx_hash):
        job = created.get(tx_hash)
        if job is None:
            return {"found": False}
        return {"found": True, "validated": True, "meta": {"TransactionResult": "tesSUCCESS"},
                "tx": {"TransactionType": "EscrowCreate", "Account": job["client"], "Destination": job["provider"],
                       "Condition": job["condition"], "Memos": spec_memos(job["spec"])}}

    kit = EscrowKit(registry_url=shared["registryUrl"], oracle_address="unused", anchor_address="unused", status_timeout=0.3,
                    list_anchors_fn=lambda anchor, oracle: ([], True), lookup_tx_fn=lookup)
    spec = make_job_spec(title="report", client=CLIENT.address, provider=PROVIDER.address, price_drops="5000000", sla_seconds=60,
                         criteria=[{"id": "exact", "statement": "the agreed work", "kind": "objective",
                                    "checks": [{"type": "sha256-match", "sha256": sha256_hex(WORK)}]}])
    job = kit.create_shared_job(spec=spec, oracles=shared["oracles"], threshold=2, client_wallet=CLIENT)
    kit.sign_spec(job["id"], PROVIDER, spec_hash(spec))
    tx_hash = sha256_hex(job["id"]).upper()
    created[tx_hash] = kit.get_job(job["id"])
    post = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for url, body, token in (
        (f"{shared['memoLedgerUrl']}/memos", {"jobId": job["id"], "memos": spec_memos(spec)}, None),
        (f"{shared['registryUrl']}/jobs/{job['id']}/events",
         {"source": "ledger", "status": "funded", "offerSequence": next(_seq), "cancelAfter": 900_000_000, "txHash": tx_hash}, shared["watcherToken"]),
    ):
        headers = {"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})}
        post.open(urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=headers)).read()
    res = kit.deliver_shared(job["id"], PROVIDER, WORK)
    assert res.spec_hash == spec_hash(spec) and not res.unsigned_spec
    assert res.passed == [o["address"] for o in shared["oracles"][:2]]
    assert all(r.verdict["specHash"] == spec_hash(spec) for r in res.reports)
    assert res.reports[0].log.spec_on_ledger is True
    assert res.fulfillment and res.fulfillment.startswith("A0228020")
