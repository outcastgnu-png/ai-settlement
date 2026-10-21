"""request_verification asks again, with a fresh signature, when the oracle answers 503 (Gpno N9)."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from xrpl.wallet import Wallet

from xrpl_escrow import EscrowKit, ServiceError


def oracle_answering(statuses):
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
            status = statuses[min(len(seen), len(statuses)) - 1]
            body = json.dumps({"verdict": {"verdict": "pass"}} if status == 200 else {"error": "busy"}).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, seen


def test_retries_a_503_with_fresh_signatures(monkeypatch):
    monkeypatch.setattr("xrpl_escrow.kit.time.sleep", lambda _s: None)
    server, seen = oracle_answering([503, 503, 200])
    try:
        kit = EscrowKit(oracle_url=f"http://127.0.0.1:{server.server_port}", oracle_address="r")
        assert kit.request_verification("job", Wallet.create())["verdict"]["verdict"] == "pass"
    finally:
        server.shutdown()
    assert len(seen) == 3
    assert len({s["auth"]["signature"] for s in seen}) == 3


def test_gives_up_after_the_last_attempt_and_never_retries_other_errors(monkeypatch):
    monkeypatch.setattr("xrpl_escrow.kit.time.sleep", lambda _s: None)
    server, seen = oracle_answering([503])
    try:
        kit = EscrowKit(oracle_url=f"http://127.0.0.1:{server.server_port}", oracle_address="r")
        with pytest.raises(ServiceError) as err:
            kit.request_verification("job", Wallet.create(), attempts=3)
        assert err.value.status == 503 and len(seen) == 3
    finally:
        server.shutdown()
    server, seen = oracle_answering([403])
    try:
        kit = EscrowKit(oracle_url=f"http://127.0.0.1:{server.server_port}", oracle_address="r")
        with pytest.raises(ServiceError):
            kit.request_verification("job", Wallet.create())
        assert len(seen) == 1
    finally:
        server.shutdown()
