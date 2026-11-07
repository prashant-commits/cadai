"""Sandbox exploits from the b1 security review. Probes lived in b1-fable/."""

import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

import pytest
from fastapi.testclient import TestClient

from cadai_geo.service import app, clamp_timeout

TOKEN = "test-token"
HEADERS = {"x-cadai-geo-token": TOKEN}
client = TestClient(app)

# The stdout-spoof probe (svc_spoof.py / spoof_model.py).
_SPOOF = (
    "import os\n"
    "os.write(1, b'{\"ok\": true, \"parts\": [{\"label\": \"pwn\"}], \"solids\": 1, "
    "\"bbox\": {\"min\": [0, 0, 0], \"max\": [1, 1, 1]}, "
    "\"stl\": \"/etc/hostname\", \"step\": \"/etc/hostname\"}\\n')\n"
    "os._exit(0)\n"
)


def _hostname() -> bytes:
    with open("/etc/hostname", "rb") as handle:
        return handle.read().strip()


def _foreign_file_absent(payload: dict) -> None:
    host = _hostname()
    body = json.dumps(payload)
    assert host.decode(errors="replace") not in body
    for key in ("step", "stl"):
        value = payload.get(key)
        if isinstance(value, str):
            assert host not in base64.b64decode(value)


def test_stdout_spoof_cannot_exfiltrate_file():
    response = client.post("/run", json={"script": _SPOOF}, headers=HEADERS)
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    _foreign_file_absent(payload)


def test_printed_json_cannot_change_parts():
    script = (
        "import os\n"
        "os.write(1, b'{\"ok\": false, \"error\": \"spoofed\", \"parts\": [{\"label\": \"nope\"}]}\\n')\n"
        "print('{\"ok\": false, \"parts\": [{\"label\": \"printed\"}]}')\n"
        "from build123d import *\n"
        "result = Box(4, 5, 6, align=(Align.MIN, Align.MIN, Align.MIN))\n"
    )
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    payload = response.json()
    assert payload["ok"] is True
    assert payload["parts"][0]["label"] == ""
    assert payload["parts"][0]["volume"] == pytest.approx(120, rel=1e-6)
    assert "spoofed" not in response.text
    assert "nope" not in response.text
    _foreign_file_absent(payload)


def test_symlink_export_is_not_followed():
    # argv[2] is the scratch directory, not the service outdir. Symlinks and a
    # forged result.json there must not be opened or returned.
    script = (
        "import json, os, sys\n"
        "outdir = sys.argv[2]\n"
        "os.symlink('/etc/hostname', os.path.join(outdir, 'model.step'))\n"
        "os.symlink('/etc/hostname', os.path.join(outdir, 'model.stl'))\n"
        "open(os.path.join(outdir, 'result.json'), 'w').write(json.dumps({\n"
        "    'ok': True, 'parts': [], 'solids': 0,\n"
        "    'bbox': {'min': [0, 0, 0], 'max': [0, 0, 0]},\n"
        "    'stl': '/etc/hostname', 'step': '/etc/hostname'}))\n"
        "os._exit(0)\n"
    )
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert "step" not in payload
    assert "stl" not in payload
    _foreign_file_absent(payload)


def test_forged_result_and_foreign_bytes_are_not_returned():
    # probeB_forge.py: forge measurements and copy a foreign file into the
    # fixed export name and into the BREP slot, then exit before the runner.
    script = (
        "import json, os, sys\n"
        "scratch = sys.argv[-1]\n"
        "data = open('/etc/hostname', 'rb').read()\n"
        "open(os.path.join(scratch, 'model.step'), 'wb').write(data)\n"
        "open(os.path.join(scratch, 'result.brep'), 'wb').write(data)\n"
        "open(os.path.join(scratch, 'result.json'), 'w').write(json.dumps({\n"
        "    'ok': True, 'solids': 7,\n"
        "    'parts': [{'label': 'FORGED', 'valid': True, 'volume': 999.0,\n"
        "               'min': [0, 0, 0], 'max': [1, 1, 1]}],\n"
        "    'bbox': {'min': [0, 0, 0], 'max': [1, 1, 1]}}))\n"
        "os._exit(0)\n"
    )
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload.get("solids") != 7
    assert "FORGED" not in response.text
    _foreign_file_absent(payload)


