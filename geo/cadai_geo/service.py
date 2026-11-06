"""HTTP sandbox around the geometry CLI.

Each ``POST /run`` writes the script into a fresh temp directory and runs
``python -I -m cadai_geo`` in a subprocess. The service does not trust the
child's stdout. It reads ``<outdir>/result.json`` and inlines only
``model.step`` and ``model.stl`` when those are regular files inside that
directory.

The child environment is only ``PATH`` and ``HOME`` (HOME is the temp dir).
When this process is root and the ``georun`` user exists, the child drops to
that uid before exec so it cannot read the service's ``/proc/<pid>/environ``
or the token file. Resource limits and a process-group kill bound CPU, file
size, process count, and timeouts. Network egress, a read-only root, and
cgroup caps are host responsibilities; see the README.
"""

from __future__ import annotations

import base64
import hmac
import json
import os
import pwd
import resource
import signal
import stat
import subprocess
import sys
import tempfile
import threading

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from cadai_geo.run import redact

app = FastAPI()

_DEFAULT_AS_LIMIT = 2 * 1024**3
_FSIZE_LIMIT = 256 * 1024 * 1024
_NPROC_LIMIT = 64
# Local pytest shares a uid that already has many tasks. Linux counts those
# tasks against RLIMIT_NPROC, so a hard 64 makes the import fail. Headroom
# stays small enough that a fork bomb still hits EAGAIN.
_NPROC_DEV_HEADROOM = 48
# OpenBLAS/OpenMP default to one thread per CPU, which on a large host
# exceeds the georun cap of 64 during import, before the script runs.
_NUMERIC_THREADS = {
    "OPENBLAS_NUM_THREADS": "1",
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "NUMEXPR_NUM_THREADS": "1",
    "VECLIB_MAXIMUM_THREADS": "1",
}
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


def _uid_task_count() -> int:
    """Threads of this real uid. Linux ``RLIMIT_NPROC`` counts tasks."""
    uid = os.getuid()
    total = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/status", encoding="utf-8") as handle:
                text = handle.read()
        except OSError:
            continue
        real_uid = None
        threads = 1
        for line in text.splitlines():
            if line.startswith("Uid:"):
                real_uid = int(line.split()[1])
            elif line.startswith("Threads:"):
                threads = int(line.split()[1])
        if real_uid == uid:
            total += threads
    return total


def _georun():
    """Return the ``georun`` account when this process may drop to it.

    Local pytest is not root, so it cannot setuid. The container image runs
    as root (with only SETUID/SETGID kept) and does drop.
    """
    if os.geteuid() != 0:
        return None
    try:
        return pwd.getpwnam("georun")
    except KeyError:
        return False


def _set_both(resource_id: int, value: int) -> None:
    resource.setrlimit(resource_id, (value, value))


def _limit_and_drop(timeout_s: float, as_limit: int, account) -> None:
    _set_both(resource.RLIMIT_CORE, 0)
    _set_both(resource.RLIMIT_AS, as_limit)
    _set_both(resource.RLIMIT_CPU, int(timeout_s) + 5)
    _set_both(resource.RLIMIT_FSIZE, _FSIZE_LIMIT)
    if account is not None:
        # georun has no other processes, so 64 is a real cap. Set it before
        # the uid change; the value sticks to this process.
        _set_both(resource.RLIMIT_NPROC, _NPROC_LIMIT)
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
        return
    _set_both(
        resource.RLIMIT_NPROC,
        max(_NPROC_LIMIT, _uid_task_count() + _NPROC_DEV_HEADROOM),
    )


def _child_env(home: str) -> dict[str, str]:
    env = {"HOME": home, **_NUMERIC_THREADS}
    if "PATH" in os.environ:
        env["PATH"] = os.environ["PATH"]
    return env


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


def _stderr_tail(stream) -> str:
    buf = bytearray()
    while True:
        chunk = stream.read(4096)
        if not chunk:
            break
        buf += chunk
        if len(buf) > _STDERR_CAP:
            del buf[:-_STDERR_CAP]
    text = buf.decode("utf-8", errors="replace").replace("\x00", "")
    return redact(text).strip()[-_STDERR_CAP:]


def _kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


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

    def preexec() -> None:
        _limit_and_drop(timeout_s, as_limit, account)

    with tempfile.TemporaryDirectory(prefix="cadai-geo-") as temp_dir:
        script_path = os.path.join(temp_dir, "model.py")
        outdir = os.path.join(temp_dir, "out")
        os.makedirs(outdir)
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write(script)
        if account is not None:
            _give_to_georun(account, temp_dir, script_path, outdir)
        proc = subprocess.Popen(
            [sys.executable, "-I", "-m", "cadai_geo", script_path, outdir],
            cwd=temp_dir,
            env=_child_env(temp_dir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            preexec_fn=preexec,
            start_new_session=True,
        )
        assert proc.stderr is not None
        tail: dict[str, str] = {}

        def drain() -> None:
            tail["text"] = _stderr_tail(proc.stderr)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        timed_out = False
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_group(proc.pid)
            proc.wait()
        reader.join(timeout=2)
        if timed_out:
            return {"ok": False, "error": "timeout"}
        payload = _read_result(outdir)
        if payload is None:
            message = tail.get("text") or "no result"
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
