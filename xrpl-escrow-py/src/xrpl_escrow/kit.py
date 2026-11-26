"""Python SDK for the local escrow kit. Same surface as the TypeScript SDK:

    create_job()  register a draft job and get its condition from the oracle
    fund_job()    client locks the price in an EscrowCreate; returns once the watcher marks it funded
    deliver()     provider posts the work and asks the oracle for a verdict (and, on a pass, the fulfillment)
    claim()       provider submits EscrowFinish with the fulfillment; returns once the watcher marks it paid
    refund()      after CancelAfter, submits EscrowCancel; returns once the watcher marks it refunded
    verify_verdict_log()  fetch the oracle's public verdict log and check its chain, signatures and
                          latest testnet anchor (EDR-014); optionally that your own verdict is in it

Shared verification, k of n oracles (EDR-015):

    create_shared_job()   the client makes the secret, splits it k of n, seals each share to one
                          oracle of the set and registers the job with the condition
    deliver_shared()      the provider asks every oracle of the set, checks each verdict against its
                          pinned address and its own log, and combines k shares into the fulfillment
    split_jobs()          shared jobs where the oracles disagreed, and on which criteria

Signed job specs (EDR-016):

    make_job_spec()       write a job spec v1: criteria, the checks behind each, and the rule
    create_job() / create_shared_job()  take a v1 spec as ``spec``; parties, price and SLA come from it
    sign_spec()           client or provider signs the spec hash it read; the provider's signature is its acceptance
    revise_spec()         the client replaces a draft's spec with its next revision; both sign again
    fund_job()            refuses to lock XRP until both signatures check; the EscrowCreate carries the spec hash in a memo
    deliver() / deliver_shared()  check that every verdict judged that same spec hash

It talks to the registry, oracle and watcher that the TypeScript kit runs
(``npm run registry``, ``npm run oracle``, ``npm run watcher``). Every
transaction is signed locally by the wallet that sends it. Deliverables and
job specs are data: the SDK sends and hashes them, and never runs them.
"""
import os
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any

from xrpl.clients import WebsocketClient
from xrpl.wallet import Wallet

from .auth import canonical_json, sha256_hex, sign_request, verify_verdict
from .condition import condition_of_fulfillment, make_secret, to_condition, to_fulfillment
from .shamir import choose, combine, decode_share, encode_share, split
from .share_box import BoxContext, seal, verify_share_key
from .env import read_env_file
from .escrow import EscrowRef, TxResult, cancel_escrow, create_escrow, finish_escrow, wait_past_cancel_after
from .http import ServiceError, call_json
from .job_spec import (
    agreement_problems, escrow_create_spec_memo, is_spec_v1, ledger_tx_lookup, sign_spec_hash, spec_hash, spec_memos, spec_problem,
)
from .verdict_log import LogVerification, list_anchors, verify_verdict_log

Job = dict[str, Any]

REGISTRY_URL = os.environ.get("REGISTRY_URL", "http://127.0.0.1:8801")
ORACLE_URL = os.environ.get("ORACLE_URL", "http://127.0.0.1:8802")


@dataclass
class DeliverResult:
    """``verdict_signature_valid`` is True only if the verdict is signed by the pinned
    oracle address and covers this exact deliverable. ``claim()`` does not check it."""

    job: Job
    verdict: dict[str, Any]
    verdict_signature_valid: bool
    fulfillment: str | None
    spec_hash: str | None = None  # the job's spec hash, worked out from its spec; None for an unsigned spec (EDR-016)
    spec_matches: bool = True  # the verdict judged exactly that spec hash
    unsigned_spec: bool = True


@dataclass
class OracleReport:
    """What one oracle of a shared job's set answered. ``status`` is pass or fail (a verdict that
    checked), rejected (a verdict that did not check: signature, fields, spec hash, share or log), refused
    (the oracle would not verify the job, HTTP 409, e.g. the spec it was given is not the one on the
    ledger, EDR-016) or unreachable."""

    oracle: dict[str, str]
    index: int
    status: str
    verdict: dict[str, Any] | None = None
    problems: list[str] | None = None
    log: LogVerification | None = None
    used: bool = False


