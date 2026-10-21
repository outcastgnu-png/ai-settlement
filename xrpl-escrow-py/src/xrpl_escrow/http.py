"""JSON over HTTP to the local registry and oracle (127.0.0.1 only).

Requests never go through an HTTP proxy, even when HTTP_PROXY is set, because
the services only ever listen on this machine.
"""
import json
import urllib.error
import urllib.request
from typing import Any

_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ServiceError(RuntimeError):
    """A non-2xx answer from the registry or the oracle."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def call_json(method: str, url: str, body: Any = None, timeout: float = 30) -> Any:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with _opener.open(req, timeout=timeout) as res:
            text = res.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", errors="replace")
        try:
            message = json.loads(text).get("error", text)
        except (ValueError, AttributeError):
            message = text
        raise ServiceError(err.code, f"{method} {url} -> {err.code}: {message}") from None
    return json.loads(text) if text else None
