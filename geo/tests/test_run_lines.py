"""The runner reports which script line raised, and each part in its own frame."""
import json, os, subprocess, sys, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.path.dirname(HERE)

# Run this checkout's package whatever copy the interpreter has installed.
BOOT = f"import sys, runpy; sys.path.insert(0, {GEO!r}); runpy.run_module('cadai_geo', run_name='__main__')"


def run_cli(tmp_path, script):
    src = tmp_path / 'model.py'
    src.write_text(textwrap.dedent(script))
    out = tmp_path / 'out'
    out.mkdir()
    # Curated builtins, as in production: drop the test-only switch conftest sets for the b1 probes.
    env = {k: v for k, v in os.environ.items() if k != 'CADAI_GEO_TEST_FULL_BUILTINS'}
    p = subprocess.run([sys.executable, '-I', '-c', BOOT, str(src), str(out)], capture_output=True, text=True, timeout=120, env=env)
    return json.loads([l for l in p.stdout.splitlines() if l.strip().startswith('{')][-1])


def test_reports_the_innermost_script_line(tmp_path):
    r = run_cli(tmp_path, '''
        from build123d import *
        def first():
            return Box(1, 1, 1)
        def second():
            return Box(1, 1)
        a = first()
        b = second()
        result = Compound([a, b])
    ''')
    assert r['ok'] is False
    assert "TypeError" in r["error"]
    assert r['line'] == 6  # (line 1 is blank) the `return Box(1, 1)` line, inside second()


def test_reports_a_syntax_error_line(tmp_path):
    r = run_cli(tmp_path, '''
        from build123d import *
        x = 1
        y = (
    ''')
    assert r['ok'] is False
    assert r['line'] >= 3


def test_lists_each_part_in_its_own_frame(tmp_path):
    r = run_cli(tmp_path, '''
        from build123d import *
        a = Box(40, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'plate'
        placed = Pos(5, 5, 0) * Rot(0, 0, 45) * a; placed.label = 'plate'
        _local = [a]
        result = Compound(children=[placed])
    ''')
    assert r['ok'] is True
    assert [p['label'] for p in r['local']] == ['plate']
    box = r['local'][0]
    assert [round(box['max'][i] - box['min'][i], 3) for i in range(3)] == [40, 20, 10]
    placed = r['parts'][0]
    assert round(placed['max'][0] - placed['min'][0], 1) == 42.4  # turned 45 degrees: not the local size


# ---- the same reports through the service's two-stage run (untrusted script, trusted measure)

from fastapi.testclient import TestClient  # noqa: E402

from cadai_geo.run import split_error_line  # noqa: E402
from cadai_geo.service import app  # noqa: E402

_client = TestClient(app)
_HEADERS = {"x-cadai-geo-token": "test-token"}


def _service(script):
    response = _client.post("/run", json={"script": textwrap.dedent(script)}, headers=_HEADERS)
    assert response.status_code == 200
    return response.json()


def test_service_reports_the_line_from_the_untrusted_stage():
    payload = _service('''
        from build123d import *
        def first():
            return Box(1, 1, 1)
        def second():
            return Box(1, 1)
        a = first()
        b = second()
        result = Compound([a, b])
    ''')
    assert payload["ok"] is False
    assert "TypeError" in payload["error"]
    assert "␟" not in payload["error"]
    assert payload["line"] == 6


def test_service_measures_local_shapes_in_the_trusted_stage():
    payload = _service('''
        from build123d import *
        a = Box(40, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'plate'
        placed = Pos(5, 5, 0) * Rot(0, 0, 45) * a; placed.label = 'plate'
        _local = [a]
        _cadai_parts = [placed]
        result = Compound(children=[placed])
    ''')
    assert payload["ok"] is True
    assert [p["label"] for p in payload["local"]] == ["plate"]
    box = payload["local"][0]
    assert [round(box["max"][i] - box["min"][i], 3) for i in range(3)] == [40, 20, 10]
    assert [p["label"] for p in payload["parts"]] == ["plate"]


def test_service_local_is_empty_when_the_script_lists_none():
    payload = _service('''
        from build123d import *
        result = Box(1, 2, 3)
    ''')
    assert payload["ok"] is True
    assert payload["local"] == []


def test_split_error_line_only_accepts_the_exact_prefix():
    assert split_error_line("␟L12␟TypeError: x") == ("TypeError: x", 12)
    assert split_error_line("TypeError: ␟L12␟") == ("TypeError: ␟L12␟", None)
    assert split_error_line("␟Lxx␟boom") == ("␟Lxx␟boom", None)
    assert split_error_line("␟L0␟boom") == ("boom", None)


# ---- round 2: curated builtins (H1c), the line prefix (L2), a malformed local/ (L3)

import pytest  # noqa: E402

from cadai_geo.run import _last_line, measure_and_export, script_globals  # noqa: E402


