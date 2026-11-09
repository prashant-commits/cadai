"""Kernel tests for Hole op blocks (Task 15)."""
import json
import shutil
from pathlib import Path
import pytest
from cadai_geo import run

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_an_m5_through_hole_in_a_10_mm_plate_leaves_a_cylinder_face_of_radius_2_75(tmp_path):
    fixture = FIXTURES_DIR / "hole_op_m5_through.py"
    script = tmp_path / "model.py"
    shutil.copy(fixture, script)
    outdir = tmp_path / "out"

    res = run.run(str(script), str(outdir), topology=True)
    assert res.get("ok") is True, res.get("error")

    # Plate volume is below 40 * 30 * 10 = 12000
    if "parts" in res and res["parts"]:
        plate_part = next((p for p in res["parts"] if p.get("label") == "plate"), res["parts"][0])
        assert plate_part["volume"] < 40 * 30 * 10

    topo_path = outdir / "topology.json"
    assert topo_path.is_file()
    topology = json.loads(topo_path.read_text(encoding="utf-8"))

    cyl_faces = [f for f in topology["faces"] if f["kind"] == "cylinder"]
    assert len(cyl_faces) >= 1
    for cf in cyl_faces:
        assert cf["radius"] == pytest.approx(2.75, abs=1e-3)


def test_a_counterbore_adds_a_second_cylinder_face_of_radius_5_0(tmp_path):
    fixture = FIXTURES_DIR / "hole_op_m5_counterbore.py"
    script = tmp_path / "model.py"
    shutil.copy(fixture, script)
    outdir = tmp_path / "out"

    res = run.run(str(script), str(outdir), topology=True)
    assert res.get("ok") is True, res.get("error")

    topo_path = outdir / "topology.json"
    assert topo_path.is_file()
    topology = json.loads(topo_path.read_text(encoding="utf-8"))

    cyl_faces = [f for f in topology["faces"] if f["kind"] == "cylinder"]
    radii = [cf["radius"] for cf in cyl_faces]

    has_2_75 = any(pytest.approx(2.75, abs=1e-3) == r for r in radii)
    has_5_0 = any(pytest.approx(5.0, abs=1e-3) == r for r in radii)
    assert has_2_75, f"Expected cylinder face of radius 2.75, found {radii}"
    assert has_5_0, f"Expected cylinder face of radius 5.0, found {radii}"
