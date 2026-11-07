"""Pre-warmed fork server for the geometry service.

The service execs this module with an empty environment, so the process
never sees ``CADAI_GEO_TOKEN`` or ``CADAI_GEO_TOKEN_FILE``. It imports
build123d once (after pinning numeric libraries to one thread, which keeps
the process single-threaded and makes ``fork`` safe). The accept loop forks
one supervisor per run and reaps it later, so runs overlap.

The supervisor calls ``setsid`` so the service can kill that process group.
It then forks:

* untrusted — runs the script. Stdout and stderr are pipes owned by the
  supervisor, capped in memory. The script may write only BREP into scratch.
* trusted — reads that scratch directory, measures the shapes, and writes
  ``result.json``, ``model.step``, and ``model.stl`` into the service outdir.

When the service is root the untrusted stage setuids to a per-run uid. The
supervisor kills every process of that uid before the trusted stage. The
trusted stage setuids to ``geotrust`` when that account was passed, and the
outdir is never chowned to the run uid. Without root both stages stay the
service uid; the process-group kill is the only reaping.

``python -I -m cadai_geo`` is unchanged and does not use this server. That
CLI measures in-process; it is the local tool, not this sandbox.
"""

from __future__ import annotations

import atexit
import json
import os
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from types import SimpleNamespace

from cadai_geo.isolate import (
    _NUMERIC_THREADS,
    _disable_core,
    _kill_group,
    _limit_and_drop,
    reap_uid,
)
from cadai_geo.run import (
    _test_full_builtins_requested,
    _exit_message,
    _remember_compound_sources,
    capture_geometry,
    measure_and_export,
    redact,
    write_result,
)

_READY_TIMEOUT_S = 120.0
_SECRET_ENV = ("CADAI_GEO_TOKEN", "CADAI_GEO_TOKEN_FILE")
_ARGV0 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "__main__.py")
# Written by our exception handler after the script returns. A script that
# exits first does not know to write this, so its stdout is not an error.
_ERROR_MARK = b"cadaiexcept\n"
_STREAM_CAP = 8192
_ACCEPT_TIMEOUT_S = 0.05


@dataclass
class ZygoteRun:
    timed_out: bool = False
    failed: bool = False


@dataclass
class _Inflight:
    sock: socket.socket
    reader: "_LineReader"
    pid: int


