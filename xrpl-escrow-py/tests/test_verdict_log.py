"""The Python SDK checks the public verdict log (EDR-014) exactly as the TypeScript kit does:
same hashes, same answers on the same broken copies, same anchor memos and ledger rows."""
import copy
import json

import pytest
from xrpl.constants import CryptoAlgorithm
from xrpl.wallet import Wallet

from xrpl_escrow import (
    EscrowKit, anchor_history_problems, check_chain, find_verdict, parse_anchor_memo, sha256_hex, verdict_in_log,
    verify_verdict_log,
)
from xrpl_escrow.verdict_log import anchor_from_account_tx, anchor_problem, entry_hash, verdict_hash

from conftest import TS_KIT


@pytest.fixture(scope="module")
def vectors():
    return json.loads((TS_KIT / "test" / "vectors" / "verdict-log.json").read_text(encoding="utf-8"))


def as_dict(check):
    return {"ok": check.ok, "problem": check.problem, "head": check.head, "count": check.count}


def test_entry_and_verdict_hashes_match_the_typescript_kit(vectors):
    for e in vectors["entries"]:
        assert entry_hash(e) == e["hash"]
    assert [verdict_hash(v) for v in vectors["verdicts"]] == vectors["verdictHashes"]


def test_chain_checks_give_the_same_answers(vectors):
    for case in vectors["chainCases"]:
        assert as_dict(check_chain(case["entries"], case["pinned"])) == case["expected"], case["name"]


def test_anchor_comparison_gives_the_same_answers(vectors):
    for case in vectors["anchorCases"]:
        entries = case.get("entries", vectors["entries"])
        assert anchor_problem(entries, case["anchor"], vectors["oracle"]) == case["expected"], case["name"]


def test_anchor_history_gives_the_same_answers(vectors):
    for case in vectors["historyCases"]:
        assert anchor_history_problems(vectors["entries"], case["anchors"], vectors["oracle"]) == case["expected"], case["name"]


def test_a_lying_public_summary_is_caught(vectors):
    """Gpno N26: an entry naming a fail verdict's hash but saying pass in public is not that verdict's entry."""
    for case in vectors["findCases"]:
        entry, mismatch = find_verdict(case["entries"], case["verdict"])
        assert {"seq": entry["seq"] if entry else None, "mismatch": mismatch} == case["expected"], case["name"]
    lying = vectors["findCases"][1]
    res = verify_verdict_log(lying["entries"], vectors["oracle"], None, anchor_address=vectors["anchorAccount"],
                             verdict=lying["verdict"], require_anchor=False)
    assert not res.ok and "differs" in res.problems[0]


def test_anchor_memos_parse_the_same(vectors):
    for case in vectors["memoCases"]:
        assert parse_anchor_memo(case["memos"]) == case["expected"], case["name"]


def test_the_newest_usable_account_tx_row_is_the_anchor(vectors):
    found = [anchor_from_account_tx(t, vectors["anchorAccount"], vectors["oracle"]) for t in vectors["accountTx"]]
    first = next(i for i, a in enumerate(found) if a is not None)
    assert first == vectors["expectedLatestAnchorRow"]
    assert [i for i, a in enumerate(found) if a is not None] == vectors["expectedAnchorRows"]
    assert found[first]["seq"] == 1 and found[first]["hash"] == vectors["entries"][1]["hash"]


def test_a_party_finds_its_own_verdict(vectors):
    entries = vectors["entries"]
    seqs = [(verdict_in_log(entries, v) or {}).get("seq") for v in vectors["verdicts"]]
    seqs.append((verdict_in_log(entries, {**vectors["verdicts"][0], "issuedAt": 1}) or {}).get("seq"))
    assert seqs == vectors["verdictInLog"]
    # entries hold each check's outcome, never its detail
    assert "does not match" not in json.dumps(entries, ensure_ascii=False)


def test_verify_verdict_log_puts_it_together(vectors):
    entries, oracle, account = vectors["entries"], vectors["oracle"], vectors["anchorAccount"]
    anchor = {"v": 1, "seq": 2, "hash": entries[2]["hash"], "oracle": oracle, "txHash": "AB" * 32, "ledgerIndex": 1, "account": account}
    res = verify_verdict_log(entries, oracle, anchor, anchor_address=account, verdict=vectors["verdicts"][1])
    assert res.ok and res.unanchored == 1 and res.head == {"seq": 3, "hash": entries[3]["hash"]}
    assert res.verdict_entry["seq"] == 2 and res.verdict_anchored
    # Gpno N30: a verdict after the newest anchor is not pinned yet
    tail = verify_verdict_log(entries, oracle, anchor, anchor_address=account, verdict=vectors["verdicts"][2])
    assert not tail.ok and tail.verdict_anchored is False and "after the newest anchor" in tail.problems[0]
    assert verify_verdict_log(entries, oracle, anchor, anchor_address=account, verdict=vectors["verdicts"][2], allow_unanchored=True).ok
    edited = copy.deepcopy(entries)
    edited[1]["verdict"] = "fail"
    assert not verify_verdict_log(edited, oracle, anchor, anchor_address=account).ok
    assert "the ledger anchored" in verify_verdict_log(entries, oracle, {**anchor, "hash": "ee" * 32}, anchor_address=account).problems[0]
    assert not verify_verdict_log(entries, oracle, None, anchor_address=account).ok
    assert verify_verdict_log(entries, oracle, None, anchor_address=account, require_anchor=False).ok
    assert not verify_verdict_log(entries, oracle, anchor, anchor_address=None).ok
    assert not verify_verdict_log(entries, Wallet.create().address, anchor, anchor_address=account).ok


def test_against_the_typescript_oracle(local_services, mark_funded):
    """The log the real oracle serves checks with the Python SDK, and has this job's verdict."""
    provider = Wallet.create(CryptoAlgorithm.SECP256K1)
    kit = EscrowKit(registry_url=local_services["registryUrl"], oracle_url=local_services["oracleUrl"],
                    oracle_address=local_services["oracleAddress"], anchor_address=Wallet.create().address)
    job = kit.create_job(client=Wallet.create().address, provider=provider.address, price_drops="5000000", sla_seconds=60,
                         spec={"checks": [{"type": "sha256-match", "sha256": sha256_hex("logged work")}]})
    mark_funded(job["id"], 41)
    res = kit.deliver(job["id"], provider, "logged work")
    entries = kit.fetch_verdict_log()
    assert check_chain(entries, kit.oracle_address).ok
    out = verify_verdict_log(entries, kit.oracle_address, None, anchor_address=kit.anchor_address,
                             verdict=res.verdict, require_anchor=False, allow_unanchored=True)
    assert out.ok and out.verdict_entry["jobId"] == job["id"]
    assert not check_chain(entries, Wallet.create().address).ok
