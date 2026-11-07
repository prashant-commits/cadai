"""Acceptance tests for the cadai geometry runner (P1 Task 1)."""
import json, os, subprocess, sys, textwrap
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
GEO = os.path.dirname(HERE)


def run_cli(tmp_path, script, flags=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    src = tmp_path / 'model.py'
    src.write_text(textwrap.dedent(script))
    out = tmp_path / 'out'
    out.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, '-I', '-m', 'cadai_geo', str(src), str(out)]
    if flags:
        cmd.extend(flags)
    p = subprocess.run(cmd, cwd=GEO, capture_output=True, text=True, timeout=120)
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


def test_measures_cadai_parts_before_fusing(tmp_path):
    r, _ = run_cli(tmp_path, '''
        from build123d import *
        a = Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'a'
        b = Pos(0, 0, 10) * Box(10, 10, 5, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'b'
        _cadai_parts = [a, b]
        fused = a + b
        fused.label = 'a+b'
        result = Compound(children=[fused])
    ''')
    assert r['ok'] is True
    assert [p['label'] for p in r['parts']] == ['a', 'b']
    assert r['solids'] == 1


def test_interferences_overlapping_and_touching(tmp_path):
    # Two overlapping boxes -> one pair with the right volume
    r_overlap, _ = run_cli(tmp_path / 'overlap', '''
        from build123d import *
        a = Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'box_a'
        b = Pos(8, 0, 0) * Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'box_b'
        _cadai_parts = [a, b]
        result = Compound([a, b])
    ''', flags=['--interferences'])
    assert r_overlap['ok'] is True
    assert 'interferences' in r_overlap
    assert len(r_overlap['interferences']) == 1
    assert r_overlap['interferences'][0]['a'] == 'box_a'
    assert r_overlap['interferences'][0]['b'] == 'box_b'
    assert r_overlap['interferences'][0]['volume'] == pytest.approx(200.0, rel=1e-3)

    # Touching boxes -> none
    r_touch, _ = run_cli(tmp_path / 'touch', '''
        from build123d import *
        a = Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'box_a'
        b = Pos(10, 0, 0) * Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'box_b'
        _cadai_parts = [a, b]
        result = Compound([a, b])
    ''', flags=['--interferences'])
    assert r_touch['ok'] is True
    assert r_touch.get('interferences') == []


def test_part_centroid_and_area(tmp_path):
    r, _ = run_cli(tmp_path, '''
        from build123d import *
        a = Box(10, 20, 30, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'base'
        _cadai_parts = [a]
        result = a
    ''')
    assert r['ok'] is True
    parts = {p['label']: p for p in r['parts']}
    assert 'base' in parts
    assert parts['base']['centroid'] == pytest.approx([5.0, 10.0, 15.0], abs=1e-5)
    assert parts['base']['area'] == pytest.approx(2200.0, abs=1e-5)


def test_part_meshes_flag(tmp_path):
    import base64
    r, _ = run_cli(tmp_path, '''
        from build123d import *
        a = Box(10, 20, 30, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'base'
        b = Pos(0, 0, 30) * Box(10, 20, 5, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'lid'
        _cadai_parts = [a, b]
        result = Compound([a, b])
    ''', flags=['--part-meshes'])
    assert r['ok'] is True
    assert 'partMeshes' in r
    assert set(r['partMeshes'].keys()) == {'base', 'lid'}
    base_stl = base64.b64decode(r['partMeshes']['base']).decode('ascii')
    lid_stl = base64.b64decode(r['partMeshes']['lid']).decode('ascii')
    assert base_stl.startswith('solid')
    assert lid_stl.startswith('solid')

