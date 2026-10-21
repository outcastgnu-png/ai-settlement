"""Start the TypeScript kit's registry, oracle and watcher as child processes,
the same way ``npm run registry|oracle|watcher`` would. Works on Windows: it
runs Node with the tsx loader directly, no shell scripts."""
import os
import shutil
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

from .http import call_json


@contextmanager
def ts_services(
    ts_kit: str | os.PathLike[str],
    *,
    registry_port: int = 8801,
    oracle_port: int = 8802,
    data_dir: str | os.PathLike[str] | None = None,
    env_file: str | os.PathLike[str] | None = None,
    log: Callable[[str], None] = print,
) -> Iterator[dict[str, str]]:
    """Run the three services from the TypeScript kit folder until the block ends.

    Yields ``{"registryUrl": ..., "oracleUrl": ...}``.
    """
    kit = Path(ts_kit).resolve()
    node = shutil.which("node")
    if node is None or not (kit / "node_modules" / "tsx").exists():
        raise RuntimeError(f"needs Node 22.12+ and `npm install` in {kit}")
    data = Path(data_dir).resolve() if data_dir else kit / "data"
    registry_url = f"http://127.0.0.1:{registry_port}"
    oracle_url = f"http://127.0.0.1:{oracle_port}"
    env = {
        **os.environ, "NODE_NO_WARNINGS": "1",
        "REGISTRY_PORT": str(registry_port), "ORACLE_PORT": str(oracle_port), "REGISTRY_URL": registry_url,
        "JOBS_DB": str(data / "jobs.db"), "VAULT_FILE": str(data / "oracle-vault.json"),
        "VERDICT_LOG": str(data / "verdicts.jsonl"), "REPLAY_FILE": str(data / "oracle-replay.json"),
        "ENV_FILE": str(Path(env_file).resolve() if env_file else kit / ".env"),
    }
    procs: list[subprocess.Popen[str]] = []

    def start(name: str, script: str, ready: Callable[[str], bool], timeout: float = 60) -> None:
        proc = subprocess.Popen([node, "--import", "tsx", script], cwd=kit, env=env, text=True, encoding="utf-8",
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        procs.append(proc)
        lines: list[str] = []

        def pump() -> None:
            for line in proc.stdout:  # type: ignore[union-attr]
                lines.append(line.rstrip())
                log(f"    | {line.rstrip()}")

        threading.Thread(target=pump, daemon=True).start()
        deadline = time.monotonic() + timeout
        while not any(ready(line) for line in list(lines)):
            if proc.poll() is not None:
                raise RuntimeError(f"{name} exited during startup")
            if time.monotonic() > deadline:
                raise RuntimeError(f"{name} did not become ready")
            time.sleep(0.2)

    def healthy(url: str) -> Callable[[str], bool]:
        def check(_line: str) -> bool:
            try:
                call_json("GET", f"{url}/health", timeout=2)
                return True
            except Exception:  # noqa: BLE001 - not up yet
                return False
        return check

    try:
        start("registry", "src/registry/server.ts", lambda line: "listening" in line)
        start("oracle", "src/oracle/server.ts", lambda line: "listening" in line)
        start("watcher", "src/watcher.ts", lambda line: "[watcher] connected" in line)
        for url in (registry_url, oracle_url):
            if not healthy(url)(""):
                raise RuntimeError(f"{url} does not answer")
        yield {"registryUrl": registry_url, "oracleUrl": oracle_url}
    finally:
        for proc in reversed(procs):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
