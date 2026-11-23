"""Signed job spec v1 (EDR-016): the Python SDK against the TypeScript kit's vectors
(test/vectors/job-spec.json), and against the real TypeScript registry and oracles
(stub ledger, no testnet)."""
import json
import urllib.request

import pytest
from xrpl.wallet import Wallet

from conftest import TS_KIT
from xrpl_escrow import (
    EscrowKit, ServiceError, agreement_problems, check_chain, entry_mismatch, escrow_create_spec_memo, find_verdict, jcs,
    make_job_spec, meets_rule, parse_spec_memo, revise_job_spec, sha256_hex, sign_spec_hash, spec_hash, spec_memos, spec_problem,
    verify_spec_signature,
)
from xrpl_escrow.verdict_log import verdict_hash

V = json.loads((TS_KIT / "test" / "vectors" / "job-spec.json").read_text(encoding="utf-8"))
OLD_LOG = json.loads((TS_KIT / "test" / "vectors" / "verdict-log.json").read_text(encoding="utf-8"))


def test_canonical_forms_and_spec_hashes_match_typescript():
    for c in V["jcs"]:
        assert jcs(c["value"]) == c["canonical"]
    for s in V["specs"]:
        assert jcs(s["spec"]) == s["canonical"]
        assert spec_hash(s["spec"]) == s["specHash"]
        assert spec_problem(s["spec"]) is None


def test_refuses_what_could_encode_differently():
    for c in V["refusedJcs"]:
        with pytest.raises(ValueError, match=c["why"]):
            jcs(c["value"])
    with pytest.raises(ValueError):
        jcs({"s": "\ud800"})


def test_refuses_every_vector_problem_with_its_reason():
    for p in V["problems"]:
        got = spec_problem(p["spec"])
        assert got is not None and p["contains"] in got, (got, p["contains"])


def test_signatures_match_and_bind_hash_and_signer():
    for sig in V["signatures"]:
        assert verify_spec_signature(sig["specHash"], sig["signature"], sig["address"])
    s = V["signatures"][0]
    assert not verify_spec_signature(V["specs"][1]["specHash"], s["signature"], s["address"])
    # Python signs exactly what TypeScript signs (deterministic signatures, same keys).
    client = Wallet.from_entropy("22" * 16, algorithm=__import__("xrpl").CryptoAlgorithm.SECP256K1)
    assert client.address == V["parties"]["client"]["address"]
    assert sign_spec_hash(V["specs"][0]["specHash"], client) == V["signatures"][0]["signature"]


def test_memos_match_and_bad_memos_are_refused():
    by_hash = {s["specHash"]: s["spec"] for s in V["specs"]}
    for m in V["memos"]:
        assert spec_memos(by_hash[m["spec"]]) == m["memos"]
        assert parse_spec_memo(m["memos"]) == {"specHash": m["spec"], "specVersion": 1, "revision": m["revision"]}
    for bad in V["badMemos"]:
        assert "problem" in parse_spec_memo(bad)
    assert parse_spec_memo(None) is None


def test_rules_match():
    for r in V["rules"]:
        assert meets_rule(r["rule"], [{"pass": p} for p in r["results"]]) is r["meets"]


def test_a_log_of_v1_then_v2_entries_verifies_and_a_downgrade_does_not():
    assert check_chain(V["log"]["mixed"], V["oracle"]).ok
    assert "a version 1 entry after a version 2 entry" in check_chain(V["log"]["downgrade"], V["oracle"]).problem
    old, new, unsigned, _late = V["log"]["verdicts"]
    entries = V["log"]["mixed"]
    assert [verdict_hash(v) for v in V["log"]["verdicts"]] == V["log"]["verdictHashes"]
    assert find_verdict(entries, old)[0]["seq"] == 1
    assert find_verdict(entries, new)[0]["seq"] == 2
    assert find_verdict(entries, unsigned)[0]["seq"] == 3
    assert entry_mismatch({**entries[2], "specHash": "11" * 32}, new) == "specHash"
    assert entry_mismatch({**entries[2], "criteria": [{**c, "pass": True} for c in new["criteria"]]}, new) == "criteria"


def test_phase_4_and_5_logs_still_verify():
    assert all(e["v"] == 1 for e in OLD_LOG["entries"])
    assert check_chain(OLD_LOG["entries"], OLD_LOG["oracle"]).ok


CLIENT = Wallet.create()
PROVIDER = Wallet.create()
WORK = json.dumps({"summary": "Summary: escrow fees", "sources": ["tx1"], "findings": ["a"]})


def new_spec(**over):
    fields = dict(
        title="fee research", client=CLIENT.address, provider=PROVIDER.address, price_drops="5000000", sla_seconds=120,
        criteria=[
            {"id": "format", "statement": "A JSON report with summary, sources and findings", "kind": "objective",
             "checks": [{"type": "json-schema", "schema": {"type": "object", "properties": {"summary": {"type": "string"}, "sources": {"type": "array"},
                                                                                            "findings": {"type": "array"}},
                                                           "required": ["summary", "sources", "findings"]}}]},
            {"id": "useful", "statement": "The research is useful", "kind": "subjective",
             "checks": [{"type": "size-range", "minBytes": 40, "maxBytes": 10000}, {"type": "contains-text", "text": "Summary:"}]},
            {"id": "exact", "statement": "It is the agreed file", "kind": "objective", "checks": [{"type": "sha256-match", "sha256": sha256_hex(WORK)}]},
        ],
    )
    fields.update(over)
    return make_job_spec(**fields)


def test_a_subjective_criterion_without_a_check_is_refused_before_anything_is_sent():
    with pytest.raises(ValueError, match="can't judge that statement"):
        new_spec(criteria=[{"id": "useful", "statement": "The research is useful", "kind": "subjective", "checks": []}])


