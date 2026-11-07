"""HTTP sandbox around the geometry runner.

Each ``POST /run`` writes the script into a fresh temp directory and asks the
zygote (a long-lived helper that has already imported build123d) to run two
stages. The untrusted stage may only write BREP into a scratch directory.
Its stdout and stderr are pipes; this process never opens a path inside a
directory the script can write. A second child loads those files, measures
them, and writes ``<outdir>/result.json`` plus ``model.step`` and
``model.stl``. The script is not given the outdir path.

When this process is root, every run gets its own uid from
``CADAI_GEO_UID_BASE`` (default 10100) for ``CADAI_GEO_CONCURRENCY`` slots
(default 4). That uid is killed entirely before the trusted stage and before
the uid is reused. The outdir is never owned by the run uid. The trusted
stage runs as ``geotrust`` when that user exists. Startup fails if a required
capability or a pool uid is missing.

Without root there is no uid split. Startup logs ``no isolation: local dev
only`` and the service still kills the supervisor's process group.

The token is read only from ``CADAI_GEO_TOKEN_FILE``. If ``CADAI_GEO_TOKEN``
is set, the process refuses to start: removing the variable from
``os.environ`` does not erase it from ``/proc/<pid>/environ``. The zygote is
exec'd with an empty environment and never receives the token or the file
path. ``python -I -m cadai_geo`` does not use the zygote. Network egress,
a read-only root, and cgroup caps are host responsibilities; see the README.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import os
import pwd
import shutil
import stat
import sys
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from cadai_geo.isolate import _DEFAULT_AS_LIMIT, reap_uid
from cadai_geo.run import redact
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

# Linux capability numbers. Checked only when this process is root.
_REQUIRED_CAPS = (
    (0, "CAP_CHOWN"),
    (1, "CAP_DAC_OVERRIDE"),
    (3, "CAP_FOWNER"),
    (5, "CAP_KILL"),
    (6, "CAP_SETGID"),
    (7, "CAP_SETUID"),
)
_CAP_LAUNCH = (
    "--cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL "
    "--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER"
)


def _concurrency() -> int:
    raw = os.environ.get("CADAI_GEO_CONCURRENCY", "")
    try:
        value = int(raw) if raw else 4
    except ValueError:
        value = 4
    return min(64, max(1, value))


def _uid_base() -> int:
    raw = os.environ.get("CADAI_GEO_UID_BASE", "")
    try:
        value = int(raw) if raw else 10100
    except ValueError:
        value = 10100
    return value


def _cap_effective() -> int:
    try:
        with open("/proc/self/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("CapEff:"):
                    return int(line.split()[1], 16)
    except (OSError, ValueError, IndexError):
        return 0
    return 0


def _missing_cap_names(mask: int | None = None) -> list[str]:
    if mask is None:
        mask = _cap_effective()
    return [name for bit, name in _REQUIRED_CAPS if not (mask & (1 << bit))]


@dataclass
class _Slot:
    account: pwd.struct_passwd | None


_ISOLATED = False
_TRUST: pwd.struct_passwd | None = None
_FREE: list[pwd.struct_passwd] = []
_SLOT_LOCK = threading.Lock()
_SLOTS = threading.Semaphore(1)


def _configure_pool() -> None:
    """Size the run slots. Root without the caps or the pool users does not start."""
    global _ISOLATED, _TRUST, _SLOTS
    slots = _concurrency()
    _SLOTS = threading.Semaphore(slots)
    if os.geteuid() != 0:
        sys.stderr.write("no isolation: local dev only\n")
        sys.stderr.flush()
        return
    missing = _missing_cap_names()
    if missing:
        sys.stderr.write(
            "refusing to start: missing Linux capabilities: "
            + ", ".join(missing)
            + ". Launch the container with "
            + _CAP_LAUNCH
            + ".\n"
        )
        raise SystemExit(1)
    base = _uid_base()
    pool: list[pwd.struct_passwd] = []
    for offset in range(slots):
        uid = base + offset
        try:
            pool.append(pwd.getpwuid(uid))
        except KeyError:
            sys.stderr.write(
                f"refusing to start: run uid {uid} does not exist "
                f"(CADAI_GEO_UID_BASE={base}, CADAI_GEO_CONCURRENCY={slots}). "
                "Create one user per run slot before starting as root.\n"
            )
            raise SystemExit(1)
    _FREE.extend(pool)
    try:
        _TRUST = pwd.getpwnam("geotrust")
    except KeyError:
        _TRUST = None
    _ISOLATED = True


_configure_pool()

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
_EXPORTS = (("step", "model.step"), ("stl", "model.stl"))


class RunRequest(BaseModel):
    script: str
    timeout_s: float = 60


class _TooLarge(Exception):
    pass


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


def _acquire_slot(deadline: float) -> _Slot | None:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return None
    if not _SLOTS.acquire(timeout=max(0.0, remaining)):
        return None
    if not _ISOLATED:
        return _Slot(None)
    with _SLOT_LOCK:
        account = _FREE.pop() if _FREE else None
    if account is None:
        _SLOTS.release()
        return None
    return _Slot(account)


def _release_slot(slot: _Slot) -> None:
    if slot.account is not None:
        with _SLOT_LOCK:
            _FREE.append(slot.account)
    _SLOTS.release()


def _open_owned_dir(path: str) -> int | None:
    """Open a real directory. A symlink is not followed."""
    try:
        return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return None


def _read_at(dir_fd: int, name: str, max_bytes: int) -> bytes | None:
    """Read a regular file under ``dir_fd``. ``None`` if it is missing or not a regular file."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return None
        if info.st_size > max_bytes:
            raise _TooLarge()
        return os.read(fd, info.st_size)
    finally:
        os.close(fd)


