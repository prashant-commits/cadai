"""Zygote: warm runs skip the build123d import, and a dead helper is replaced."""

import os
import signal
import threading
import time

from fastapi.testclient import TestClient

from cadai_geo.service import app, zygote

HEADERS = {"x-cadai-geo-token": "test-token"}
client = TestClient(app)

TWO_BOX = """
from build123d import *
a = Box(10, 20, 30, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'base'
b = Pos(0, 0, 30) * Box(10, 20, 5, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'lid'
result = Compound([a, b])
"""


def _post(script: str, timeout_s: float = 60):
    return client.post(
        "/run",
        json={"script": script, "timeout_s": timeout_s},
        headers=HEADERS,
    )


def test_warm_run_under_two_seconds():
    warmup = _post(TWO_BOX)
    assert warmup.status_code == 200, warmup.text
    assert warmup.json()["ok"] is True, warmup.text
    pid = zygote.pid
    assert pid is not None
    with open(f"/proc/{pid}/environ", "rb") as handle:
        env = handle.read()
    assert b"CADAI_GEO_TOKEN" not in env
    assert b"HOME=" not in env
    started = time.perf_counter()
    response = _post(TWO_BOX)
    elapsed = time.perf_counter() - started
    print(f"WARM_RUN_SECONDS={elapsed:.3f}", flush=True)
    payload = response.json()
    assert payload["ok"] is True, payload
    assert {part["label"] for part in payload["parts"]} == {"base", "lid"}
    assert elapsed < 2, elapsed


def test_zygote_restarts_after_kill_mid_run():
    ready = _post(TWO_BOX)
    assert ready.json()["ok"] is True, ready.text
    errors: list[BaseException | str] = []

    def killer() -> None:
        try:
            deadline = time.time() + 10
            while time.time() < deadline and zygote.active_pid is None:
                time.sleep(0.01)
            if zygote.active_pid is None or zygote.pid is None:
                errors.append("run did not start")
                return
            os.kill(zygote.pid, signal.SIGKILL)
        except BaseException as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    thread = threading.Thread(target=killer)
    thread.start()
    started = time.perf_counter()
    inflight = _post("import time\ntime.sleep(30)\n", timeout_s=20)
    hung = time.perf_counter() - started
    thread.join(timeout=5)
    assert not errors, errors
    assert hung < 10, hung
    assert inflight.status_code == 200, inflight.text
    assert inflight.json()["ok"] is False

    recovered_at = time.perf_counter()
    recovered = _post(TWO_BOX)
    recovered_s = time.perf_counter() - recovered_at
    print(f"ZYGOTE_RESTART_SECONDS={recovered_s:.3f}", flush=True)
    payload = recovered.json()
    assert payload["ok"] is True, payload
    assert {part["label"] for part in payload["parts"]} == {"base", "lid"}
    assert zygote.pid is not None
