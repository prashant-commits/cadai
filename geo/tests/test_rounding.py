"""Tests for safe rounding helpers and notes propagation in cadai_geo."""

import tempfile
from pathlib import Path
from build123d import Box, Align
from cadai_geo.run import script_globals, run


def test_rounding_helpers_in_script_globals():
    ns = script_globals(full=False)
    assert "_round" in ns
    assert "_bevel" in ns
    assert "_select_edges" in ns
    assert "_cadai_notes" in ns

    box = Box(30, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))

    # Successful round
    rounded = ns["_round"](box, 2, "outer")
    assert rounded.is_valid
    bb = rounded.bounding_box()
    assert abs(bb.size.X - 30) < 1e-4
    assert abs(bb.size.Y - 20) < 1e-4
    assert abs(bb.size.Z - 10) < 1e-4

    # Impossible round degrades gracefully
    unrounded = ns["_round"](box, 50, "outer")
    assert unrounded.is_valid
    notes = ns["_cadai_notes"]
    assert any("_round skipped" in n or "_round failed" in n for n in notes)

    # Successful bevel
    beveled = ns["_bevel"](box, 1, "top")
    assert beveled.is_valid

    # Impossible bevel degrades gracefully
    unbeveled = ns["_bevel"](box, 50, "top")
    assert unbeveled.is_valid
    assert any("_bevel skipped" in n or "_bevel failed" in n for n in notes)


def test_notes_propagated_to_run_result():
    with tempfile.TemporaryDirectory() as tmpdir:
        script_path = Path(tmpdir) / "script.py"
        outdir = Path(tmpdir) / "out"
        script_path.write_text(
            """
b = Box(30, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))
r = _round(b, 50, "outer")
result = r
""",
            encoding="utf-8",
        )
        res = run(script_path, outdir)
        assert res["ok"] is True
        assert "notes" in res
        assert any("_round skipped" in n or "_round failed" in n for n in res["notes"])
