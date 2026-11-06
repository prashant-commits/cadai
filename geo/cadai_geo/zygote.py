"""Pre-warmed fork server for the geometry service.

The service execs this module with an empty environment, so the process
never sees ``CADAI_GEO_TOKEN``. It imports build123d once (after pinning
numeric libraries to one thread, which keeps the process single-threaded
and makes ``fork`` safe). Each run is a child of that process: the child
calls ``setsid``, applies the same rlimits and uid drop as a fresh CLI
spawn, redirects stdout and stderr to the service's file, and runs the
script. The service, not this process, enforces the wall-clock timeout by
killing the child's process group.

``python -I -m cadai_geo`` is unchanged and does not use this server.
"""

from __future__ import annotations

import atexit
import json
import os
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from types import SimpleNamespace

from cadai_geo.isolate import _NUMERIC_THREADS, _kill_group, _limit_and_drop
from cadai_geo.run import _remember_compound_sources, redact, run, write_result

_READY_TIMEOUT_S = 120.0
_SECRET_ENV = ("CADAI_GEO_TOKEN", "CADAI_GEO_TOKEN_FILE")
_ARGV0 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "__main__.py")


@dataclass
class ZygoteRun:
    timed_out: bool = False
    failed: bool = False


class ZygoteServer:
    """Client side: start the helper, restart it, and dispatch one run."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._sock: str | None = None
        self._dir: str | None = None
        self._drain: threading.Thread | None = None
        self.active_pid: int | None = None
        self._atexit = False

    @property
    def pid(self) -> int | None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return None
        return proc.pid

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
        proc = subprocess.Popen(
            [sys.executable, "-I", "-m", "cadai_geo.zygote", sock_path],
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

    def execute(self, request: dict, timeout_s: float) -> ZygoteRun:
        with self._lock:
            try:
                if self.pid is None:
                    self.start()
                return self._exchange(request, timeout_s)
            except Exception as exc:
                sys.stderr.write(f"zygote: {redact(str(exc))}\n")
                self._mark_dead()
                return ZygoteRun(failed=True)

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

    def _exchange(self, request: dict, timeout_s: float) -> ZygoteRun:
        assert self._sock is not None
        try:
            sock = self._connect()
        except OSError:
            self._mark_dead()
            return ZygoteRun(failed=True)
        try:
            sock.sendall(json.dumps(request).encode("utf-8") + b"\n")
            reader = _LineReader(sock)
            try:
                first = json.loads(reader.read(30))
            except (TimeoutError, EOFError, OSError, json.JSONDecodeError):
                self._mark_dead()
                return ZygoteRun(failed=True)
            pid = first.get("pid")
            if not isinstance(pid, int):
                self._mark_dead()
                return ZygoteRun(failed=True)
            self.active_pid = pid
            try:
                try:
                    reader.read(timeout_s)
                except TimeoutError:
                    _kill_group(pid)
                    try:
                        reader.read(2)
                    except (TimeoutError, EOFError, OSError):
                        pass
                    return ZygoteRun(timed_out=True)
                except (EOFError, OSError):
                    _kill_group(pid)
                    self._mark_dead()
                    return ZygoteRun(failed=True)
            finally:
                self.active_pid = None
            return ZygoteRun()
        finally:
            sock.close()

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
        proc = self._proc
        self._proc = None
        self._sock = None
        self.active_pid = None
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
    from build123d import export_step, export_stl  # noqa: F401


def _redirect(stderr_path: str) -> None:
    null_fd = os.open(os.devnull, os.O_RDONLY)
    log_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.dup2(null_fd, 0)
    os.dup2(log_fd, 1)
    os.dup2(log_fd, 2)
    os.close(null_fd)
    os.close(log_fd)


def _close_extra_fds() -> None:
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        if fd > 2:
            try:
                os.close(fd)
            except OSError:
                pass


def _apply_child_env(request: dict) -> None:
    home = request["home"]
    path = request.get("path") or ""
    os.environ.clear()
    os.environ["HOME"] = home
    if path:
        os.environ["PATH"] = path
    os.environ.update(_NUMERIC_THREADS)


def _run_child(request: dict) -> None:
    os.setsid()
    account = None
    if request.get("uid") is not None and request.get("gid") is not None:
        account = SimpleNamespace(pw_uid=int(request["uid"]), pw_gid=int(request["gid"]))
    try:
        _limit_and_drop(float(request["timeout_s"]), int(request["as_limit"]), account)
        _redirect(request["stderr"])
        _close_extra_fds()
        _apply_child_env(request)
        sys.argv = [request.get("argv0") or _ARGV0, request["script"], request["outdir"]]
        os.chdir(request["home"])
        payload = run(request["script"], request["outdir"])
        try:
            write_result(request["outdir"], payload)
        except OSError:
            try:
                write_result(request["outdir"], {"ok": False, "error": "result file"})
            except OSError:
                pass
    except Exception as exc:
        try:
            write_result(
                request["outdir"],
                {"ok": False, "error": redact(f"{type(exc).__name__}: {exc}")},
            )
        except Exception:
            pass
    os._exit(0)


def _write_message(conn: socket.socket, payload: dict) -> None:
    try:
        conn.sendall(json.dumps(payload).encode("utf-8") + b"\n")
    except BrokenPipeError:
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


def _handle(conn: socket.socket, listener: socket.socket) -> None:
    request = _read_request(conn)
    if request is None:
        return
    if request.get("ping") is True:
        _write_message(conn, {"pong": True})
        return
    if _reject_secrets(request) or "script" not in request or "outdir" not in request:
        _write_message(conn, {"error": "bad request"})
        return
    pid = os.fork()
    if pid == 0:
        try:
            conn.close()
            listener.close()
            _run_child(request)
        finally:
            os._exit(1)
    _write_message(conn, {"pid": pid})
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    _write_message(conn, {"exit": 0})


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
    parent = os.getppid()
    listener.settimeout(1.0)
    while os.getppid() == parent:
        try:
            conn, _addr = listener.accept()
        except TimeoutError:
            continue
        except OSError:
            break
        try:
            _handle(conn, listener)
        finally:
            conn.close()


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv if argv is None else argv)
    if any(name in os.environ for name in _SECRET_ENV):
        sys.stderr.write("zygote: refusing to start with a token in the environment\n")
        sys.exit(1)
    if len(args) != 2:
        sys.stderr.write("usage: python -m cadai_geo.zygote <socket>\n")
        sys.exit(2)
    _warm()
    serve(args[1])


if __name__ == "__main__":
    main()
