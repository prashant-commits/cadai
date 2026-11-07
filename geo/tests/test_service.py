"""Acceptance tests for the geometry HTTP service (P1 Task 1)."""
import base64

from fastapi.testclient import TestClient

from cadai_geo.service import app

client = TestClient(app)
SCRIPT = "from build123d import *\nresult = Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN))\n"


def test_rejects_missing_token():
    assert client.post('/run', json={'script': SCRIPT}).status_code == 401


def test_runs_and_returns_base64_exports():
    r = client.post('/run', json={'script': SCRIPT}, headers={'x-cadai-geo-token': 'test-token'})
    assert r.status_code == 200
    j = r.json()
    assert j['ok'] is True
    assert base64.b64decode(j['step'])[:13] == b'ISO-10303-21;'
    assert len(base64.b64decode(j['stl'])) > 0


def test_times_out():
    r = client.post('/run', json={'script': 'import time\ntime.sleep(5)\n', 'timeout_s': 1}, headers={'x-cadai-geo-token': 'test-token'})
    assert r.status_code == 200
    assert r.json()['ok'] is False and r.json()['error'] == 'timeout'


def test_script_cannot_read_the_service_environment():
    r = client.post('/run', json={'script': "import os\nfrom build123d import *\nassert 'CADAI_GEO_TOKEN' not in os.environ, 'leak'\nresult = Box(1,1,1)\n"}, headers={'x-cadai-geo-token': 'test-token'})
    assert r.json()['ok'] is True, r.json()


def test_service_interferences():
    script = """
from build123d import *
a = Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'a'
b = Pos(8, 0, 0) * Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'b'
_cadai_parts = [a, b]
result = Compound([a, b])
"""
    r = client.post(
        '/run',
        json={'script': script, 'interferences': True},
        headers={'x-cadai-geo-token': 'test-token'},
    )
    assert r.status_code == 200
    j = r.json()
    assert j['ok'] is True
    assert 'interferences' in j
    assert len(j['interferences']) == 1
    assert j['interferences'][0]['a'] == 'a'
    assert j['interferences'][0]['b'] == 'b'
    assert abs(j['interferences'][0]['volume'] - 200.0) < 0.1


def test_service_part_meshes_and_measurements():
    script = """
from build123d import *
a = Box(10, 20, 30, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'base'
b = Pos(0, 0, 30) * Box(10, 20, 5, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'lid'
_cadai_parts = [a, b]
result = Compound([a, b])
"""
    r = client.post(
        '/run',
        json={'script': script, 'partMeshes': True},
        headers={'x-cadai-geo-token': 'test-token'},
    )
    assert r.status_code == 200
    j = r.json()
    assert j['ok'] is True
    assert 'partMeshes' in j
    assert set(j['partMeshes'].keys()) == {'base', 'lid'}
    for p in j['parts']:
        assert 'centroid' in p and len(p['centroid']) == 3
        assert 'area' in p and p['area'] > 0
    assert base64.b64decode(j['partMeshes']['base']).decode('ascii').startswith('solid')