class ZygoteServer:
    """Client side: start the helper, restart it, and dispatch one run."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active_lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._sock: str | None = None
        self._dir: str | None = None
        self._drain: threading.Thread | None = None
        self._active: set[int] = set()
        self._atexit = False

    @property
    def pid(self) -> int | None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return None
        return proc.pid

    @property
    def active_pid(self) -> int | None:
        """One in-flight supervisor, if any. The kill test only needs one."""
        with self._active_lock:
            if not self._active:
                return None
            return next(iter(self._active))

    def start_locked(self) -> None:
        """Boot hook. Takes the lock; ``start`` itself assumes the caller holds it."""
        with self._lock:
            self.start()

    def start(self) -> None:
        """Start the helper if it is not already running. Caller holds ``_lock``."""
        if self.pid is not None:
            return
        self._mark_dead()
        if not self._atexit:
            atexit.register(self.stop)
            self._atexit = True
        directory = tempfile.mkdtemp(prefix="cadai-geo-zygote-")
        os.chmod(directory, 0o700)
        sock_path = os.path.join(directory, "zygote.sock")
        # exec, not a Python fork of the service: a fork would keep the
        # token in this process's address space. env is empty on purpose.
        argv = [sys.executable, "-I", "-m", "cadai_geo.zygote", sock_path]
        # Test-only: the b1 sandbox probes need full builtins in the script (see run._FULL_BUILTINS).
        # It travels as an argument because the zygote's environment is empty on purpose.
        if _test_full_builtins_requested():
            argv.append("--test-full-builtins")
        proc = subprocess.Popen(
            argv,
            env={},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        assert proc.stdout is not None and proc.stderr is not None
        stderr_buf = bytearray()

        def drain() -> None:
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                stderr_buf.extend(chunk)
                if len(stderr_buf) > 8192:
                    del stderr_buf[:-8192]

        drain_thread = threading.Thread(target=drain, daemon=True)
        drain_thread.start()
        self._proc = proc
        self._sock = sock_path
        self._dir = directory
        self._drain = drain_thread
        try:
            self._wait_ready(proc, _READY_TIMEOUT_S)
            self._ping()
        except Exception:
            detail = redact(stderr_buf.decode("utf-8", errors="replace")[-500:])
            self._mark_dead()
            raise RuntimeError(detail or "zygote did not become ready") from None

    def stop(self) -> None:
        with self._lock:
            self._mark_dead()

    def execute(self, request: dict, timeout_s: float, deadline: float | None = None) -> ZygoteRun:
        """Run one request. The lock covers startup and the pid handshake only.

        ``deadline`` is monotonic time. The wait for the run ends then, so a
        request that sat behind another run still times out on its own clock.
        """
        if deadline is None:
            deadline = time.monotonic() + float(timeout_s)
        try:
            begun = self._begin(request, deadline)
        except Exception as exc:
            sys.stderr.write(f"zygote: {redact(str(exc))}\n")
            with self._lock:
                self._mark_dead()
            return ZygoteRun(failed=True)
        if isinstance(begun, ZygoteRun):
            return begun
        return self._finish(begun, deadline)

    def _note_active(self, pid: int) -> None:
        with self._active_lock:
            self._active.add(pid)

    def _drop_active(self, pid: int) -> None:
        with self._active_lock:
            self._active.discard(pid)

    def _clear_active(self) -> None:
        with self._active_lock:
            self._active.clear()

    def _wait_ready(self, proc: subprocess.Popen, timeout_s: float) -> None:
        assert proc.stdout is not None
        fd = proc.stdout.fileno()
        os.set_blocking(fd, False)
        deadline = time.monotonic() + timeout_s
        data = b""
        while time.monotonic() < deadline:
            if proc.poll() is not None and not data:
                break
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable:
                try:
                    chunk = os.read(fd, 4096)
                except BlockingIOError:
                    chunk = b""
                if chunk:
                    data += chunk
                    if b"\n" in data:
                        line = data.splitlines()[0]
                        if b'"ready"' in line:
                            return
            if proc.poll() is not None:
                break
        raise RuntimeError("zygote did not become ready")

    def _ping(self) -> None:
        assert self._sock is not None
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.connect(self._sock)
            sock.sendall(b'{"ping":true}\n')
            reader = _LineReader(sock)
            message = json.loads(reader.read(10))
        finally:
            sock.close()
        if not message.get("pong"):
            raise RuntimeError("zygote ping failed")

    def _begin(self, request: dict, deadline: float) -> ZygoteRun | _Inflight:
        """Start the helper if needed and read the supervisor pid. Caller is unlocked after return."""
        sock: socket.socket | None = None
        try:
            with self._lock:
                if time.monotonic() >= deadline:
                    return ZygoteRun(timed_out=True)
                if self.pid is None:
                    self.start()
                if time.monotonic() >= deadline:
                    return ZygoteRun(timed_out=True)
                try:
                    sock = self._connect()
                except OSError:
                    self._mark_dead()
                    return ZygoteRun(failed=True)
                sock.sendall(json.dumps(request).encode("utf-8") + b"\n")
                reader = _LineReader(sock)
                try:
                    first = json.loads(reader.read(30))
                except (TimeoutError, EOFError, OSError, json.JSONDecodeError):
                    self._mark_dead()
                    sock.close()
                    sock = None
                    return ZygoteRun(failed=True)
                pid = first.get("pid")
                if not isinstance(pid, int):
                    self._mark_dead()
                    sock.close()
                    sock = None
                    return ZygoteRun(failed=True)
                self._note_active(pid)
                inflight = _Inflight(sock, reader, pid)
                sock = None
                return inflight
        finally:
            if sock is not None:
                sock.close()

    def _finish(self, inflight: _Inflight, deadline: float) -> ZygoteRun:
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _kill_group(inflight.pid)
                try:
                    inflight.reader.read(2)
                except (TimeoutError, EOFError, OSError):
                    pass
                return ZygoteRun(timed_out=True)
            try:
                inflight.reader.read(remaining)
            except TimeoutError:
                _kill_group(inflight.pid)
                try:
                    inflight.reader.read(2)
                except (TimeoutError, EOFError, OSError):
                    pass
                return ZygoteRun(timed_out=True)
            except (EOFError, OSError):
                _kill_group(inflight.pid)
                with self._lock:
                    self._mark_dead()
                return ZygoteRun(failed=True)
            return ZygoteRun()
        finally:
            self._drop_active(inflight.pid)
            try:
                inflight.sock.close()
            except OSError:
                pass

    def _connect(self) -> socket.socket:
        assert self._sock is not None
        last: Exception | None = None
        for _ in range(50):
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.connect(self._sock)
                return sock
            except OSError as exc:
                last = exc
                sock.close()
                time.sleep(0.02)
        raise last or OSError("zygote connect failed")

    def _mark_dead(self) -> None:
        """Drop the helper. Caller holds ``_lock``."""
        proc = self._proc
        self._proc = None
        self._sock = None
        self._clear_active()
        if proc is not None and proc.poll() is None:
            proc.kill()
        if proc is not None:
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
        directory = self._dir
        self._dir = None
        if directory:
            shutil.rmtree(directory, ignore_errors=True)


class _LineReader:
    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._buf = b""

    def read(self, timeout_s: float) -> bytes:
        self._sock.settimeout(timeout_s)
        while b"\n" not in self._buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise EOFError
            self._buf += chunk
            if len(self._buf) > 65536:
                raise OSError("zygote message too long")
        line, _, rest = self._buf.partition(b"\n")
        self._buf = rest
        return line


def _warm() -> None:
    for key, value in _NUMERIC_THREADS.items():
        os.environ[key] = value
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    _remember_compound_sources()
    from build123d import export_brep, export_step, export_stl, import_brep  # noqa: F401


def _redirect_to(write_fd: int) -> None:
    """Point stdin at ``/dev/null`` and stdout/stderr at an existing pipe fd."""
    null_fd = os.open(os.devnull, os.O_RDONLY)
    try:
        os.dup2(null_fd, 0)
        os.dup2(write_fd, 1)
        os.dup2(write_fd, 2)
    finally:
        os.close(null_fd)
    if write_fd > 2:
        os.close(write_fd)


def _redirect_devnull() -> None:
    null_in = os.open(os.devnull, os.O_RDONLY)
    null_out = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(null_in, 0)
        os.dup2(null_out, 1)
        os.dup2(null_out, 2)
    finally:
        os.close(null_in)
        os.close(null_out)


def _close_extra_fds(keep: set[int] | None = None) -> None:
    kept = keep or set()
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd > 2 and fd not in kept:
            try:
                os.close(fd)
            except OSError:
                pass


def _apply_child_env(request: dict, home: str, tmpdir: str | None = None) -> None:
    path = request.get("path") or ""
    if tmpdir is None:
        tmpdir = request.get("tmpdir") or ""
    os.environ.clear()
    os.environ["HOME"] = home
    if path:
        os.environ["PATH"] = path
    if tmpdir:
        os.environ["TMPDIR"] = tmpdir
    os.environ.update(_NUMERIC_THREADS)


def _account(request: dict):
    if request.get("uid") is not None and request.get("gid") is not None:
        return SimpleNamespace(pw_uid=int(request["uid"]), pw_gid=int(request["gid"]))
    return None


def _trust_account(request: dict):
    if request.get("trust_uid") is None or request.get("trust_gid") is None:
        return None
    return SimpleNamespace(pw_uid=int(request["trust_uid"]), pw_gid=int(request["trust_gid"]))


def _emit_error(write_fd: int, message: str) -> None:
    try:
        os.write(write_fd, _ERROR_MARK + redact(message).encode("utf-8") + b"\n")
    except OSError:
        pass


def _read_pipe(fd: int, cap: int) -> bytes:
    chunks = []
    total = 0
    while total < cap:
        try:
            data = os.read(fd, min(4096, cap - total))
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
        total += len(data)
    return b"".join(chunks)


def _read_marked(fd: int) -> str:
    raw = _read_pipe(fd, _STREAM_CAP)
    if _ERROR_MARK not in raw:
        return ""
    text = raw.rsplit(_ERROR_MARK, 1)[1].decode("utf-8", errors="replace")
    return redact(text).strip()[:4096]


def _captured_error(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace").replace("\x00", "")
    # The script's own stderr cannot carry the line-number prefix (run.split_error_line):
    # only capture_geometry's error path sets one.
    return redact(text).strip()[:4096].replace("\u241f", "\ufffd")


def _drain_stream(read_fd: int, write_fd: int, cap: int) -> None:
    """Copy at most ``cap`` bytes, discarding the rest so the writer cannot block."""
    kept = bytearray()
    while True:
        try:
            chunk = os.read(read_fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        if len(kept) < cap:
            kept += chunk[: cap - len(kept)]
    try:
        if kept:
            os.write(write_fd, bytes(kept))
    except OSError:
        pass


def _kill_peers() -> None:
    """SIGKILL every other member of this process group (leftover grandchildren)."""
    me = os.getpid()
    pgid = os.getpgrp()
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == me:
            continue
        try:
            if os.getpgid(pid) == pgid:
                os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    while True:
        try:
            found, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if found == 0:
            break


def _chown_tree(path: str, uid: int, gid: int) -> None:
    """``lchown`` a tree. Symlinks are not followed, so a planted link is not a chown of the target."""
    try:
        os.lchown(path, uid, gid)
    except OSError:
        return
    if os.path.islink(path):
        return
    try:
        info = os.lstat(path)
    except OSError:
        return
    if not stat.S_ISDIR(info.st_mode):
        return
    try:
        names = os.listdir(path)
    except OSError:
        return
    for name in names:
        _chown_tree(os.path.join(path, name), uid, gid)


def _run_untrusted(request: dict, err_fd: int, out_fd: int) -> None:
    """Script stage. argv is ``(program, script, scratch)`` — never the outdir."""
    try:
        _disable_core()
        _limit_and_drop(float(request["timeout_s"]), int(request["as_limit"]), _account(request))
        _redirect_to(out_fd)
        _close_extra_fds({err_fd})
        _apply_child_env(request, request["home"])
        sys.argv = [request.get("argv0") or _ARGV0, request["script"], request["scratch"]]
        os.chdir(request["home"])
        capture_geometry(
            request["script"],
            request["scratch"],
            lambda message: _emit_error(err_fd, message),
        )
    except SystemExit as exc:
        _emit_error(err_fd, _exit_message(exc))
    except Exception as exc:
        _emit_error(err_fd, f"{type(exc).__name__}: {exc}")
    os._exit(0)


def _run_trusted(request: dict) -> None:
    """Measure stage. Reads scratch, writes the service outdir, never runs the script.

    Drops to the trust uid when one was given. It does not drop to the run uid,
    and its home directory is the outdir rather than the script's home.
    """
    try:
        _limit_and_drop(float(request["timeout_s"]), int(request["as_limit"]), _trust_account(request))
        _redirect_devnull()
        _close_extra_fds()
        outdir = request["outdir"]
        _apply_child_env(request, outdir, tmpdir=outdir)
        os.chdir(outdir)
        payload = measure_and_export(
            request["scratch"],
            outdir,
            request.get("fallback_error") or None,
        )
        try:
            write_result(outdir, payload)
        except OSError:
            try:
                write_result(outdir, {"ok": False, "error": "result file"})
            except OSError:
                pass
    except Exception:
        try:
            write_result(request["outdir"], {"ok": False, "error": "measure"})
        except Exception:
            pass
    os._exit(0)


def _supervise(request: dict) -> None:
    """One run. ``setsid`` is first so a timeout kill hits this group and not the zygote.

    Stdout and stderr of the untrusted stage are pipes. Nothing in the script's
    directories is opened to recover an error. On a signal, this process (the
    service uid) writes ``result.json`` itself after the run uid has been reaped.
    """
    os.setsid()
    _close_extra_fds()
    tmpdir = request.get("tmpdir")
    if tmpdir:
        os.environ["TMPDIR"] = tmpdir
    request.pop("stderr", None)
    request.pop("fallback_error", None)
    err_r, err_w = os.pipe()
    out_r, out_w = os.pipe()
    cap_r, cap_w = os.pipe()
    drain = os.fork()
    if drain == 0:
        try:
            os.close(err_r)
            os.close(err_w)
            os.close(out_w)
            os.close(cap_r)
            _drain_stream(out_r, cap_w, _STREAM_CAP)
        finally:
            os._exit(0)
    untrusted = os.fork()
    if untrusted == 0:
        try:
            os.close(err_r)
            os.close(out_r)
            os.close(cap_r)
            os.close(cap_w)
            _run_untrusted(request, err_w, out_w)
        finally:
            os._exit(0)
    os.close(err_w)
    os.close(out_w)
    os.close(cap_w)
    os.close(out_r)
    try:
        _pid, status = os.waitpid(untrusted, 0)
    except ChildProcessError:
        status = 0
    try:
        os.waitpid(drain, 0)
    except ChildProcessError:
        pass
    captured = _captured_error(_read_pipe(cap_r, _STREAM_CAP))
    os.close(cap_r)
    fallback = _read_marked(err_r)
    os.close(err_r)
    account = _account(request)
    if account is not None:
        reap_uid(account.pw_uid, account.pw_gid)
    _kill_peers()
    if os.WIFSIGNALED(status):
        try:
            write_result(request["outdir"], {"ok": False, "error": "script crashed"})
        except OSError:
            pass
        os._exit(0)
    if account is not None:
        reap_uid(account.pw_uid, account.pw_gid)
    text = fallback or captured
    if text:
        request["fallback_error"] = text
    trust = _trust_account(request)
    if trust is not None:
        _chown_tree(request["scratch"], trust.pw_uid, trust.pw_gid)
        try:
            os.lchown(request["outdir"], trust.pw_uid, trust.pw_gid)
            os.chmod(request["outdir"], 0o700)
        except OSError:
            pass
    trusted = os.fork()
    if trusted == 0:
        try:
            _run_trusted(request)
        finally:
            os._exit(0)
    try:
        os.waitpid(trusted, 0)
    except ChildProcessError:
        pass
    os._exit(0)


def _run_supervisor(request: dict) -> None:
    try:
        _supervise(request)
    except Exception:
        try:
            write_result(request["outdir"], {"ok": False, "error": "no result"})
        except Exception:
            pass
    os._exit(0)


def _write_message(conn: socket.socket, payload: dict) -> None:
    try:
        conn.sendall(json.dumps(payload).encode("utf-8") + b"\n")
    except OSError:
        pass


def _read_request(conn: socket.socket) -> dict | None:
    data = b""
    while b"\n" not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return None
        data += chunk
        if len(data) > 65536:
            return None
    try:
        message = json.loads(data.split(b"\n", 1)[0])
    except json.JSONDecodeError:
        return None
    if not isinstance(message, dict):
        return None
    return message


def _reject_secrets(request: dict) -> bool:
    for key in request:
        upper = str(key).upper()
        if "TOKEN" in upper:
            return True
    return False


def _reap(inflight: dict[int, socket.socket]) -> None:
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return
        conn = inflight.pop(pid, None)
        if conn is None:
            continue
        _write_message(conn, {"exit": 0})
        try:
            conn.close()
        except OSError:
            pass


def _dispatch(conn: socket.socket, inflight: dict[int, socket.socket]) -> None:
    try:
        conn.settimeout(30)
        try:
            request = _read_request(conn)
        except (TimeoutError, OSError):
            conn.close()
            return
        conn.settimeout(None)
        if request is None:
            conn.close()
            return
        if request.get("ping") is True:
            _write_message(conn, {"pong": True})
            conn.close()
            return
        if (
            _reject_secrets(request)
            or "script" not in request
            or "outdir" not in request
            or "scratch" not in request
        ):
            _write_message(conn, {"error": "bad request"})
            conn.close()
            return
        _reap(inflight)
        pid = os.fork()
    except Exception:
        try:
            conn.close()
        except OSError:
            pass
        return
    if pid == 0:
        try:
            _run_supervisor(request)
        finally:
            os._exit(0)
    inflight[pid] = conn
    _write_message(conn, {"pid": pid})


def serve(sock_path: str) -> None:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(sock_path)
    os.chmod(sock_path, 0o600)
    listener.listen(16)
    sys.stdout.write('{"ready":true}\n')
    sys.stdout.flush()
    null_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null_fd, 1)
    os.close(null_fd)
    # PR_SET_PDEATHSIG fires when the creating thread exits, which is the
    # request worker, not the service process. Watch the parent pid instead.
    # Reap finished supervisors from this loop. A second thread would make
    # fork unsafe. TimeoutError is a subclass of OSError; catch it first.
    parent = os.getppid()
    inflight: dict[int, socket.socket] = {}
    listener.settimeout(_ACCEPT_TIMEOUT_S)
    while os.getppid() == parent:
        _reap(inflight)
        try:
            conn, _addr = listener.accept()
        except TimeoutError:
            continue
        except InterruptedError:
            continue
        except OSError:
            break
        _dispatch(conn, inflight)
    _reap(inflight)


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv if argv is None else argv)
    if any(name in os.environ for name in _SECRET_ENV):
        sys.stderr.write("zygote: refusing to start with a token in the environment\n")
        sys.exit(1)
    if len(args) == 3 and args[2] == "--test-full-builtins":
        from cadai_geo import run as run_module

        run_module._FULL_BUILTINS = True
        sys.stderr.write("zygote: --test-full-builtins, scripts get full builtins (tests only)\n")
        args = args[:2]
    if len(args) != 2:
        sys.stderr.write("usage: python -m cadai_geo.zygote <socket>\n")
        sys.exit(2)
    _warm()
    serve(args[1])


if __name__ == "__main__":
    main()