@dataclass
class SharedVerification:
    job: Job
    reports: list[OracleReport]
    passed: list[str]
    failed: list[str]
    rejected: list[str]
    unreachable: list[str]
    fulfillment: str | None
    refused: list[str] | None = None
    spec_hash: str | None = None
    unsigned_spec: bool = True


def new_job_hash(body: dict[str, Any]) -> str:
    """What a client signs to create a shared job: sha256 of the canonical JSON of the body without ``auth``."""
    return sha256_hex(canonical_json({k: v for k, v in body.items() if k != "auth"}))


def combine_for_condition(shares: list[dict[str, str]], oracle_set: list[dict[str, str]], threshold: int,
                          condition: str) -> tuple[str, list[str]] | None:
    """Combine ``[{"oracle": address, "share": hex}]`` into the fulfillment for ``condition``. Only shares
    from oracles of the set, each at its own position (x = index + 1), are used; anything else raises.
    Returns ``(fulfillment, used oracle addresses)``, or None with fewer than ``threshold`` shares or no
    ``threshold``-subset that rebuilds the condition's secret. Same rules as the TypeScript SDK."""
    addresses = [o["address"] for o in oracle_set]
    parsed = []
    for s in shares:
        if s["oracle"] not in addresses:
            raise ValueError(f"{s['oracle']} is not in the job's oracle set; its share is never used")
        i = addresses.index(s["oracle"])
        share = decode_share(s["share"])
        if share.x != i + 1:
            raise ValueError(f"{s['oracle']} holds share {i + 1}, but sent share {share.x}")
        if any(p[0] == s["oracle"] for p in parsed):
            raise ValueError(f"{s['oracle']} sent two shares")
        parsed.append((s["oracle"], share))
    if threshold < 2 or len(parsed) < threshold:
        return None
    for pick in choose(parsed, threshold):
        secret = combine(p[1] for p in pick)
        if to_condition(secret) == condition:
            return to_fulfillment(secret), [p[0] for p in pick]
    return None


@dataclass
class TxOutcome:
    tx: TxResult
    job: Job


def job_spec_hash(job: Job) -> str | None:
    """The hash of a job's v1 spec, worked out from the spec itself (never taken from the registry), or None."""
    return spec_hash(job["spec"]) if is_spec_v1(job.get("spec")) else None


def _job_body(*, spec: dict[str, Any], client: str | None = None, provider: str | None = None, price_drops: str | None = None,
              sla_seconds: int | None = None) -> dict[str, Any]:
    """The registry body for a new job. A v1 spec supplies the parties, price and SLA; any given beside it must agree."""
    if not is_spec_v1(spec):
        return {"client": client, "provider": provider, "priceDrops": price_drops, "slaSeconds": sla_seconds, "spec": spec}
    problem = spec_problem(spec)
    if problem:
        raise ValueError(f"job spec refused before anything was sent: {problem}")
    for name, given, key in (("client", client, "client"), ("provider", provider, "provider"),
                             ("price_drops", price_drops, "priceDrops"), ("sla_seconds", sla_seconds, "slaSeconds")):
        if given is not None and given != spec[key]:
            raise ValueError(f"{name} differs from the one in the spec")
    return {"client": spec["client"], "provider": spec["provider"], "priceDrops": spec["priceDrops"], "slaSeconds": spec["slaSeconds"], "spec": spec}


def escrow_ref(job: Job) -> EscrowRef:
    if job.get("offerSequence") is None or job.get("cancelAfter") is None or job.get("condition") is None:
        raise ValueError(f"job {job['id']} has no escrow on the ledger yet")
    return EscrowRef(job["client"], int(job["offerSequence"]), job["condition"], int(job["cancelAfter"]))


