"""Resource limits and uid drop for one geometry run.

The HTTP service and the zygote's run stages both use this. The zygote
process itself is not limited. The supervisor calls ``setsid`` so the
service can kill that process group; each stage then applies these limits.
"""

from __future__ import annotations

import os
import resource
import signal

_DEFAULT_AS_LIMIT = 2 * 1024**3
_FSIZE_LIMIT = 256 * 1024 * 1024
_NPROC_LIMIT = 64
# Local pytest shares a uid that already has many tasks. Linux counts those
# tasks against RLIMIT_NPROC, so a hard 64 makes the import fail. Headroom
# stays small enough that a fork bomb still hits EAGAIN.
_NPROC_DEV_HEADROOM = 48
# OpenBLAS/OpenMP default to one thread per CPU. The zygote must stay
# single-threaded so fork is safe, and a georun cap of 64 must survive import.
_NUMERIC_THREADS = {
    "OPENBLAS_NUM_THREADS": "1",
    "OMP_NUM_THREADS": "1",
    "MKL_NUM_THREADS": "1",
    "NUMEXPR_NUM_THREADS": "1",
    "VECLIB_MAXIMUM_THREADS": "1",
}


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


def _kill_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
