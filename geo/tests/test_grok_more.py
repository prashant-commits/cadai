"""Regression tests for Grok follow-up probes (probe_more.py)."""

from __future__ import annotations

import os
import tempfile
import pytest
from build123d import Box
from cadai_geo.run import _safe_import, script_globals, run


def test_import_operator_rejected():
    """probe_more: _safe_import('operator') must raise ImportError."""
    with pytest.raises(ImportError) as exc_info:
        _safe_import("operator")
    assert "not allowed" in str(exc_info.value)


def test_dump_json_rejects_path_argument():
    """probe_more: DumpJson takes a BytesIO stream, not a file path."""
    ns = script_globals()
    box = ns["Box"](1, 1, 1)
    dump = getattr(box.wrapped, "DumpJson")
    with tempfile.TemporaryDirectory() as td:
        dump_path = os.path.join(td, "dump.json")
        with pytest.raises(TypeError):
            dump(dump_path)
        assert not os.path.exists(dump_path)


def test_alloc_within_limits_succeeds():
    """probe_more: An 8 MiB allocation within normal limits succeeds."""
    with tempfile.TemporaryDirectory() as td:
        script_path = os.path.join(td, "alloc-script.py")
        outdir = os.path.join(td, "out")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write('x = "a" * (8 * 1024 * 1024)\nresult = Box(len(x) and 1, 1, 1)\n')
        res = run(script_path, outdir)
        assert res.get("ok") is True
        assert res.get("solids") == 1
