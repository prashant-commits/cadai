"""Tests for safe rounding helpers and notes propagation in cadai_geo."""

import tempfile
from pathlib import Path
from build123d import Box, Cylinder, Pos, Align, Axis, offset
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


def test_edge_selection_outer_and_top():
    ns = script_globals(full=False)
    # Box 30x20x10 at origin
    block = Box(30, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))
    sel = ns["_select_edges"](block, "outer")
    bot = [e for e in sel if abs(e.bounding_box().max.Z - block.bounding_box().min.Z) < 1e-4]
    # Bottom face edges must be excluded from "outer"
    assert len(bot) == 0
    r = ns["_round"](block, 2, "outer")
    bf = r.faces().sort_by(Axis.Z)[0]
    # Bottom face area is preserved (only corners rounded by vertical edges: ~596 mm2, not 416 mm2)
    assert bf.area > 590

    # Part with hole
    b = Box(40, 30, 10, align=(Align.MIN,)*3) - Pos(20, 15, 0) * Cylinder(3, 30)
    top_edges = ns["_select_edges"](b, "top")
    # Top face outer wire only: 4 edges, hole rim excluded
    assert len(top_edges) == 4
    o = ns["_round"](b, 1, "top")
    assert o.is_valid
    # Hole rim was NOT rounded
    assert not any("CIRCLE" in str(e.geom_type) and getattr(e, "radius", 0) > 3.5 for e in o.edges())


def test_thin_wall_tray_retry():
    ns = script_globals(full=False)
    sb = Box(50, 40, 20, align=(Align.MIN,)*3)
    tray = offset(sb, amount=-2, openings=sb.faces().sort_by(Axis.Z)[-1])
    # r=3 and r=6 exceed half wall (1 mm), retry/capping succeeds producing a valid filleted solid
    for rr in (0.9, 1.5, 3, 6):
        out = ns["_round"](tray, rr, "outer")
        assert out.is_valid
        assert abs(out.volume - tray.volume) > 1e-6

