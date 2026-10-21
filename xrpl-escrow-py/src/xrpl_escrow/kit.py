"""Python SDK for the local escrow kit. Same surface as the TypeScript SDK:

    create_job()  register a draft job and get its condition from the oracle
    fund_job()    client locks the price in an EscrowCreate; returns once the watcher marks it funded
    deliver()     provider posts the work and asks the oracle for a verdict (and, on a pass, the fulfillment)
    claim()       provider submits EscrowFinish with the fulfillment; returns once the watcher marks it paid
    refund()      after CancelAfter, submits EscrowCancel; returns once the watcher marks it refunded

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

from .auth import sha256_hex, sign_request, verify_verdict
from .condition import condition_of_fulfillment
from .env import read_env_file
from .escrow import EscrowRef, TxResult, cancel_escrow, create_escrow, finish_escrow, wait_past_cancel_after
from .http import ServiceError, call_json

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


@dataclass
class TxOutcome:
    tx: TxResult
    job: Job


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
        env_file: str | os.PathLike[str] = ".env",
        status_timeout: float = 60,
    ) -> None:
        """``oracle_address`` pins the oracle's verdict signing address. It defaults to
        ORACLE_VERDICT_ADDRESS from ``env_file``; it is never taken from the oracle's
        own /health answer. ``xrpl`` is needed for fund_job, claim and refund."""
        self.registry_url = registry_url.rstrip("/")
        self.oracle_url = oracle_url.rstrip("/")
        self._xrpl = xrpl
        self._timeout = status_timeout
        self.oracle_address = oracle_address or read_env_file(env_file).get("ORACLE_VERDICT_ADDRESS")

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

    def create_job(self, client: str, provider: str, price_drops: str, sla_seconds: int, spec: dict[str, Any]) -> Job:
        """Register a draft job, then have the oracle create its secret and set the condition."""
        draft = call_json("POST", f"{self.registry_url}/jobs", {
            "client": client, "provider": provider, "priceDrops": price_drops, "slaSeconds": sla_seconds, "spec": spec,
        })
        call_json("POST", f"{self.oracle_url}/jobs/{urllib.parse.quote(draft['id'], safe='')}/condition")
        return self.get_job(draft["id"])

    def fund_job(self, job_id: str, client_wallet: Wallet) -> TxOutcome:
        """Client locks the price in escrow. Returns when the watcher has seen the validated EscrowCreate."""
        job = self.get_job(job_id)
        if job["status"] != "draft" or not job.get("condition"):
            raise ValueError(f"job {job_id} is {job['status']}; only a draft with a condition can be funded")
        if client_wallet.address != job["client"]:
            raise ValueError("only the job's client can fund it")
        tx, _ = create_escrow(self._ledger(), client_wallet, job["provider"], job["priceDrops"], job["condition"], int(job["slaSeconds"]))
        if tx.code != "tesSUCCESS":
            return TxOutcome(tx, job)
        return TxOutcome(tx, self.wait_for_status(job_id, ["funded"]))

    def request_verification(self, job_id: str, wallet: Wallet, attempts: int = 4) -> dict[str, Any]:
        """Ask the oracle to verify the delivered work. Signed by ``wallet``; only the job's provider gets an answer.

        A 503 means the oracle could not run the checks right now (busy, or its checker
        restarted) and gave no verdict, so this asks again a few times, with a fresh
        signature each time.
        """
        url = f"{self.oracle_url}/verify/{urllib.parse.quote(job_id, safe='')}"
        for attempt in range(1, attempts + 1):
            try:
                return call_json("POST", url, {"auth": sign_request(wallet, "verify", job_id)})
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
        answer = self.request_verification(job_id, provider_wallet)
        verdict = answer["verdict"]
        return DeliverResult(
            job=self.get_job(job_id),
            verdict=verdict,
            verdict_signature_valid=verify_verdict(verdict, self.oracle_address) and verdict.get("evidenceHash") == sha256_hex(content),
            fulfillment=answer.get("fulfillment"),
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
