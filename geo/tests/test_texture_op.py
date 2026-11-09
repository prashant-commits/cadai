"""Tests for texture operations and materials (Task 14)."""
import json
import time
from pathlib import Path
import pytest
from build123d import Box, Compound, import_step

from cadai_geo import run
from cadai_geo.run import (
    capture_geometry,
    measure_and_export,
    _material_colors,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def test_a_0_4_mm_rib_texture_changes_the_face_area(tmp_path):
    # Base script: 40 x 20 x 5 plate
    base_script = """
from build123d import *
plate = Box(40, 20, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate.label = "plate"
_cadai_parts = [plate]
result = Compound([plate])
"""
    base_file = tmp_path / "base.py"
    base_file.write_text(base_script, encoding="utf-8")
    out_base = tmp_path / "out_base"
    res_base = run.run(str(base_file), str(out_base))
    assert res_base["ok"] is True
    base_area = res_base["parts"][0]["area"]
    base_vol = res_base["parts"][0]["volume"]

    # Read rendered rib block from fixture
    fixture_path = FIXTURES_DIR / "texture_blocks.json"
    fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
    rib_block = fixtures["op_rib0001"]

    rib_script = f"""
from build123d import *
plate = Box(40, 20, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate.label = "plate"
{rib_block}
_cadai_parts = [plate]
result = Compound([plate])
"""
    rib_file = tmp_path / "rib.py"
    rib_file.write_text(rib_script, encoding="utf-8")
    out_rib = tmp_path / "out_rib"
    res_rib = run.run(str(rib_file), str(out_rib))
    assert res_rib["ok"] is True
    rib_area = res_rib["parts"][0]["area"]
    rib_vol = res_rib["parts"][0]["volume"]

    # Ribs 0.4 mm deep on the top face: surface area grows and volume drops
    assert rib_area > base_area
    assert rib_vol < base_vol


def test_a_400_feature_hex_compiles_within_budget(tmp_path):
    # Read rendered 400-feature hex block from fixture (20x20 on 40x40 area)
    fixture_path = FIXTURES_DIR / "texture_blocks.json"
    fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
    hex_block = fixtures["op_hex0000400"]

    hex_script = f"""
from build123d import *
plate = Box(50, 50, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate.label = "plate"
{hex_block}
_cadai_parts = [plate]
result = Compound([plate])
"""
    hex_file = tmp_path / "hex.py"
    hex_file.write_text(hex_script, encoding="utf-8")
    out_hex = tmp_path / "out_hex"

    t0 = time.perf_counter()
    res = run.run(str(hex_file), str(out_hex))
    elapsed = time.perf_counter() - t0

    print(f"\n400-feature hex compilation time: {elapsed:.2f} s")
    assert res["ok"] is True
    assert elapsed < 30.0


def test_a_400_feature_knurl_compiles_within_budget(tmp_path):
    # Read rendered 400-feature knurl block from fixture (40x40 area, n=20, n*n=400)
    fixture_path = FIXTURES_DIR / "texture_blocks.json"
    fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))
    knurl_block = fixtures["op_knrl000400"]

    knurl_script = f"""
from build123d import *
plate = Box(50, 50, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate.label = "plate"
{knurl_block}
_cadai_parts = [plate]
result = Compound([plate])
"""
    knurl_file = tmp_path / "knurl.py"
    knurl_file.write_text(knurl_script, encoding="utf-8")
    out_knurl = tmp_path / "out_knurl"

    t0 = time.perf_counter()
    res = run.run(str(knurl_file), str(out_knurl))
    elapsed = time.perf_counter() - t0

    print(f"\n400-feature knurl compilation time: {elapsed:.2f} s")
    assert res["ok"] is True
    assert elapsed < 30.0


def test_material_markers_color_the_step(tmp_path):
    # Test model material marker writes color to the STEP export
    script = """
from build123d import *
# cadai:op material id=op_mat0001 {"kind":"material","id":"op_mat0001","target":"model","material":"brushed-metal","color":"#123456"}
# cadai:end op_mat0001
plate = Box(20, 20, 10)
plate.label = "plate"
_cadai_parts = [plate]
result = Compound([plate])
"""
    script_file = tmp_path / "model.py"
    script_file.write_text(script, encoding="utf-8")
    outdir = tmp_path / "out"

    res = run.run(str(script_file), str(outdir))
    assert res["ok"] is True

    step_file = outdir / "model.step"
    assert step_file.is_file()
    step_content = step_file.read_text(encoding="utf-8")
    assert "COLOUR_RGB" in step_content

    # Re-import and check color
    re_imported = import_step(str(step_file))
    assert re_imported.color is not None
    # 0x12/255=0.0706, 0x34/255=0.2039, 0x56/255=0.3373
    r, g, b, _ = re_imported.color
    assert r == pytest.approx(0x12 / 255.0, abs=1e-2)
    assert g == pytest.approx(0x34 / 255.0, abs=1e-2)
    assert b == pytest.approx(0x56 / 255.0, abs=1e-2)


