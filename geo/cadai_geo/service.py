"""HTTP sandbox around the geometry CLI.

Each ``POST /run`` writes the script into a fresh temp directory and runs
``python -I -m cadai_geo`` in a subprocess. The child gets a 2 GB address-space
limit and an environment that contains only ``PATH`` and ``HOME``, so
``CADAI_GEO_TOKEN`` never reaches the script.
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import resource
import subprocess
import sys
import tempfile

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

_AS_LIMIT = 2 * 1024**3


class RunRequest(BaseModel):
    script: str
    timeout_s: float = 60


def _authorized(header: str | None) -> bool:
    expected = os.environ.get("CADAI_GEO_TOKEN")
    if not expected or not header:
        return False
    return hmac.compare_digest(header, expected)


def _limit_address_space() -> None:
    resource.setrlimit(resource.RLIMIT_AS, (_AS_LIMIT, _AS_LIMIT))


def _child_env() -> dict[str, str]:
    return {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}


def _parse_stdout(stdout: str, stderr: str) -> dict:
    lines = [line for line in stdout.splitlines() if line.strip().startswith("{")]
    if not lines:
        err = [line.strip() for line in stderr.splitlines() if line.strip()]
        return {"ok": False, "error": err[-1] if err else "no output"}
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError:
        return {"ok": False, "error": "invalid runner output"}
    if not isinstance(payload, dict):
        return {"ok": False, "error": "invalid runner output"}
    return payload


def _inline_exports(payload: dict) -> dict:
    for key in ("stl", "step"):
        path = payload.get(key)
        if isinstance(path, str) and os.path.isfile(path):
            with open(path, "rb") as handle:
                payload[key] = base64.b64encode(handle.read()).decode("ascii")
    return payload


def _run_cli(script: str, timeout_s: float) -> dict:
    with tempfile.TemporaryDirectory(prefix="cadai-geo-") as temp_dir:
        script_path = os.path.join(temp_dir, "model.py")
        outdir = os.path.join(temp_dir, "out")
        os.makedirs(outdir)
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write(script)
        try:
            completed = subprocess.run(
                [sys.executable, "-I", "-m", "cadai_geo", script_path, outdir],
                cwd=temp_dir,
                env=_child_env(),
                capture_output=True,
                text=True,
                timeout=timeout_s,
                preexec_fn=_limit_address_space,
                start_new_session=True,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "timeout"}
        return _inline_exports(_parse_stdout(completed.stdout, completed.stderr))


@app.post("/run")
def run_route(
    body: RunRequest,
    x_cadai_geo_token: str | None = Header(default=None),
):
    if not _authorized(x_cadai_geo_token):
        raise HTTPException(status_code=401)
    return _run_cli(body.script, body.timeout_s)