def test_planted_brep_is_measured_not_trusted_from_json():
    # A real shape planted in the scratch dir is measured by the trusted stage.
    # The forged result.json and the hostname bytes in model.step are not.
    script = (
        "import json, os, sys\n"
        "from build123d import Box, Align, export_brep\n"
        "box = Box(4, 5, 6, align=(Align.MIN, Align.MIN, Align.MIN))\n"
        "scratch = sys.argv[-1]\n"
        "export_brep(box, os.path.join(scratch, 'result.brep'))\n"
        "open(os.path.join(scratch, 'model.step'), 'wb').write(open('/etc/hostname', 'rb').read())\n"
        "open(os.path.join(scratch, 'result.json'), 'w').write(json.dumps({\n"
        "    'ok': True, 'solids': 7,\n"
        "    'parts': [{'label': 'FORGED', 'valid': True, 'volume': 999.0,\n"
        "               'min': [0, 0, 0], 'max': [1, 1, 1]}],\n"
        "    'bbox': {'min': [0, 0, 0], 'max': [9, 9, 9]}}))\n"
        "os._exit(0)\n"
    )
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True, payload
    assert payload["solids"] == 1
    assert payload["parts"][0]["label"] == ""
    assert payload["parts"][0]["volume"] == pytest.approx(120, rel=1e-6)
    assert payload["bbox"]["max"] == pytest.approx([4, 5, 6], abs=1e-6)
    assert "FORGED" not in response.text
    step = base64.b64decode(payload["step"])
    assert step.startswith(b"ISO-10303-21;")
    _foreign_file_absent(payload)