def _read_result(outdir: str) -> dict | None:
    dir_fd = _open_owned_dir(outdir)
    if dir_fd is None:
        return None
    try:
        try:
            raw = _read_at(dir_fd, "result.json", _MAX_RESULT_BYTES)
        except _TooLarge:
            return {"ok": False, "error": "output too large"}
        if raw is None:
            return None
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        return payload
    finally:
        os.close(dir_fd)


def _attach_exports(payload: dict, outdir: str, max_bytes: int) -> dict:
    for key, _name in _EXPORTS:
        payload.pop(key, None)
    if isinstance(payload.get("error"), str):
        payload["error"] = redact(payload["error"])
    dir_fd = _open_owned_dir(outdir)
    if dir_fd is None:
        return payload
    try:
        for key, name in _EXPORTS:
            try:
                raw = _read_at(dir_fd, name, max_bytes)
            except _TooLarge:
                return {"ok": False, "error": "output too large"}
            if raw is None:
                continue
            payload[key] = base64.b64encode(raw).decode("ascii")
        return payload
    finally:
        os.close(dir_fd)


def _give(account, *paths: str) -> None:
    for path in paths:
        os.lchown(path, account.pw_uid, account.pw_gid)


def _remove_tree(path: str) -> None:
    """Remove ``path``. A writer in the tree must not raise out of cleanup."""
    deadline = time.monotonic() + 2.0
    while True:
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.lexists(path):
            return
        if time.monotonic() >= deadline:
            shutil.rmtree(path, ignore_errors=True)
            return
        time.sleep(0.05)


def _run_cli(script: str, timeout_s: float) -> dict:
    timeout_s = clamp_timeout(timeout_s)
    deadline = time.monotonic() + timeout_s
    slot = _acquire_slot(deadline)
    if slot is None:
        return {"ok": False, "error": "timeout"}
    work: str | None = None
    outdir: str | None = None
    try:
        as_limit = _as_limit()
        max_bytes = _max_export_bytes()
        # ``work`` is the script's world (home + scratch). ``outdir`` is a
        # different directory so the script cannot derive it from argv or cwd.
        # It is never chowned to the run uid.
        work = tempfile.mkdtemp(prefix="cadai-geo-")
        outdir = tempfile.mkdtemp(prefix="cadai-geo-out-")
        os.chmod(work, 0o700)
        os.chmod(outdir, 0o700)
        home = os.path.join(work, "home")
        scratch = os.path.join(work, "scratch")
        os.makedirs(home, mode=0o700)
        os.makedirs(scratch, mode=0o700)
        os.chmod(home, 0o700)
        os.chmod(scratch, 0o700)
        script_path = os.path.join(home, "model.py")
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write(script)
        os.chmod(script_path, 0o600)
        if slot.account is not None:
            _give(slot.account, work, home, scratch, script_path)
        request = {
            "script": script_path,
            "scratch": scratch,
            "outdir": outdir,
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
        if slot.account is not None:
            request["uid"] = slot.account.pw_uid
            request["gid"] = slot.account.pw_gid
        if _TRUST is not None:
            request["trust_uid"] = _TRUST.pw_uid
            request["trust_gid"] = _TRUST.pw_gid
        outcome = zygote.execute(request, timeout_s, deadline)
        if outcome.failed:
            return {"ok": False, "error": "zygote"}
        if outcome.timed_out:
            return {"ok": False, "error": "timeout"}
        payload = _read_result(outdir)
        if payload is None:
            return {"ok": False, "error": "no result"}
        return _attach_exports(payload, outdir, max_bytes)
    except Exception as exc:
        return {"ok": False, "error": redact(f"{type(exc).__name__}: {exc}") or "sandbox"}
    finally:
        if slot.account is not None:
            reap_uid(slot.account.pw_uid, slot.account.pw_gid)
        if outdir is not None:
            _remove_tree(outdir)
        if work is not None:
            _remove_tree(work)
        _release_slot(slot)


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
