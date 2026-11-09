"""Tests for the Text tool op blocks and fonts (Task 13)."""
import os
from pathlib import Path
import pytest
from build123d import Text
from cadai_geo.run import run, script_globals

HERE = Path(__file__).parent.resolve()
FIXTURES = HERE / "fixtures"


def test_cadai_fonts_is_the_fonts_dir():
    ns = script_globals()
    assert "CADAI_FONTS" in ns
    fonts_dir = ns["CADAI_FONTS"]
    assert isinstance(fonts_dir, str)
    assert os.path.isabs(fonts_dir)
    assert not fonts_dir.endswith("/") and not fonts_dir.endswith("\\")
    p = Path(fonts_dir)
    assert p.is_dir()
    for name in ["inter-bold", "roboto-mono-bold", "oswald-semibold"]:
        assert (p / f"{name}.ttf").is_file()
        assert (p / f"{name}.OFL.txt").is_file()


def test_each_font_file_renders():
    ns = script_globals()
    fonts_dir = ns["CADAI_FONTS"]
    default_text = Text("AB", 10)
    assert default_text.area > 0

    areas = {}
    for font_id in ["inter-bold", "roboto-mono-bold", "oswald-semibold"]:
        t = Text("AB", 10, font_path=f"{fonts_dir}/{font_id}.ttf")
        assert t.area > 0
        areas[font_id] = t.area

    # Areas differ from each other
    area_vals = list(areas.values())
    assert len(set(area_vals)) == 3
    # And differ from default font
    for a in area_vals:
        assert a != default_text.area


def test_engraving_AB_1mm_deep_on_a_40x20x5_plate_reduces_its_volume(tmp_path):
    fixture_path = FIXTURES / "text_op_engrave.py"
    out_dir = tmp_path / "out_engrave"
    res = run(fixture_path, out_dir)
    assert res["ok"] is True
    plain_volume = 40.0 * 20.0 * 5.0  # 4000.0 mm^3
    plate_vol = res["parts"][0]["volume"]
    assert plate_vol < plain_volume


def test_embossing_increases_it(tmp_path):
    fixture_path = FIXTURES / "text_op_emboss.py"
    out_dir = tmp_path / "out_emboss"
    res = run(fixture_path, out_dir)
    assert res["ok"] is True
    plain_volume = 40.0 * 20.0 * 5.0  # 4000.0 mm^3
    plate_vol = res["parts"][0]["volume"]
    assert plate_vol > plain_volume
