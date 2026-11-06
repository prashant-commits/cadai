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
    p = subprocess.run([sys.executable, '-I', '-c', BOOT, str(src), str(out)], capture_output=True, text=True, timeout=120)
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