class EscrowKit:
    def __init__(
        self,
        xrpl: WebsocketClient | None = None,
        registry_url: str = REGISTRY_URL,
        oracle_url: str = ORACLE_URL,
        oracle_address: str | None = None,
        anchor_address: str | None = None,
        env_file: str | os.PathLike[str] = ".env",
        status_timeout: float = 60,
        list_anchors_fn: Any = None,
        lookup_tx_fn: Any = None,
    ) -> None:
        """``oracle_address`` pins the oracle's verdict signing address. It defaults to
        ORACLE_VERDICT_ADDRESS from ``env_file``; it is never taken from the oracle's
        own /health answer. ``anchor_address`` pins the account that anchors the oracle's
        verdict log on the ledger, from ORACLE_ANCHOR_ADDRESS the same way. ``xrpl`` is
        needed for fund_job, claim, refund and verify_verdict_log."""
        self.registry_url = registry_url.rstrip("/")
        self.oracle_url = oracle_url.rstrip("/")
        self._xrpl = xrpl
        self._timeout = status_timeout
        # (anchor_address, oracle_address[, max_tx]) -> (anchors, complete); tests pass a stand-in for the ledger read.
        self._list_anchors = list_anchors_fn
        # tx hash -> {"found", "validated", "tx", "meta"}; reads a job's EscrowCreate for its spec memo. Tests pass a stand-in.
        self._lookup_tx = lookup_tx_fn
        self._env_file = env_file
        env = read_env_file(env_file)
        self.oracle_address = oracle_address or env.get("ORACLE_VERDICT_ADDRESS")
        self.anchor_address = anchor_address or env.get("ORACLE_ANCHOR_ADDRESS")

    def _ledger(self) -> WebsocketClient:
        if self._xrpl is None:
            raise RuntimeError("this call needs an xrpl client: EscrowKit(xrpl=connect_testnet())")
        return self._xrpl

    def _job_url(self, job_id: str, suffix: str = "") -> str:
        return f"{self.registry_url}/jobs/{urllib.parse.quote(job_id, safe='')}{suffix}"

    def get_job(self, job_id: str) -> Job:
        return call_json("GET", self._job_url(job_id))

    def events(self, job_id: str) -> list[dict[str, Any]]:
        return call_json("GET", self._job_url(job_id, "/events"))

    def reputation(self, provider: str) -> dict[str, Any]:
        return call_json("GET", f"{self.registry_url}/providers/{urllib.parse.quote(provider, safe='')}/reputation")

    def oracle_info(self) -> dict[str, Any]:
        return call_json("GET", f"{self.oracle_url}/health")

    def fetch_verdict_log(self) -> list[dict[str, Any]]:
        """Every entry of the oracle's public verdict log, fetched page by page."""
        entries: list[dict[str, Any]] = []
        while True:
            page = call_json("GET", f"{self.oracle_url}/verdicts?from={len(entries)}")
            entries.extend(page["entries"])
            if not page["entries"] or len(entries) >= page["count"]:
                return entries

    def verify_verdict_log(
        self, *, verdict: dict[str, Any] | None = None, require_anchor: bool = True, allow_unanchored: bool = False,
        entries: list[dict[str, Any]] | None = None, max_tx: int | None = None, job: Job | None = None,
    ) -> LogVerification:
        """Fetch the public verdict log and check it: every entry is signed by the pinned oracle address,
        the chain is unbroken from the genesis entry, and every anchor on a validated ledger from the pinned
        anchor account agrees with the log (one genesis only). Pass ``verdict`` to also check that your own
        signed verdict is in the log with matching fields, at or before the newest anchor
        (``allow_unanchored=True`` accepts it in the not-yet-anchored tail). The anchors are read from the
        ledger itself, never from the oracle. If the anchor account has more than ``max_tx`` transactions
        (default 10,000), older anchors can't be read and ``ok`` is False (Gpno N32). With ``verdict`` on a
        signed spec and its ``job``, the verdict's spec hash must also be the one in the memo of the job's
        EscrowCreate on a validated ledger (EDR-016); ``spec_on_ledger`` says whether it is."""
        log = self.fetch_verdict_log() if entries is None else entries
        anchors: list[dict[str, Any]] = []
        complete = True
        if self.anchor_address and self.oracle_address:
            if self._list_anchors is not None:
                anchors, complete = self._list_anchors(self.anchor_address, self.oracle_address)
            else:
                anchors, complete = list_anchors(self._ledger(), self.anchor_address, self.oracle_address,
                                                 *([max_tx] if max_tx is not None else []))
        result = verify_verdict_log(log, self.oracle_address, anchors, anchor_address=self.anchor_address, verdict=verdict,
                                    require_anchor=require_anchor, allow_unanchored=allow_unanchored, lookback_complete=complete)
        if verdict is not None and job is not None and isinstance(verdict.get("specHash"), str):
            problem = self._spec_on_ledger_problem(job, verdict)
            result.spec_on_ledger = problem is None
            if problem:
                result.problems.append(problem)
            result.ok = not result.problems
        return result

    def _spec_on_ledger_problem(self, job: Job, verdict: dict[str, Any]) -> str | None:
        if verdict.get("jobId") != job.get("id"):
            return "the verdict is for another job"
        if not job.get("createTx"):
            return "the job has no EscrowCreate recorded, so its spec memo could not be read"
        lookup = self._lookup_tx or ledger_tx_lookup(self._ledger())
        read = escrow_create_spec_memo(lookup, job["createTx"], owner=job["client"], destination=verdict.get("provider", ""),
                                       condition=verdict.get("condition", ""))
        if "problem" in read:
            return f"spec memo: {read['problem']}"
        if read["memo"]["specHash"] != verdict["specHash"]:
            return f"the verdict judged spec {verdict['specHash']}, but the escrow was locked against spec {read['memo']['specHash']}"
        if read["memo"]["revision"] != verdict.get("specRevision"):
            return (f"the verdict judged revision {verdict.get('specRevision')} of the spec, "
                    f"but the escrow was locked against revision {read['memo']['revision']}")
        return None

    def wait_for_status(self, job_id: str, statuses: list[str], timeout: float | None = None) -> Job:
        """Poll the registry until the job reaches one of ``statuses``."""
        deadline = time.monotonic() + (self._timeout if timeout is None else timeout)
        while True:
            job = self.get_job(job_id)
            if job["status"] in statuses:
                return job
            if time.monotonic() > deadline:
                raise TimeoutError(f"job {job_id} is {job['status']}, still waiting for {' or '.join(statuses)}")
            time.sleep(0.5)

    def create_job(self, *, spec: dict[str, Any], client: str | None = None, provider: str | None = None,
                   price_drops: str | None = None, sla_seconds: int | None = None) -> Job:
        """Register a draft job, then have the oracle create its secret and set the condition.

        Every argument is keyword-only, like the fields of the TypeScript ``createJob()``. With a job spec
        v1 as ``spec`` (EDR-016), the parties, price and SLA come from the spec, and the job waits for both
        signatures (``sign_spec``) before ``fund_job`` will lock anything."""
        draft = call_json("POST", f"{self.registry_url}/jobs", _job_body(spec=spec, client=client, provider=provider,
                                                                          price_drops=price_drops, sla_seconds=sla_seconds))
        call_json("POST", f"{self.oracle_url}/jobs/{urllib.parse.quote(draft['id'], safe='')}/condition")
        return self.get_job(draft["id"])

    def create_signed_job(self, spec: dict[str, Any], client_wallet: Wallet) -> Job:
        """Create a job with a v1 spec and sign it as its client. The provider signs next (``sign_spec``)."""
        if client_wallet.address != spec.get("client"):
            raise ValueError("only the spec's client can create its job")
        job = self.create_job(spec=spec)
        return self.sign_spec(job["id"], client_wallet, spec_hash(spec))

    def sign_spec(self, job_id: str, wallet: Wallet, agreed_spec_hash: str) -> Job:
        """Sign a job's spec as its client or provider (EDR-016). Pass the hash of the spec you read and agree
        to: the SDK works the hash out again from the registry's spec and refuses to sign if it differs."""
        job = self.get_job(job_id)
        if not is_spec_v1(job.get("spec")):
            raise ValueError(f"job {job_id} has an unsigned (Phase 1 to 5) spec; there is nothing to sign")
        problem = spec_problem(job["spec"])
        if problem:
            raise ValueError(f"job {job_id}'s spec is not acceptable: {problem}")
        digest = spec_hash(job["spec"])
        if digest != agreed_spec_hash:
            raise ValueError(f"the registry's spec for job {job_id} has hash {digest}, not the {agreed_spec_hash} you agreed to; nothing signed")
        if wallet.address not in (job["spec"]["client"], job["spec"]["provider"]):
            raise ValueError("only the spec's client or provider can sign it")
        return call_json("POST", self._job_url(job_id, "/spec/signatures"), {"specHash": digest, "signature": sign_spec_hash(digest, wallet)})

    def revise_spec(self, job_id: str, next_spec: dict[str, Any], client_wallet: Wallet) -> Job:
        """The client replaces a draft job's spec with its next revision; the registry keeps the old one."""
        problem = spec_problem(next_spec)
        if problem:
            raise ValueError(problem)
        return call_json("PUT", self._job_url(job_id, "/spec"), {
            "spec": next_spec, "auth": sign_request(client_wallet, "revise-spec", job_id, spec_hash(next_spec)),
        })

    def spec_revisions(self, job_id: str) -> list[dict[str, Any]]:
        """Earlier revisions of a job's spec, each with the signatures it had."""
        return call_json("GET", self._job_url(job_id, "/spec/revisions"))

    def fund_job(self, job_id: str, client_wallet: Wallet, *, spec_hash_pin: str | None = None) -> TxOutcome:
        """Client locks the price in escrow. Returns when the watcher has seen the validated EscrowCreate.

        For a job spec v1 (EDR-016) it refuses to lock anything until the client's and the provider's
        signatures over the spec hash check (worked out here from the spec), and the EscrowCreate carries
        the spec hash and revision in a memo. ``spec_hash_pin`` also pins the hash you agreed to."""
        job = self.get_job(job_id)
        if job["status"] != "draft" or not job.get("condition"):
            raise ValueError(f"job {job_id} is {job['status']}; only a draft with a condition can be funded")
        if client_wallet.address != job["client"]:
            raise ValueError("only the job's client can fund it")
        memos = None
        if is_spec_v1(job.get("spec")):
            spec = job["spec"]

            def refuse(why: str) -> ValueError:
                return ValueError(f"refusing to lock XRP for job {job_id}: {why}")

            problem = spec_problem(spec)
            if problem:
                raise refuse(f"its spec is not acceptable ({problem})")
            digest = spec_hash(spec)
            if spec_hash_pin and spec_hash_pin != digest:
                raise refuse(f"its spec has hash {digest}, not the {spec_hash_pin} you agreed to")
            if (spec["client"], spec["provider"], spec["priceDrops"], spec["slaSeconds"]) != (job["client"], job["provider"], job["priceDrops"], job["slaSeconds"]):
                raise refuse("the job's parties, price or SLA differ from its spec")
            missing = agreement_problems(spec, job.get("specSignatures"))
            if missing:
                raise refuse("; ".join(missing))
            memos = spec_memos(spec)
        elif spec_hash_pin:
            raise ValueError(f"job {job_id} has an unsigned spec; it has no spec hash to pin")
        tx, _ = create_escrow(self._ledger(), client_wallet, job["provider"], job["priceDrops"], job["condition"], int(job["slaSeconds"]), memos)
        if tx.code != "tesSUCCESS":
            return TxOutcome(tx, job)
        return TxOutcome(tx, self.wait_for_status(job_id, ["funded"]))

    def request_verification(self, job_id: str, wallet: Wallet, attempts: int = 4) -> dict[str, Any]:
        """Ask the oracle to verify the delivered work. Signed by ``wallet``; only the job's provider gets an answer.

        A 503 means the oracle could not run the checks right now (busy, or its checker
        restarted) and gave no verdict, so this asks again a few times, with a fresh
        signature each time: 4 attempts over about 6 s. A busy oracle can stay busy for
        longer than that (Gpno N21). If this still raises a 503, the work stays delivered;
        call ``request_verification`` again, until shortly before the job's deadline
        (``cancelAfter``).
        """
        return self._verify_at(self.oracle_url, job_id, wallet, "", attempts)

    def _verify_at(self, oracle_url: str, job_id: str, wallet: Wallet, payload_hash: str, attempts: int) -> dict[str, Any]:
        url = f"{oracle_url}/verify/{urllib.parse.quote(job_id, safe='')}"
        for attempt in range(1, attempts + 1):
            try:
                return call_json("POST", url, {"auth": sign_request(wallet, "verify", job_id, payload_hash)})
            except ServiceError as err:
                if err.status != 503 or attempt >= attempts:
                    raise
                time.sleep(attempt)
        raise AssertionError("unreachable")

    def deliver(self, job_id: str, provider_wallet: Wallet, content: str) -> DeliverResult:
        """Provider posts the work, then asks the oracle to verify it."""
        call_json("POST", self._job_url(job_id, "/deliverable"), {
            "content": content, "auth": sign_request(provider_wallet, "deliver", job_id, sha256_hex(content)),
        })
        expected = job_spec_hash(self.get_job(job_id))
        answer = self.request_verification(job_id, provider_wallet)
        verdict = answer["verdict"]
        matches = verdict.get("specHash") == expected
        return DeliverResult(
            job=self.get_job(job_id),
            verdict=verdict,
            verdict_signature_valid=verify_verdict(verdict, self.oracle_address) and verdict.get("evidenceHash") == sha256_hex(content) and matches,
            fulfillment=answer.get("fulfillment"),
            spec_hash=expected, spec_matches=matches, unsigned_spec=expected is None,
        )

    def claim(self, job_id: str, provider_wallet: Wallet, fulfillment: str) -> TxOutcome:
        """Provider finishes the escrow with the oracle's fulfillment. Returns when the watcher marks the job paid.

        It checks that the fulfillment opens the job's condition before sending anything.
        It does not look at the verdict: check ``DeliverResult.verdict_signature_valid``
        yourself if you rely on the oracle's signed verdict (the ledger only checks the
        fulfillment, so funds are safe either way).
        """
        job = self.get_job(job_id)
        try:
            opens = condition_of_fulfillment(fulfillment) == job.get("condition")
        except ValueError:
            opens = False
        if not opens:
            raise ValueError(f"that fulfillment does not open job {job_id}'s condition")
        tx = finish_escrow(self._ledger(), provider_wallet, escrow_ref(job), fulfillment)
        if tx.code != "tesSUCCESS":
            return TxOutcome(tx, self.get_job(job_id))
        return TxOutcome(tx, self.wait_for_status(job_id, ["paid"]))

    def refund(self, job_id: str, wallet: Wallet) -> TxOutcome:
        """Waits for a validated ledger past CancelAfter, then cancels. Returns when the watcher marks the job refunded."""
        ref = escrow_ref(self.get_job(job_id))
        wait_past_cancel_after(self._ledger(), ref)
        tx = cancel_escrow(self._ledger(), wallet, ref)
        if tx.code != "tesSUCCESS":
            return TxOutcome(tx, self.get_job(job_id))
        return TxOutcome(tx, self.wait_for_status(job_id, ["refunded"]))

    # ---- Shared verification (EDR-015) ----------------------------------------------------

    def job_verdicts(self, job_id: str) -> list[dict[str, Any]]:
        """The signed oracle verdicts the registry recorded for a shared job."""
        return call_json("GET", self._job_url(job_id, "/verdicts"))

    def split_jobs(self) -> list[dict[str, Any]]:
        """Shared jobs whose oracles disagreed: at least one signed pass and one signed fail."""
        return call_json("GET", f"{self.registry_url}/splits")

    def create_shared_job(self, *, spec: dict[str, Any], oracles: list[dict[str, str]], threshold: int, client_wallet: Wallet,
                          client: str | None = None, provider: str | None = None, price_drops: str | None = None,
                          sla_seconds: int | None = None) -> Job:
        """Client side of a shared job. Checks each oracle of the pinned set (verdict address, anchor
        account, and a share key signed by its verdict key), makes the secret, splits it ``threshold``
        of n, registers the job with the condition, signed by the client, and seals each share to its
        oracle. The secret is never stored. Raises if any oracle did not take its share; then don't fund it.
        With a v1 spec, the client also signs it; the provider signs next."""
        fields = _job_body(spec=spec, client=client, provider=provider, price_drops=price_drops, sla_seconds=sla_seconds)
        client, provider, price_drops, sla_seconds = fields["client"], fields["provider"], fields["priceDrops"], fields["slaSeconds"]
        if client_wallet.address != client:
            raise ValueError("only the job's client can create its shared job")
        n = len(oracles)
        if not 2 <= threshold <= n:
            raise ValueError("threshold must be from 2 to the number of oracles")
        keys = []
        for i, ref in enumerate(oracles):
            h = call_json("GET", f"{ref['url']}/health")
            if h.get("oracle") != ref["address"]:
                raise ValueError(f"oracle {i + 1} at {ref['url']} signs as {h.get('oracle')}, not the pinned {ref['address']}")
            if h.get("anchorAccount") != ref["anchor"]:
                raise ValueError(f"oracle {i + 1} anchors from {h.get('anchorAccount')}, not the pinned {ref['anchor']}")
            if not verify_share_key(ref["address"], h.get("publicKey", ""), h.get("shareKey") or "", h.get("shareKeySignature") or ""):
                raise ValueError(f"oracle {i + 1} ({ref['address']}) has no share key signed by its verdict key")
            keys.append(h["shareKey"])
        secret = make_secret()
        condition = to_condition(secret)
        shares = split(secret, threshold, n)
        del secret
        body = {"client": client, "provider": provider, "priceDrops": price_drops, "slaSeconds": sla_seconds, "spec": spec,
                "oracles": oracles, "threshold": threshold, "condition": condition}
        job = call_json("POST", f"{self.registry_url}/jobs", {**body, "auth": sign_request(client_wallet, "create", "", new_job_hash(body))})
        failures = []
        for i, ref in enumerate(oracles):
            box = seal(bytes.fromhex(encode_share(shares[i])), keys[i], BoxContext(job["id"], ref["address"], i + 1))
            try:
                call_json("POST", f"{ref['url']}/jobs/{urllib.parse.quote(job['id'], safe='')}/share", {
                    "index": i + 1, "box": box, "auth": sign_request(client_wallet, "share", job["id"], sha256_hex(canonical_json(box))),
                })
            except ServiceError as err:
                failures.append(f"oracle {i + 1} ({ref['address']}): {err}")
        if failures:
            raise RuntimeError(f"job {job['id']} is registered, but not every oracle took its share; do not fund it: {'; '.join(failures)}")
        if is_spec_v1(spec):
            return self.sign_spec(job["id"], client_wallet, spec_hash(spec))
        return self.get_job(job["id"])

    def request_shared_verification(self, job_id: str, wallet: Wallet, content: str, *, oracles: list[dict[str, str]] | None = None,
                                    require_anchored: bool = False, attempts: int = 4) -> SharedVerification:
        """Provider side of a shared job: ask every oracle of the set. A verdict is used only when it is
        signed by that oracle's pinned address, names this job, condition, provider, deliverable, share
        index and threshold, and that oracle's own verdict log checks against its pinned anchor account.
        ``require_anchored=True`` also needs the verdict to be anchored on the ledger. k shares of such
        passes are combined into the fulfillment; every checked verdict is posted to the registry."""
        job = self.get_job(job_id)
        if not job.get("oracles") or not job.get("threshold") or not job.get("condition"):
            raise ValueError(f"job {job_id} is not a shared job")
        if oracles is not None and canonical_json(oracles) != canonical_json(job["oracles"]):
            raise ValueError("the registry's oracle set for this job is not the set you pinned")
        oracle_set = oracles or job["oracles"]
        evidence = sha256_hex(content)
        # Every oracle must have judged the one signed spec (EDR-016), worked out here from the spec.
        expected_spec = job_spec_hash(job)
        if is_spec_v1(job.get("spec")):
            missing = agreement_problems(job["spec"], job.get("specSignatures"))
            if missing:
                raise ValueError(f"job {job_id}'s spec is not signed by both parties: {'; '.join(missing)}")
        reports: list[OracleReport] = []
        shares: dict[str, str] = {}
        for i, ref in enumerate(oracle_set):
            report = OracleReport(oracle=ref, index=i + 1, status="unreachable", problems=[])
            reports.append(report)
            try:
                answer = self._verify_at(ref["url"], job_id, wallet, ref["address"], attempts)
            except (ServiceError, OSError) as err:
                if isinstance(err, ServiceError) and err.status == 409:
                    report.status = "refused"
                report.problems.append(str(err))
                continue
            v = answer["verdict"]
            report.verdict = v
            p = report.problems
            if not verify_verdict(v, ref["address"]):
                p.append(f"verdict is not signed by the pinned oracle {ref['address']}")
            if v.get("jobId") != job_id or v.get("condition") != job["condition"] or v.get("provider") != job["provider"]:
                p.append("verdict is for another job, condition or provider")
            if v.get("evidenceHash") != evidence:
                p.append("verdict is not for this deliverable")
            if v.get("shareIndex") != i + 1 or v.get("threshold") != job["threshold"]:
                p.append("verdict names the wrong share index or threshold")
            if v.get("specHash") != expected_spec:
                p.append(f"verdict judged spec {v.get('specHash') or '(unsigned)'}, not the job's signed spec {expected_spec or '(unsigned)'}; "
                         "its share is never combined")
            if v.get("verdict") == "fail" and "share" in answer:
                p.append("oracle sent a share with a fail verdict; it is not used")
            if v.get("verdict") == "pass":
                try:
                    if decode_share(answer.get("share", "")).x != i + 1:
                        p.append(f"share is not share {i + 1}")
                except ValueError as err:
                    p.append(f"pass without a usable share: {err}")
            if not p:
                kit = EscrowKit(xrpl=self._xrpl, registry_url=self.registry_url, oracle_url=ref["url"], oracle_address=ref["address"],
                                anchor_address=ref["anchor"], env_file=self._env_file, list_anchors_fn=self._list_anchors,
                                lookup_tx_fn=self._lookup_tx)
                try:
                    report.log = kit.verify_verdict_log(verdict=v, allow_unanchored=not require_anchored, require_anchor=require_anchored, job=job)
                    if not report.log.ok:
                        p.extend(f"verdict log: {x}" for x in report.log.problems)
                except Exception as err:  # noqa: BLE001 - any failure to check means the share is not used
                    p.append(f"verdict log could not be checked: {err}")
            report.status = "rejected" if p else v["verdict"]
            if report.status == "pass":
                shares[ref["address"]] = answer["share"]
        for r in reports:
            if r.status in ("pass", "fail"):
                try:
                    call_json("POST", self._job_url(job_id, "/verdicts"), {"verdict": r.verdict})
                except ServiceError:
                    pass  # already recorded; the fulfillment does not depend on it
        combined = combine_for_condition([{"oracle": a, "share": s} for a, s in shares.items()], oracle_set, job["threshold"], job["condition"])
        for r in reports:
            r.used = bool(combined and r.oracle["address"] in combined[1])

        def by(status: str) -> list[str]:
            return [r.oracle["address"] for r in reports if r.status == status]

        return SharedVerification(self.get_job(job_id), reports, by("pass"), by("fail"), by("rejected"), by("unreachable"),
                                  combined[0] if combined else None, refused=by("refused"), spec_hash=expected_spec,
                                  unsigned_spec=expected_spec is None)

    def deliver_shared(self, job_id: str, provider_wallet: Wallet, content: str, **opts: Any) -> SharedVerification:
        """Provider posts the work for a shared job, then asks every oracle of the set."""
        call_json("POST", self._job_url(job_id, "/deliverable"), {
            "content": content, "auth": sign_request(provider_wallet, "deliver", job_id, sha256_hex(content)),
        })
        return self.request_shared_verification(job_id, provider_wallet, content, **opts)