def test_agreement_needs_both_signatures_over_the_exact_hash():
    s = new_spec()
    h = spec_hash(s)
    assert len(agreement_problems(s, {})) == 2
    assert agreement_problems(s, {"client": sign_spec_hash(h, CLIENT), "provider": sign_spec_hash(h, PROVIDER)}) == []
    r = revise_job_spec(s, title="v2")
    assert r["revision"] == 2 and r["nonce"] == s["nonce"]
    assert len(agreement_problems(r, {"client": sign_spec_hash(h, CLIENT), "provider": sign_spec_hash(h, PROVIDER)})) == 2


def test_the_memo_is_read_only_from_the_jobs_validated_escrow_create():
    s = new_spec()
    cond = "A0258020" + "CD" * 32 + "810120"
    tx = {"TransactionType": "EscrowCreate", "Account": CLIENT.address, "Destination": PROVIDER.address, "Condition": cond, "Memos": spec_memos(s)}
    ok = {"found": True, "validated": True, "tx": tx, "meta": {"TransactionResult": "tesSUCCESS"}}
    args = dict(owner=CLIENT.address, destination=PROVIDER.address, condition=cond)
    assert escrow_create_spec_memo(lambda h: ok, "AB" * 32, **args) == {"memo": {"specHash": spec_hash(s), "specVersion": 1, "revision": 1}}
    assert "not in a validated" in escrow_create_spec_memo(lambda h: {**ok, "validated": False}, "AB" * 32, **args)["problem"]
    assert "client" in escrow_create_spec_memo(lambda h: {**ok, "tx": {**tx, "Account": PROVIDER.address}}, "AB" * 32, **args)["problem"]
    assert "no job spec memo" in escrow_create_spec_memo(lambda h: {**ok, "tx": {**tx, "Memos": None}}, "AB" * 32, **args)["problem"]


# ---- against the TypeScript registry and oracle -------------------------------------------------


def _post(url, body, token=None):
    headers = {"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})}
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=headers)
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req) as res:
        return json.loads(res.read())


@pytest.fixture(scope="module")
def kit(local_services):
    return EscrowKit(registry_url=local_services["registryUrl"], oracle_url=local_services["oracleUrl"],
                     oracle_address=local_services["oracleAddress"], anchor_address="unused")


_seq = iter(range(700, 10_000))


def fund(local_services, job, memos="spec"):
    """Pretend the watcher saw the EscrowCreate, and tell the stand-in ledger which memo it carried."""
    seq = next(_seq)
    _post(f"{local_services['memoLedgerUrl']}/memos", {"jobId": job["id"], "memos": spec_memos(job["spec"]) if memos == "spec" else memos})
    _post(f"{local_services['registryUrl']}/jobs/{job['id']}/events",
          {"source": "ledger", "status": "funded", "offerSequence": seq, "cancelAfter": 900_000_000, "txHash": "AB" * 32},
          local_services["watcherToken"])


def test_python_signs_a_spec_the_typescript_registry_and_oracle_accept(kit, local_services):
    s = new_spec(rule={"atLeast": 2})
    job = kit.create_signed_job(s, CLIENT)
    assert job["specHash"] == spec_hash(s) and job["specSignatures"]["client"]["address"] == CLIENT.address
    with pytest.raises(ValueError, match="provider .* has not signed"):
        kit.fund_job(job["id"], CLIENT)
    with pytest.raises(ValueError, match="nothing signed"):
        kit.sign_spec(job["id"], PROVIDER, spec_hash(new_spec()))
    kit.sign_spec(job["id"], PROVIDER, spec_hash(s))
    with pytest.raises(RuntimeError, match="needs an xrpl client"):
        kit.fund_job(job["id"], CLIENT)  # past the refusal: it would now lock XRP
    fund(local_services, kit.get_job(job["id"]))
    other = json.dumps({"summary": "Summary: other words", "sources": ["tx9"], "findings": ["b"]})
    res = kit.deliver(job["id"], PROVIDER, other)
    assert res.verdict["verdict"] == "pass" and res.spec_matches and res.verdict_signature_valid and not res.unsigned_spec
    assert [c["pass"] for c in res.verdict["criteria"]] == [True, True, False]
    assert res.verdict["specHash"] == spec_hash(s) and res.verdict["judged"] == "checks"


def test_an_edit_in_place_is_refused_and_a_revision_is_kept(kit):
    s = new_spec()
    job = kit.create_signed_job(s, CLIENT)
    kit.sign_spec(job["id"], PROVIDER, spec_hash(s))
    with pytest.raises(ServiceError, match="never edited in place"):
        kit.revise_spec(job["id"], {**s, "title": "edited"}, CLIENT)
    nxt = revise_job_spec(s, price_drops="4000000")
    revised = kit.revise_spec(job["id"], nxt, CLIENT)
    assert revised["specRevision"] == 2 and revised["priceDrops"] == "4000000"
    assert revised["specSignatures"] == {"client": None, "provider": None}
    assert [r["revision"] for r in kit.spec_revisions(job["id"])] == [1]


def test_the_oracle_refuses_a_spec_that_is_not_the_one_on_the_ledger(kit, local_services):
    s = new_spec()
    job = kit.create_signed_job(s, CLIENT)
    kit.sign_spec(job["id"], PROVIDER, spec_hash(s))
    fund(local_services, kit.get_job(job["id"]), memos=spec_memos(new_spec()))
    with pytest.raises(ServiceError, match="not the spec locked on the ledger"):
        kit.deliver(job["id"], PROVIDER, WORK)
