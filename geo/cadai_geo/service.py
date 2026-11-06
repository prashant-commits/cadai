"""HTTP sandbox around the geometry runner.

Each ``POST /run`` writes the script into a fresh temp directory and asks the
zygote (a long-lived helper that has already imported build123d) to run two
stages. The untrusted stage may only write BREP into a scratch directory.
A second child loads those files, measures them, and writes
``<outdir>/result.json`` plus ``model.step`` and ``model.stl``. The service
reads only that outdir. The script is not given the outdir path.

The token is read only from ``CADAI_GEO_TOKEN_FILE``. If ``CADAI_GEO_TOKEN``
is set, the process refuses to start: removing the variable from
``os.environ`` does not erase it from ``/proc/<pid>/environ``. The zygote is
exec'd with an empty environment and never receives the token or the file
path. Both stages drop to ``georun`` when this process is root, and both get
the same rlimits. The service kills the supervisor's process group on
timeout. ``python -I -m cadai_geo`` does not use the zygote. Network egress,
a read-only root, and cgroup caps are host responsibilities; see the README.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import os
import pwd
import sys
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from cadai_geo.isolate import _DEFAULT_AS_LIMIT
from cadai_geo.run import redact, regular_file_inside
from cadai_geo.zygote import ZygoteServer


def _refuse_env_token() -> None:
    """Fail closed. An environment token stays readable in /proc."""
    if "CADAI_GEO_TOKEN" in os.environ:
        sys.stderr.write(
            "refusing to start: CADAI_GEO_TOKEN is set. "
            "The token is read only from CADAI_GEO_TOKEN_FILE "
            "(mode 0400, owned by the service user). "
            "An environment value stays visible in /proc/<pid>/environ "
            "and is not accepted.\n"
        )
        raise SystemExit(1)


_refuse_env_token()

zygote = ZygoteServer()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Import build123d once at boot. /run also starts the helper if this
    # lifespan did not run (the test client does not enter it).
    await asyncio.to_thread(zygote.start_locked)
    try:
        yield
    finally:
        zygote.stop()


app = FastAPI(lifespan=_lifespan)

_MAX_EXPORT_BYTES = 64 * 1024 * 1024
_MAX_SCRIPT_BYTES = 256 * 1024
_MAX_RESULT_BYTES = 1024 * 1024
_STDERR_CAP = 4096
_EXPORTS = (("step", "model.step"), ("stl", "model.stl"))

class RunRequest(BaseModel):
    script: str
    timeout_s: float = 60


def clamp_timeout(value: float) -> float:
    """Clamp a caller-supplied timeout into ``[1, 120]`` seconds."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 60.0
    if number < 1:
        return 1.0
    if number > 120:
        return 120.0
    return number


def _expected_token() -> str | None:
    """Token from ``CADAI_GEO_TOKEN_FILE`` only. Missing or empty fails closed."""
    file_path = os.environ.get("CADAI_GEO_TOKEN_FILE")
    if not file_path:
        return None
    try:
        with open(file_path, encoding="utf-8") as handle:
            token = handle.read().strip()
    except OSError:
        return None
    return token or None


def _authorized(header: str | None) -> bool:
    expected = _expected_token()
    if not expected or not header:
        return False
    return hmac.compare_digest(header, expected)


def _as_limit() -> int:
    raw = os.environ.get("CADAI_GEO_RLIMIT_AS")
    if not raw:
        return _DEFAULT_AS_LIMIT
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_AS_LIMIT
    return max(64 * 1024 * 1024, value)


def _max_export_bytes() -> int:
    raw = os.environ.get("CADAI_GEO_MAX_EXPORT_BYTES")
    if not raw:
        return _MAX_EXPORT_BYTES
    try:
        value = int(raw)
    except ValueError:
        return _MAX_EXPORT_BYTES
    return max(1, value)


def _georun():
    """Return the ``georun`` account when this process may drop to it.

    Local pytest is not root, so it cannot setuid. The container image runs
    as root (with only SETUID/SETGID kept) and the forked child drops.
    """
    if os.geteuid() != 0:
        return None
    try:
        return pwd.getpwnam("georun")
    except KeyError:
        return False


