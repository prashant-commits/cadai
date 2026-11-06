"""Acceptance tests for the cadai geometry runner (P1 Task 1)."""
import json, os, subprocess, sys, textwrap
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.path.dirname(HERE)


def run_cli(tmp_path, script):
    src = tmp_path / 'model.py'
    src.write_text(textwrap.dedent(script))
    out = tmp_path / 'out'
    out.mkdir()
    p = subprocess.run([sys.executable, '-I', '-m', 'cadai_geo', str(src), str(out)], cwd=GEO, capture_output=True, text=True, timeout=120)
    line = [l for l in p.stdout.splitlines() if l.strip().startswith('{')][-1]
    return json.loads(line), out


def test_runs_labelled_compound(tmp_path):
    r, out = run_cli(tmp_path, '''
        from build123d import *
        a = Box(10, 20, 30, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'base'
        b = Pos(0, 0, 30) * Box(10, 20, 5, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'lid'
        result = Compound([a, b])
    ''')
    assert r['ok'] is True
    parts = {p['label']: p for p in r['parts']}
    assert set(parts) == {'base', 'lid'}
    assert parts['base']['min'] == pytest.approx([0, 0, 0], abs=1e-6)
    assert parts['base']['max'] == pytest.approx([10, 20, 30], abs=1e-6)
    assert parts['lid']['min'][2] == pytest.approx(30, abs=1e-6)
    assert all(p['valid'] for p in r['parts'])
    assert r['bbox']['max'] == pytest.approx([10, 20, 35], abs=1e-6)
    assert os.path.getsize(r['step']) > 0 and os.path.getsize(r['stl']) > 0
    assert open(r['step']).read(13) == 'ISO-10303-21;'


def test_reports_error(tmp_path):
    r, _ = run_cli(tmp_path, '''
        from build123d import *
        result = Cylinder(3, 10, axis=(1, 0, 0))
    ''')
    assert r['ok'] is False
    assert 'TypeError' in r['error']


def test_no_result(tmp_path):
    r, _ = run_cli(tmp_path, '''
        from build123d import *
        x = Box(1, 1, 1)
    ''')
    assert r['ok'] is False
    assert 'result' in r['error']


def test_single_part_without_label(tmp_path):
    r, _ = run_cli(tmp_path, '''
        from build123d import *
        result = Box(4, 5, 6, align=(Align.MIN, Align.MIN, Align.MIN))
    ''')
    assert r['ok'] is True and r['solids'] == 1 and len(r['parts']) == 1
    assert r['parts'][0]['volume'] == pytest.approx(120, rel=1e-6)


def test_stl_is_ascii(tmp_path):
    r, out = run_cli(tmp_path, '''
        from build123d import *
        result = Box(4, 5, 6, align=(Align.MIN, Align.MIN, Align.MIN))
    ''')
    assert r['ok'] is True
    data = (out / 'model.stl').read_bytes()
    assert data.startswith(b'solid')
    assert b'facet normal' in data
