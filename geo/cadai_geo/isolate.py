"""Resource limits, uid drop, and uid-wide reap for one geometry run.

The HTTP service and the zygote's run stages both use this. The zygote
process itself is not limited and stays single-threaded. The supervisor
calls ``setsid`` so the service can kill that process group. When the
service is root, the untrusted stage also gets its own uid, and
``reap_uid`` kills every process of that uid before the trusted stage
and before the uid is reused.
"""

from __future__ import annotations

import ctypes
import os
import resource
import signal
import subprocess
import sys

_DEFAULT_AS_LIMIT = 2 * 1024**3
_FSIZE_LIMIT = 256 * 1024 * 1024
_NPROC_LIMIT = 64
# Local pytest shares a uid that already has many tasks. Linux counts those
# tasks against RLIMIT_NPROC, so a hard 64 makes the import fail. Headroom
# stays small enough that a fork bomb still hits EAGAIN.
_NPROC_DEV_HEADROOM = 48
# OpenBLAS/OpenMP default to one thread per CPU. The zygote must stay
# single-threaded so fork is safe, and a per-run cap of 64 must survive import.
_NUMERIC_THREADS = {
    "OPENBLAS_NUM_THREADS": "1",
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "NUMEXPR_NUM_THREADS": "1",
    "VECLIB_MAXIMUM_THREADS": "1",
}
# PR_SET_DUMPABLE. A zygote child is a copy of a ~1 GB process. A core dump
# of that image is what made a SIGSEGV take many seconds. The untrusted child
# turns dumps off; the zygote itself stays dumpable so this is not inherited
# as a permanent setting of the helper.
_PR_SET_DUMPABLE = 4

# setuid to the run uid, then signal every other process of that uid.
# Exit 0 when none remain (ESRCH), 2 when a signal was delivered.
_REAP_HELPER = """
import errno, os, sys
uid = int(sys.argv[1])
gid = int(sys.argv[2])
os.setgroups([])
os.setgid(gid)
os.setuid(uid)
try:
    os.kill(-1, 9)
except OSError as exc:
    if exc.errno == errno.ESRCH:
        sys.exit(0)
    sys.exit(1)
sys.exit(2)
"""


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


def _set_both(resource_id: int, value: int) -> None:
    resource.setrlimit(resource_id, (value, value))


def _limit_and_drop(timeout_s: float, as_limit: int, account) -> None:
    _set_both(resource.RLIMIT_CORE, 0)
    _set_both(resource.RLIMIT_AS, as_limit)
    _set_both(resource.RLIMIT_CPU, int(timeout_s) + 5)
    _set_both(resource.RLIMIT_FSIZE, _FSIZE_LIMIT)
    if account is not None:
        # The run uid has no other processes, so 64 is a real cap. Set it
        # before the uid change; the value sticks to this process.
        _set_both(resource.RLIMIT_NPROC, _NPROC_LIMIT)
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
        return
    _set_both(
        resource.RLIMIT_NPROC,
        max(_NPROC_LIMIT, _uid_task_count() + _NPROC_DEV_HEADROOM),
    )


def _disable_core() -> None:
    """No core file and no dumpable flag. Call only in the untrusted child."""
    try:
        _set_both(resource.RLIMIT_CORE, 0)
    except (ValueError, OSError):
        pass
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl(_PR_SET_DUMPABLE, 0, 0, 0, 0)
    except Exception:
        pass
    for sig in (signal.SIGSEGV, signal.SIGBUS, signal.SIGFPE, signal.SIGABRT):
        try:
            signal.signal(sig, signal.SIG_DFL)
        except Exception:
            pass


def _kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def reap_uid(uid: int, gid: int) -> None:
    """Kill every process of ``uid`` until none remain.

    The helper ``setuid``s to that uid and calls ``kill(-1, SIGKILL)``.
    That signal reaches every process with that real uid except the helper.
    Repeat until the helper exits 0 (``ESRCH``). Never call this unless the
    caller is root: ``kill(-1)`` as the shared local uid would kill the
    service. A uid of 0, or this process's own uid, is ignored.
    """
    if os.geteuid() != 0:
        return
    uid = int(uid)
    gid = int(gid)
    if uid <= 0 or gid < 0 or uid == os.getuid():
        return
    for _ in range(100):
        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-c", _REAP_HELPER, str(uid), str(gid)],
                env={},
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
                close_fds=True,
            )
        except (OSError, subprocess.TimeoutExpired):
            return
        if proc.returncode == 0:
            return
        if proc.returncode != 2:
            return
