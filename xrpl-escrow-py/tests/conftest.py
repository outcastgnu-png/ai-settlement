import json
import os
import shutil
import subprocess
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TS_KIT = ROOT / "xrpl-escrow"
VECTORS = TS_KIT / "test" / "vectors" / "sdk-parity.json"


def pytest_addoption(parser):
    parser.addoption("--testnet", action="store_true", help="also run the tests that use the XRP Ledger testnet")


def pytest_collection_modifyitems(config, items):
    if config.getoption("--testnet"):
        return
    skip = pytest.mark.skip(reason="needs the testnet; run with --testnet")
    for item in items:
        if "testnet" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def vectors():
    """What the TypeScript kit produced for fixed inputs (test/vectors/make-sdk-vectors.ts)."""
    return json.loads(VECTORS.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def local_services():
    """The TypeScript registry and oracle, started with a stub ledger by test/py-harness.ts."""
    node = shutil.which("node")
    if node is None or not (TS_KIT / "node_modules" / "tsx").exists():
        pytest.skip("needs Node and `npm install` in xrpl-escrow")
    proc = subprocess.Popen(
        [node, "--import", "tsx", "test/py-harness.ts"], cwd=TS_KIT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        text=True, env={**os.environ, "NODE_NO_WARNINGS": "1"},
    )
    try:
        info = json.loads(proc.stdout.readline())
        yield info
    finally:
        proc.stdin.close()
        proc.wait(timeout=30)


@pytest.fixture(scope="module")
def mark_funded(local_services):
    """Pretend the watcher saw a validated EscrowCreate."""
    return lambda job_id, offer_sequence=7: _post_ledger_event(local_services, job_id, offer_sequence)


def _post_ledger_event(info, job_id, offer_sequence):
    body = {"source": "ledger", "status": "funded", "offerSequence": offer_sequence, "cancelAfter": 900_000_000, "txHash": "AB" * 32}
    req = urllib.request.Request(
        f"{info['registryUrl']}/jobs/{job_id}/events", data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {info['watcherToken']}"},
    )
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req) as res:
        return json.loads(res.read())
