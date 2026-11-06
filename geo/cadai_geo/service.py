"""HTTP sandbox around the geometry runner.

Each ``POST /run`` writes the script into a fresh temp directory and asks the
zygote (a long-lived helper that has already imported build123d) to fork a
child. The service does not trust the child's stdout. It reads
``<outdir>/result.json`` and inlines only ``model.step`` and ``model.stl``
when those are regular files inside that directory.

The zygote is exec'd with an empty environment and never receives the token.
The forked child applies the same isolation as the CLI spawn: uid drop to
``georun`` when this process is root, rlimits, a new session, and stdout plus
stderr pointed at a file of which only the last 4 KB is kept. The service
kills that process group on timeout. ``python -I -m cadai_geo`` does not use
the zygote. Network egress, a read-only root, and cgroup caps are host
responsibilities; see the README.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import os
import pwd
import stat
import tempfile
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from cadai_geo.isolate import _DEFAULT_AS_LIMIT
from cadai_geo.run import redact
from cadai_geo.zygote import ZygoteServer

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

# Env token, remembered after it is removed from the process environment so
# /proc/<pid>/environ no longer contains it. A token file wins when set.
_cached_env_token: str | None = None
_env_token_loaded = False


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


def _scrub_env_token() -> None:
    global _cached_env_token, _env_token_loaded
    if "CADAI_GEO_TOKEN" in os.environ:
        _cached_env_token = os.environ.pop("CADAI_GEO_TOKEN")
        _env_token_loaded = True


def _expected_token() -> str | None:
    """Token from ``CADAI_GEO_TOKEN_FILE``, else the scrubbed env value."""
    global _cached_env_token, _env_token_loaded
    _scrub_env_token()
    file_path = os.environ.get("CADAI_GEO_TOKEN_FILE")
    if file_path:
        try:
            with open(file_path, encoding="utf-8") as handle:
                token = handle.read().strip()
        except OSError:
            return None
        return token or None
    if not _env_token_loaded:
        _cached_env_token = None
        _env_token_loaded = True
    return _cached_env_token or None


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
    try:
        info = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        return False
    root = os.path.realpath(outdir)
    real = os.path.realpath(path)
    try:
        inside = os.path.commonpath([real, root]) == root
    except ValueError:
        return False
    return inside and os.path.basename(real) == os.path.basename(path)


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

    with tempfile.TemporaryDirectory(prefix="cadai-geo-") as temp_dir:
        script_path = os.path.join(temp_dir, "model.py")
        outdir = os.path.join(temp_dir, "out")
        stderr_path = os.path.join(temp_dir, "stderr.txt")
        os.makedirs(outdir)
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write(script)
        os.close(os.open(stderr_path, os.O_WRONLY | os.O_CREAT, 0o600))
        if account is not None:
            _give_to_georun(account, temp_dir, script_path, outdir, stderr_path)
        request = {
            "script": script_path,
            "outdir": outdir,
            "stderr": stderr_path,
            "timeout_s": timeout_s,
            "as_limit": as_limit,
            "home": temp_dir,
        }
        path = os.environ.get("PATH")
        if path:
            request["path"] = path
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
