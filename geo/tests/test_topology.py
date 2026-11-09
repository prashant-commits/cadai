"""Tests for B-Rep topology export (Task 10)."""
import json
import os
import pytest
from build123d import Box, Compound, Cylinder

from cadai_geo.topology import export_topology
from cadai_geo import run
from cadai_geo.service import _attach_exports


def test_a_20_mm_cube_has_6_plane_faces_and_12_line_edges_of_length_20():
    cube = Box(20, 20, 20)
    topo = export_topology(cube, [("cube", cube)])

    faces = topo["faces"]
    assert len(faces) == 6
    assert all(f["kind"] == "plane" for f in faces)
    face_ids = {f["id"] for f in faces}

    edges = topo["edges"]
    assert len(edges) == 12
    assert all(e["kind"] == "line" for e in edges)
    for e in edges:
        assert e["length"] == pytest.approx(20.0, abs=1e-3)
        assert len(e["faces"]) == 2
        assert e["faces"][0] != e["faces"][1]
        assert e["faces"][0] in face_ids
        assert e["faces"][1] in face_ids


def test_a_10_mm_through_hole_yields_a_cylinder_face_with_radius_5_and_circle_edges_with_radius_5():
    cube = Box(20, 20, 20)
    hole = Cylinder(5, 30)
    part = cube - hole
    topo = export_topology(part, [("part", part)])

    cyl_faces = [f for f in topo["faces"] if f["kind"] == "cylinder"]
    assert len(cyl_faces) >= 1
    for cf in cyl_faces:
        assert cf["radius"] == pytest.approx(5.0, abs=1e-3)
        assert "axis" in cf
        assert len(cf["axis"]) == 3

    circle_edges = [e for e in topo["edges"] if e["kind"] == "circle"]
    assert len(circle_edges) >= 2
    for ce in circle_edges:
        assert ce["radius"] == pytest.approx(5.0, abs=1e-3)
        assert "center" in ce
        assert len(ce["center"]) == 3


def test_every_triangle_has_a_face_id_that_exists_in_faces():
    part = Box(20, 20, 20) - Cylinder(5, 30)
    topo = export_topology(part, [("part", part)])

    mesh = topo["mesh"]
    positions = mesh["positions"]
    indices = mesh["indices"]
    face_ids = mesh["faceIds"]

    assert len(indices) % 3 == 0
    assert len(face_ids) == len(indices) // 3

    known_face_ids = {f["id"] for f in topo["faces"]}
    num_verts = len(positions) // 3
    for fid in face_ids:
        assert fid in known_face_ids
    for idx in indices:
        assert 0 <= idx < num_verts


def test_faces_carry_the_part_label_from__cadai_parts(tmp_path):
    script = """
from build123d import *
base = Box(20, 20, 10); base.label = 'base'
lid = Pos(0, 0, 10) * Box(20, 20, 5); lid.label = 'lid'
_cadai_parts = [base, lid]
result = Compound([base, lid])
"""
    script_path = tmp_path / "model.py"
    script_path.write_text(script, encoding="utf-8")
    outdir = tmp_path / "out"

    res = run.run(str(script_path), str(outdir), topology=True)
    assert res["ok"] is True
    assert res.get("topology_file") == "topology.json"

    topo_path = outdir / "topology.json"
    assert topo_path.is_file()
    topology = json.loads(topo_path.read_text(encoding="utf-8"))

    parts = topology["parts"]
    part_labels = {p["label"] for p in parts}
    assert part_labels == {"base", "lid"}
    for p in parts:
        assert "min" in p and len(p["min"]) == 3
        assert "max" in p and len(p["max"]) == 3

    face_parts = {f["part"] for f in topology["faces"]}
    assert face_parts == {"base", "lid"}
    for f in topology["faces"]:
        assert f["part"] in {"base", "lid"}


def test_topology_over_the_export_cap_is_skipped_with_a_note(tmp_path):
    outdir = tmp_path / "out"
    outdir.mkdir()

    # Small step and stl files (20 bytes each)
    (outdir / "model.step").write_bytes(b"ISO-10303-21; 20_bytes")
    (outdir / "model.stl").write_bytes(b"solid test endsolid ")

    # Topology file is 200 bytes
    topo_data = json.dumps({"mesh": {"positions": [], "indices": [], "faceIds": []}, "faces": [], "edges": [], "parts": []})
    padded_topo = topo_data + " " * max(0, 200 - len(topo_data))
    (outdir / "topology.json").write_text(padded_topo, encoding="utf-8")

    # With cap of 100 bytes, step (22 bytes) and stl (20 bytes) fit,
    # but topology (200 bytes) exceeds the cap and is skipped with note.
    payload = {"ok": True, "notes": []}
    attached = _attach_exports(payload, str(outdir), max_bytes=100)

    assert attached["ok"] is True
    assert "step" in attached
    assert "stl" in attached
    assert "topology" not in attached
    assert "topology skipped: too large" in attached.get("notes", [])