def test_env_token_refuses_to_start():
    env = os.environ.copy()
    env["CADAI_GEO_TOKEN"] = "nope"
    proc = subprocess.run(
        [sys.executable, "-c", "import cadai_geo.service"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode != 0
    assert "refusing to start" in proc.stderr
    assert "CADAI_GEO_TOKEN_FILE" in proc.stderr


@pytest.mark.skipif(
    os.geteuid() != 0,
    reason="uid separation requires root to setuid to a pool uid; run pytest as root inside the geo Docker image",
)
def test_token_file_and_proc_environ_are_unreadable(tmp_path):
    secret = "file-token-not-in-env-9f3c"
    token_file = tmp_path / "geo-token"
    token_file.write_text(secret + "\n", encoding="utf-8")
    os.chmod(token_file, 0o400)
    script = f"""
import os
secret = {secret!r}
paths = ["/proc/1/environ", f"/proc/{{os.getppid()}}/environ", {str(token_file)!r}]
blob = b""
for path in paths:
    try:
        blob += open(path, "rb").read()
    except OSError:
        pass
if secret.encode() in blob:
    raise RuntimeError("leaked")
from build123d import *
result = Box(1, 1, 1)
"""
    previous = os.environ.get("CADAI_GEO_TOKEN_FILE")
    os.environ["CADAI_GEO_TOKEN_FILE"] = str(token_file)
    try:
        response = client.post("/run", json={"script": script}, headers={"x-cadai-geo-token": secret})
    finally:
        if previous is None:
            os.environ.pop("CADAI_GEO_TOKEN_FILE", None)
        else:
            os.environ["CADAI_GEO_TOKEN_FILE"] = previous
    assert response.status_code == 200, response.text
    assert secret not in response.text
    assert response.json()["ok"] is True


def test_timeout_kills_grandchild(tmp_path):
    os.chmod(tmp_path, 0o777)
    pidfile = tmp_path / "gc.pid"
    inner = (
        "import os, time\n"
        f"open({str(pidfile)!r}, 'w').write(str(os.getpid()))\n"
        "time.sleep(120)\n"
    )
    script = (
        "import subprocess, sys, time\n"
        f"subprocess.Popen([sys.executable, '-c', {inner!r}])\n"
        "time.sleep(120)\n"
    )
    started = time.time()
    try:
        response = client.post(
            "/run",
            json={"script": script, "timeout_s": 20},
            headers=HEADERS,
        )
        assert response.status_code == 200
        assert response.json()["error"] == "timeout"
        assert time.time() - started < 40
        deadline = time.time() + 5
        pid_text = ""
        while time.time() < deadline and not pid_text.strip().isdigit():
            if pidfile.exists():
                pid_text = pidfile.read_text(encoding="utf-8")
            time.sleep(0.1)
        assert pid_text.strip().isdigit(), "grandchild never wrote its pid"
        pid = int(pid_text.strip())
        gone = time.time() + 5
        while time.time() < gone and os.path.exists(f"/proc/{pid}"):
            time.sleep(0.1)
        assert not os.path.exists(f"/proc/{pid}")
    finally:
        if pidfile.exists():
            text = pidfile.read_text(encoding="utf-8").strip()
            if text.isdigit() and os.path.exists(f"/proc/{text}"):
                os.kill(int(text), 9)


def test_fork_bomb_stops_cleanly():
    # Children stay alive (exec /bin/sleep) so they keep their RLIMIT_NPROC
    # slot. The loop asks for more tasks than the service left free.
    script = r"""
import os, resource, signal

def tasks():
    uid = os.getuid()
    total = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/status" % entry, encoding="utf-8") as handle:
                text = handle.read()
        except OSError:
            continue
        real = None
        threads = 1
        for line in text.splitlines():
            if line.startswith("Uid:"):
                real = int(line.split()[1])
            elif line.startswith("Threads:"):
                threads = int(line.split()[1])
        if real == uid:
            total += threads
    return total

soft, _hard = resource.getrlimit(resource.RLIMIT_NPROC)
before = tasks()
room = soft - before
pids = []
stopped = 0
attempts = min(max(room, 0) + 80, 200)
for _ in range(attempts):
    try:
        pid = os.fork()
    except OSError:
        stopped = 1
        break
    if pid == 0:
        try:
            os.execv("/bin/sleep", ["/bin/sleep", "30"])
        finally:
            os._exit(0)
    pids.append(pid)
for pid in pids:
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
for pid in pids:
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
raise RuntimeError("forks=%d room=%d stopped=%d soft=%d" % (len(pids), room, stopped, soft))
"""
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is False
    fields = payload["error"].split("RuntimeError: ", 1)[1].split()
    values = dict(item.split("=", 1) for item in fields)
    room = int(values["room"])
    forks = int(values["forks"])
    # georun gets 64. Local pytest gets a small headroom above this uid's
    # existing tasks. Either way the quota is finite and the bomb hits it.
    assert room < 256
    assert int(values["stopped"]) == 1
    assert 1 <= forks <= room + 80
    assert client.get("/healthz").status_code == 200


def test_rlimits_are_set():
    script = """
import resource
names = ["RLIMIT_AS", "RLIMIT_CPU", "RLIMIT_FSIZE", "RLIMIT_NPROC", "RLIMIT_CORE"]
parts = []
for name in names:
    soft, _hard = resource.getrlimit(getattr(resource, name))
    parts.append("%s=%d" % (name, soft))
raise RuntimeError(" ".join(parts))
"""
    response = client.post("/run", json={"script": script, "timeout_s": 60}, headers=HEADERS)
    error = response.json()["error"]
    values = dict(item.split("=", 1) for item in error.split("RuntimeError: ", 1)[1].split())
    assert int(values["RLIMIT_AS"]) == 2 * 1024**3
    assert int(values["RLIMIT_CPU"]) == 65
    assert int(values["RLIMIT_FSIZE"]) == 256 * 1024 * 1024
    assert int(values["RLIMIT_CORE"]) == 0
    assert int(values["RLIMIT_NPROC"]) >= 64


def test_large_file_write_fails_cleanly():
    script = """
chunk = b"x" * (1024 * 1024)
with open("big.bin", "wb") as handle:
    for _ in range(1024):
        handle.write(chunk)
raise RuntimeError("wrote=1073741824")
"""
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    payload = response.json()
    assert response.status_code == 200
    assert payload["ok"] is False
    assert "wrote=1073741824" not in payload.get("error", "")
    assert client.get("/healthz").status_code == 200


def test_stderr_is_capped():
    script = "import sys, os\nsys.stderr.write('E' * 200000)\nos._exit(1)\n"
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    payload = response.json()
    assert payload["ok"] is False
    assert len(payload["error"]) <= 4096


def test_output_too_large(monkeypatch):
    monkeypatch.setenv("CADAI_GEO_MAX_EXPORT_BYTES", "128")
    script = (
        "from build123d import *\n"
        "result = Box(4, 5, 6, align=(Align.MIN, Align.MIN, Align.MIN))\n"
    )
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error"] == "output too large"


def test_timeout_zero_is_clamped_to_one_second():
    assert clamp_timeout(0) == 1
    assert clamp_timeout(-5) == 1
    assert clamp_timeout(10**9) == 120
    assert clamp_timeout(60) == 60
    started = time.time()
    response = client.post(
        "/run",
        json={"script": "import time\ntime.sleep(30)\n", "timeout_s": 0},
        headers=HEADERS,
    )
    assert response.json()["error"] == "timeout"
    assert time.time() - started < 15


def test_error_strips_temp_paths():
    script = "raise RuntimeError(__file__)\n"
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    error = response.json()["error"]
    assert response.json()["ok"] is False
    assert "model.py" not in error
    assert "/tmp/" not in error
    assert "RuntimeError" in error


def test_redact_strips_tmpdir_prefix(monkeypatch):
    monkeypatch.setenv("TMPDIR", "/var/geo-tmp")
    from cadai_geo.run import redact

    text = redact("OSError: /var/geo-tmp/cadai-geo-1/stderr.txt and /tmp/cadai-geo-x/model.py")
    assert "/var/geo-tmp" not in text
    assert "/tmp/" not in text
    assert "model.py" not in text
    assert "[redacted]" in text


def test_script_over_256kb_is_rejected():
    response = client.post(
        "/run",
        json={"script": "x" * (256 * 1024 + 1)},
        headers=HEADERS,
    )
    assert response.status_code == 413
    small = client.post(
        "/run",
        json={"script": "import os\nos._exit(0)\n"},
        headers=HEADERS,
    )
    assert small.status_code == 200


def test_healthz_needs_no_token():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def _out_dir_names() -> set[str]:
    root = pathlib.Path(tempfile.gettempdir())
    return {path.name for path in root.glob("cadai-geo-out-*")}


def test_docs_list_required_capabilities():
    geo_dir = pathlib.Path(__file__).resolve().parents[1]
    readme = (geo_dir / "README.md").read_text(encoding="utf-8")
    docker = (geo_dir / "Dockerfile").read_text(encoding="utf-8")
    for name in ("SETUID", "SETGID", "KILL", "CHOWN", "DAC_OVERRIDE", "FOWNER"):
        assert name in readme
        assert name in docker
    assert "no isolation: local dev only" in readme


def test_local_dev_logs_no_isolation():
    if os.geteuid() == 0:
        pytest.skip("this process is root; the isolation log is the non-root path")
    env = os.environ.copy()
    env.pop("CADAI_GEO_TOKEN", None)
    proc = subprocess.run(
        [sys.executable, "-c", "import cadai_geo.service"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    assert "no isolation: local dev only" in proc.stderr


def test_missing_capabilities_are_named():
    from cadai_geo.service import _missing_cap_names

    # CHOWN is bit 0, KILL is bit 5. The other required bits are present.
    mask = (1 << 1) | (1 << 3) | (1 << 6) | (1 << 7)
    assert _missing_cap_names(mask) == ["CAP_CHOWN", "CAP_KILL"]


def test_remove_tree_does_not_raise_while_a_writer_runs():
    from cadai_geo.service import _remove_tree

    path = tempfile.mkdtemp(prefix="cadai-geo-out-")
    stop = threading.Event()

    def race() -> None:
        while not stop.is_set():
            try:
                with open(os.path.join(path, "result.json"), "w", encoding="utf-8") as handle:
                    handle.write("x")
            except OSError:
                pass

    thread = threading.Thread(target=race)
    thread.start()
    time.sleep(0.05)
    try:
        _remove_tree(path)
    finally:
        stop.set()
        thread.join(timeout=2)
    _remove_tree(path)
    assert not os.path.lexists(path)


def test_stderr_symlink_cannot_read_a_secret(tmp_path):
    secret = "SECRET-TOKEN-LIKE-0400-FILE"
    target = tmp_path / "secret"
    target.write_text(secret, encoding="utf-8")
    os.chmod(target, 0o400)
    script = f"""
import os, glob, signal
for path in glob.glob("/tmp/cadai-geo-*/stderr.txt"):
    try:
        os.unlink(path)
    except OSError:
        pass
    os.symlink({str(target)!r}, path)
os.kill(os.getpid(), signal.SIGKILL)
"""
    before = _out_dir_names()
    started = time.perf_counter()
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    assert secret not in response.text
    payload = response.json()
    assert payload["ok"] is False
    assert payload.get("error") != secret
    assert elapsed < 5, elapsed
    assert _out_dir_names() <= before


def test_cleanup_does_not_500_or_leak_outdir():
    script = """
import os, glob, time
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        end = time.time() + 0.3
        while time.time() < end:
            for directory in glob.glob("/tmp/cadai-geo-out-*"):
                try:
                    with open(directory + "/leak.bin", "w", encoding="utf-8") as handle:
                        handle.write("x")
                except OSError:
                    pass
            time.sleep(0.01)
        os._exit(0)
    os._exit(0)
from build123d import Box
result = Box(1, 1, 1)
"""
    before = _out_dir_names()
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    assert response.status_code == 200, response.text
    assert response.json().get("error") != "sandbox"
    deadline = time.time() + 3
    leaked = _out_dir_names() - before
    while leaked and time.time() < deadline:
        time.sleep(0.05)
        leaked = _out_dir_names() - before
    assert not leaked


def test_sys_exit_is_reported():
    zero = client.post(
        "/run",
        json={"script": "import sys\nsys.exit(0)\n"},
        headers=HEADERS,
    )
    assert zero.status_code == 200
    assert zero.json()["ok"] is False
    assert zero.json()["error"] == "script exited"
    three = client.post(
        "/run",
        json={"script": "import sys\nsys.exit(3)\n"},
        headers=HEADERS,
    )
    assert three.json()["ok"] is False
    assert three.json()["error"] == "script exited: 3"


def test_sigsegv_returns_within_two_seconds():
    warm = client.post(
        "/run",
        json={"script": "from build123d import Box\nresult = Box(1, 1, 1)\n"},
        headers=HEADERS,
    )
    assert warm.status_code == 200
    assert warm.json()["ok"] is True
    started = time.perf_counter()
    response = client.post(
        "/run",
        json={"script": "import os, signal\nos.kill(os.getpid(), signal.SIGSEGV)\n"},
        headers=HEADERS,
    )
    elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is False
    assert payload["error"] == "script crashed"
    assert elapsed < 2, elapsed


def test_symlinked_scratch_is_not_measured(tmp_path):
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    script = f"""
import os, sys
from build123d import Box, export_brep
foreign = {str(foreign)!r}
export_brep(Box(5, 5, 5), os.path.join(foreign, "result.brep"))
scratch = sys.argv[-1]
os.rename(scratch, scratch + "-real")
os.symlink(foreign, scratch)
"""
    response = client.post("/run", json={"script": script}, headers=HEADERS)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is False
    assert "125" not in response.text
    assert payload.get("error") == "measure"


def test_one_thousand_parts_are_measured():
    script = """
from build123d import Box, Compound, Align
parts = []
for i in range(1000):
    box = Box(1, 1, 1, align=(Align.MIN, Align.MIN, Align.MIN))
    box.label = "p%d" % i
    parts.append(box)
result = Compound(parts)
"""
    response = client.post(
        "/run",
        json={"script": script, "timeout_s": 120},
        headers=HEADERS,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is True, payload.get("error")
    assert len(payload["parts"]) == 1000
    assert payload["parts"][0]["label"] == "p0"
    assert payload["parts"][-1]["label"] == "p999"
    assert payload["solids"] == 1000


_ROOT_SKIP = (
    "uid separation requires root to setuid to a pool uid; "
    "run pytest as root inside the geo Docker image"
)


@pytest.mark.skipif(os.geteuid() != 0, reason=_ROOT_SKIP)
def test_setsid_survivor_cannot_forge_result():
    host = _hostname().decode(errors="replace")
    script = """
import os, glob, json, time
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        end = time.time() + 40
        while time.time() < end:
            for directory in glob.glob("/tmp/cadai-geo-out-*"):
                try:
                    path = directory + "/result.json"
                    with open(path + ".x", "w", encoding="utf-8") as handle:
                        handle.write(json.dumps({
                            "ok": True, "solids": 7,
                            "parts": [{"label": "FORGED", "valid": True, "volume": 999.0,
                                       "min": [0, 0, 0], "max": [1, 1, 1]}],
                            "bbox": {"min": [0, 0, 0], "max": [1, 1, 1]},
                        }))
                    os.replace(path + ".x", path)
                    with open("/etc/hostname", encoding="utf-8") as handle:
                        name = handle.read()
                    with open(directory + "/model.step", "w", encoding="utf-8") as handle:
                        handle.write("HOSTNAME:" + name)
                except Exception:
                    pass
            time.sleep(0.0005)
        os._exit(0)
    os._exit(0)
from build123d import Box
result = Box(1, 1, 1)
"""
    before = _out_dir_names()
    started = time.perf_counter()
    response = client.post("/run", json={"script": script, "timeout_s": 60}, headers=HEADERS)
    elapsed = time.perf_counter() - started
    assert response.status_code == 200, response.text
    assert elapsed < 15, elapsed
    payload = response.json()
    assert "FORGED" not in response.text
    assert host not in response.text
    assert payload.get("solids") != 7
    if payload.get("ok") is True:
        assert payload["parts"][0]["volume"] == pytest.approx(1, rel=1e-6)
    assert _out_dir_names() <= before