def _regular_inside(path: str, outdir: str) -> bool:
    return regular_file_inside(path, outdir)


def _stderr_tail_file(path: str) -> str:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - _STDERR_CAP))
            data = handle.read(_STDERR_CAP)
    except OSError:
        return ""
    text = data.decode("utf-8", errors="replace").replace("\x00", "")
    return redact(text).strip()[-_STDERR_CAP:]


def _read_result(outdir: str) -> dict | None:
    path = os.path.join(outdir, "result.json")
    if not _regular_inside(path, outdir):
        return None
    if os.path.getsize(path) > _MAX_RESULT_BYTES:
        return {"ok": False, "error": "output too large"}
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def _attach_exports(payload: dict, outdir: str, max_bytes: int) -> dict:
    for key, _name in _EXPORTS:
        payload.pop(key, None)
    if isinstance(payload.get("error"), str):
        payload["error"] = redact(payload["error"])
    for key, name in _EXPORTS:
        path = os.path.join(outdir, name)
        if not _regular_inside(path, outdir):
            continue
        if os.path.getsize(path) > max_bytes:
            return {"ok": False, "error": "output too large"}
        with open(path, "rb") as handle:
            payload[key] = base64.b64encode(handle.read()).decode("ascii")
    return payload


def _give_to_georun(account, *paths: str) -> None:
    for path in paths:
        os.chown(path, account.pw_uid, account.pw_gid)


def _run_cli(script: str, timeout_s: float) -> dict:
    account = _georun()
    if account is False:
        return {"ok": False, "error": "georun user is missing"}
    timeout_s = clamp_timeout(timeout_s)
    as_limit = _as_limit()
    max_bytes = _max_export_bytes()

    # ``work`` is the script's world (home + scratch). ``outdir`` is a
    # different directory so the script cannot derive it from argv or cwd.
    # It stays owned by the service uid until the untrusted stage has exited.
    with tempfile.TemporaryDirectory(prefix="cadai-geo-") as work:
        with tempfile.TemporaryDirectory(prefix="cadai-geo-out-") as outdir:
            home = os.path.join(work, "home")
            scratch = os.path.join(work, "scratch")
            os.makedirs(home, mode=0o700)
            os.makedirs(scratch, mode=0o700)
            os.chmod(home, 0o700)
            os.chmod(scratch, 0o700)
            os.chmod(outdir, 0o700)
            script_path = os.path.join(home, "model.py")
            stderr_path = os.path.join(work, "stderr.txt")
            with open(script_path, "w", encoding="utf-8") as handle:
                handle.write(script)
            os.close(os.open(stderr_path, os.O_WRONLY | os.O_CREAT, 0o600))
            if account is not None:
                _give_to_georun(account, work, home, scratch, script_path, stderr_path)
            request = {
                "script": script_path,
                "scratch": scratch,
                "outdir": outdir,
                "stderr": stderr_path,
                "timeout_s": timeout_s,
                "as_limit": as_limit,
                "home": home,
            }
            path = os.environ.get("PATH")
            if path:
                request["path"] = path
            tmpdir = os.environ.get("TMPDIR")
            if tmpdir:
                request["tmpdir"] = tmpdir
            if account is not None:
                request["uid"] = account.pw_uid
                request["gid"] = account.pw_gid
            outcome = zygote.execute(request, timeout_s)
            if outcome.failed:
                return {"ok": False, "error": "zygote"}
            if outcome.timed_out:
                return {"ok": False, "error": "timeout"}
            payload = _read_result(outdir)
            if payload is None:
                message = _stderr_tail_file(stderr_path) or "no result"
                return {"ok": False, "error": message or "no result"}
            return _attach_exports(payload, outdir, max_bytes)


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/run")
def run_route(
    body: RunRequest,
    x_cadai_geo_token: str | None = Header(default=None),
):
    if not _authorized(x_cadai_geo_token):
        raise HTTPException(status_code=401)
    if len(body.script.encode("utf-8")) > _MAX_SCRIPT_BYTES:
        raise HTTPException(status_code=413, detail="script too large")
    return _run_cli(body.script, body.timeout_s)