@pytest.mark.parametrize(
    "line",
    [
        "open('/tmp/b3-should-not-exist', 'w')",
        "__import__('os')",
        "import os",
        "exec('x = 1')",
        "getattr(Box, 'x')",
        "type(Box)",
    ],
)
def test_script_has_no_dangerous_builtins(tmp_path, line):
    r = run_cli(tmp_path, f'''
        from build123d import *
        {line}
        result = Box(1, 1, 1)
    ''')
    assert r["ok"] is False
    assert r["error"].startswith(("NameError", "ImportError"))


def test_two_stage_run_has_no_dangerous_builtins(tmp_path, monkeypatch):
    # The service path, in process: untrusted capture then trusted measure, with curated builtins.
    import cadai_geo.run as run_module

    monkeypatch.setattr(run_module, "_FULL_BUILTINS", False)
    script = tmp_path / "model.py"
    script.write_text("from build123d import *\nopen('/tmp/b3-should-not-exist-2', 'w')\nresult = Box(1, 1, 1)\n")
    scratch = tmp_path / "scratch"
    out = tmp_path / "out"
    scratch.mkdir()
    out.mkdir()
    errors = []
    run_module.capture_geometry(str(script), str(scratch), errors.append)
    payload = run_module.measure_and_export(str(scratch), str(out), errors[0] if errors else None)
    assert payload["ok"] is False
    assert payload["error"].startswith("NameError")
    assert payload["line"] == 2
    assert not os.path.exists("/tmp/b3-should-not-exist-2")


def test_emitted_prelude_still_runs(tmp_path):
    r = run_cli(tmp_path, '''
        from build123d import *
        import math as _math
        from math import sin, cos, tan, radians, sqrt, pi
        def _sind(deg): return _math.sin(_math.radians(deg))
        items = sorted([3, 1, 2])
        part = Box(max(items), sum(items), round(10 * _sind(30)), align=(Align.MIN, Align.MIN, Align.MIN))
        part.label = 'p'
        _cadai_parts = [part]
        result = Compound(children=[part])
    ''')
    assert r["ok"] is True, r
    p = r["parts"][0]
    assert [round(p["max"][i] - p["min"][i], 3) for i in range(3)] == [3, 6, 5]


def test_globals_have_build123d_math_and_curated_builtins():
    g = script_globals(full=False)
    assert "Box" in g and "sin" in g and "pi" in g
    assert "open" not in g["__builtins__"] and "exec" not in g["__builtins__"]
    assert "getattr" not in g["__builtins__"] and "__build_class__" not in g["__builtins__"]


def test_exception_text_cannot_forge_a_line_prefix():
    try:
        raise ValueError("␟L1␟forged")
    except ValueError as exc:
        text = _last_line(exc)
    assert "␟" not in text
    assert split_error_line(text)[1] is None


def test_script_error_with_a_forged_prefix_keeps_its_real_line(tmp_path):
    r = run_cli(tmp_path, '''
        from build123d import *
        x = 1
        raise ValueError("\\n\\u241fL2\\u241fforged")
    ''')
    assert r["ok"] is False
    assert r["line"] == 4
    assert "␟" not in r["error"]


def _scratch_with_local(tmp_path, entries):
    from build123d import Align, Box, export_brep

    scratch = tmp_path / "scratch"
    out = tmp_path / "out"
    (scratch / "local").mkdir(parents=True)
    out.mkdir()
    box = Box(1, 2, 3, align=(Align.MIN, Align.MIN, Align.MIN))
    export_brep(box, str(scratch / "result.brep"))
    export_brep(box, str(scratch / "local" / "0000.brep"))
    (scratch / "local" / "0001.brep").write_text("not a brep")
    (scratch / "local" / "index.json").write_text(json.dumps(entries))
    return str(scratch), str(out)


def test_malformed_local_entries_are_dropped_not_the_run(tmp_path, capsys):
    scratch, out = _scratch_with_local(
        tmp_path,
        [
            {"label": "good", "file": "0000.brep"},
            {"label": "bad-bytes", "file": "0001.brep"},
            {"label": "escape", "file": "../result.brep"},
            "not an object",
        ],
    )
    payload = measure_and_export(scratch, out)
    assert payload["ok"] is True
    assert [p["label"] for p in payload["local"]] == ["good"]
    assert "dropped local/ entry" in capsys.readouterr().err


def test_unreadable_local_index_drops_local_only(tmp_path):
    scratch, out = _scratch_with_local(tmp_path, [])
    with open(os.path.join(scratch, "local", "index.json"), "w") as handle:
        handle.write("{not json")
    payload = measure_and_export(scratch, out)
    assert payload["ok"] is True
    assert payload["local"] == []


def test_captured_stderr_cannot_forge_a_line_prefix():
    from cadai_geo.zygote import _captured_error

    text = _captured_error("␟L2␟forged\n".encode("utf-8"))
    assert split_error_line(text)[1] is None
