"""Regression tests for Grok security review probes (probe_run.py, H1, M1, L3)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import pytest
from build123d import Box, Compound
from cadai_geo.run import run, script_globals, compute_disconnected


def _execute(script: str, tmpdir: str, **kwargs) -> dict:
    script_path = os.path.join(tmpdir, "test-script.py")
    outdir = os.path.join(tmpdir, "out")
    with open(script_path, "w", encoding="utf-8") as handle:
        handle.write(script)
    return run(script_path, outdir, **kwargs)


def test_h1_round_globals_os_fails_closed():
    """H1: _round.__globals__ must not expose 'os' or module globals."""
    with tempfile.TemporaryDirectory() as td:
        script = "raise Exception('LEAK:' + _round.__globals__['os'].environ.get('CADAI_PROBE_CANARY', 'none'))\n"
        res = _execute(script, td)
        assert res.get("ok") is False
        assert "KeyError" in str(res.get("error"))
        assert "'os'" in str(res.get("error"))


def test_h1_traceback_frame_f_back_open_fails_closed():
    """H1: e.__traceback__.tb_frame.f_back.f_builtins must not expose 'open'."""
    with tempfile.TemporaryDirectory() as td:
        canary_path = os.path.join(td, "canary.txt")
        with open(canary_path, "w") as f:
            f.write("CANARY_DATA")
        script = (
            "try:\n"
            "    raise Exception('marker')\n"
            "except Exception as e:\n"
            "    b = e.__traceback__.tb_frame.f_back.f_builtins\n"
            "    data = b['open'](%r).read()\n"
            "    raise Exception('LEAK:' + data.strip())\n" % canary_path
        )
        res = _execute(script, td)
        assert res.get("ok") is False
        assert "KeyError" in str(res.get("error"))
        assert "'open'" in str(res.get("error"))


def test_m1_large_allocation_fails_cleanly_under_limit():
    """M1: An allocation exceeding CADAI_GEO_AS_LIMIT fails cleanly with MemoryError in local child path."""
    with tempfile.TemporaryDirectory() as td:
        script_path = os.path.join(td, "alloc.py")
        outdir = os.path.join(td, "out")
        with open(script_path, "w", encoding="utf-8") as handle:
            handle.write('from build123d import Box\nx = "a" * (500 * 1024 * 1024)\nresult = Box(1, 1, 1)\n')
        env = dict(os.environ)
        env["CADAI_GEO_AS_LIMIT"] = str(1200 * 1024 * 1024)
        proc = subprocess.run(
            [sys.executable, "-I", "-m", "cadai_geo", script_path, outdir],
            env=env,
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0
        res = json.loads(proc.stdout)
        assert res.get("ok") is False
        assert "MemoryError" in str(res.get("error"))


def test_l3_above_40_parts_returns_not_checked():
    """L3: More than 40 parts causes compute_disconnected to return 'not checked'."""
    parts = [(f"part_{i}", Box(1, 1, 1)) for i in range(41)]
    result = compute_disconnected(parts)
    assert result == "not checked"


def test_l3_distance_to_failure_counts_as_unknown_not_missing_edge():
    """L3: A distance_to failure does not treat the edge as missing/disconnected."""
    class FlakyShape:
        def __init__(self, box):
            self.box = box
            self.volume = 1.0

        def bounding_box(self):
            return self.box.bounding_box()

        def distance_to(self, other):
            raise RuntimeError("distance computation error")

    b1 = Box(10, 10, 10)
    b2 = Box(10, 10, 10)
    parts = [("base", FlakyShape(b1)), ("arm", FlakyShape(b2))]
    disconnected = compute_disconnected(parts)
    # distance_to failed, but it counts as unknown (edge added), so neither part is disconnected
    assert disconnected == []
