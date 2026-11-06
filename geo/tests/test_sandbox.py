"""Sandbox exploits from the b1 security review. Probes lived in b1-fable/."""

import base64
import json
import os
import time

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("CADAI_GEO_TOKEN", "test-token")
from cadai_geo.service import app, clamp_timeout  # noqa: E402

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
    # The spoof, plus symlinks at the fixed export names. A hard exit can
    # leave a script-written result.json; the service still must not open
    # the symlink or any path outside the temp dir.
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
    # os._exit skips the runner, so this is the script's result.json.
    # The fixed export names are symlinks and must not be inlined.
    assert payload["ok"] is True
    assert payload["parts"] == []
    assert "step" not in payload
    assert "stl" not in payload
    _foreign_file_absent(payload)


@pytest.mark.skipif(
    os.geteuid() != 0,
    reason="uid separation requires root to setuid to georun; run pytest as root inside the geo Docker image",
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