def test_material_markers_color_the_step_through_the_two_stages(tmp_path):
    script = """
from build123d import *
# cadai:op material id=op_mat0001 {"kind":"material","id":"op_mat0001","target":"model","material":"brushed-metal","color":"#123456"}
# cadai:end op_mat0001
plate = Box(20, 20, 10)
plate.label = "plate"
_cadai_parts = [plate]
result = Compound([plate])
"""
    script_file = tmp_path / "model.py"
    script_file.write_text(script, encoding="utf-8")
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    outdir = tmp_path / "out"
    outdir.mkdir()

    errors = []
    capture_geometry(str(script_file), str(scratch), errors.append)
    assert not errors, f"capture_geometry error: {errors}"
    assert (scratch / "materials.json").is_file()

    res = measure_and_export(str(scratch), str(outdir))
    assert res["ok"] is True

    step_file = outdir / "model.step"
    assert step_file.is_file()
    step_content = step_file.read_text(encoding="utf-8")
    assert "COLOUR_RGB" in step_content

    # Re-import and check color
    re_imported = import_step(str(step_file))
    assert re_imported.color is not None
    r, g, b, _ = re_imported.color
    assert r == pytest.approx(0x12 / 255.0, abs=1e-2)
    assert g == pytest.approx(0x34 / 255.0, abs=1e-2)
    assert b == pytest.approx(0x56 / 255.0, abs=1e-2)


def test_planted_invalid_materials_json_is_ignored(tmp_path):
    script = """
from build123d import *
plate = Box(20, 20, 10)
plate.label = "plate"
_cadai_parts = [plate]
result = Compound([plate])
"""
    script_file = tmp_path / "model.py"
    script_file.write_text(script, encoding="utf-8")
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    outdir = tmp_path / "out"
    outdir.mkdir()

    errors = []
    capture_geometry(str(script_file), str(scratch), errors.append)
    assert not errors

    # 1. Bad JSON
    (scratch / "materials.json").write_text("{not valid json", encoding="utf-8")
    res1 = measure_and_export(str(scratch), str(outdir))
    assert res1["ok"] is True

    # 2. Colour component > 1
    (scratch / "materials.json").write_text(
        json.dumps({"model": [1.5, 0.0, 0.0]}), encoding="utf-8"
    )
    res2 = measure_and_export(str(scratch), str(outdir))
    assert res2["ok"] is True

    # 3. Non-identifier key
    (scratch / "materials.json").write_text(
        json.dumps({"bad target!": [0.5, 0.5, 0.5]}), encoding="utf-8"
    )
    res3 = measure_and_export(str(scratch), str(outdir))
    assert res3["ok"] is True


def test_material_colors_rejects_bad_entries():
    source = """
# cadai:op material id=m1 {"kind":"material","id":"m1","target":"model","material":"color","color":"#ff00aa"}
# cadai:op material id=m2 {"kind":"material","id":"m2","target":"lid","material":"wood","color":"#123456"}
# cadai:op material id=m3 {"kind":"material","id":"m3","target":"bad target!","material":"wood","color":"#123456"}
# cadai:op material id=m4 {"kind":"material","id":"m4","target":"part2","material":"wood","color":"#xyz123"}
# cadai:op material id=m5 {"kind":"material","id":"m5","target":"part3","material":"wood","color":"#12345"}
# cadai:op material id=m6 {"kind":"material","id":"m6","target":"part4","material":"wood","color":"123456"}
# cadai:op material id=m7 not valid json
# cadai:op material id=m8 {"color":"#112233"}
# cadai:op material id=m9 {"kind":"material","id":"m9","target":"tail","material":"wood","color":"#010203"}
"""
    colors = _material_colors(source)
    assert "model" in colors
    assert colors["model"] == pytest.approx((1.0, 0.0, 0xAA / 255.0), abs=1e-3)
    assert "lid" in colors
    assert colors["lid"] == pytest.approx((0x12 / 255.0, 0x34 / 255.0, 0x56 / 255.0), abs=1e-3)

    assert "bad target!" not in colors
    assert "part2" not in colors
    assert "part3" not in colors
    assert "part4" not in colors
    # A valid entry after the bad ones is still read: a bad entry never stops the parse.
    assert "tail" in colors
    assert len(colors) == 3
