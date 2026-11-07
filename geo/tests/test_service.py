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
