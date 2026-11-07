"""Execute every fenced Python example in the build123d cheat sheet."""

import re
from pathlib import Path

import pytest

from cadai_geo.run import script_globals

CHEATSHEET = Path(__file__).resolve().parents[2] / "src" / "lib" / "brep" / "cheatsheet.md"
_FENCE = re.compile(r"```python\n(.*?)```", re.DOTALL)


def test_cheatsheet_examples_run():
    text = CHEATSHEET.read_text(encoding="utf-8")
    blocks = _FENCE.findall(text)
    assert blocks, f"no python fences in {CHEATSHEET}"
    # The namespace the runner gives a script: curated builtins, build123d and the math names.
    namespace: dict = script_globals(full=False)
    for index, block in enumerate(blocks, start=1):
        exec(compile(block, f"{CHEATSHEET.name}#block{index}", "exec"), namespace)

    # Verify all new DL1 cheat-sheet solids produce valid geometry, volume > 0, and min z >= 0
    new_solids = [
        "rounded_cols", "soft_top", "safe_box", "beveled",
        "r_body", "arc_solid", "spline_solid",
        "lofted", "swept", "tray", "tray_with_holes", "polar_ribs",
    ]
    for name in new_solids:
        assert name in namespace, f"{name} not found in namespace"
        solid = namespace[name]
        assert solid.is_valid, f"{name} is not valid"
        assert solid.volume > 0, f"{name} volume <= 0 ({solid.volume})"
        assert solid.bounding_box().min.Z >= -1e-6, f"{name} dips below z=0 ({solid.bounding_box().min.Z})"



def test_cylinder_has_no_axis_kwarg():
    from build123d import Cylinder

    with pytest.raises(TypeError):
        Cylinder(3, 10, axis=(1, 0, 0))


def test_cheatsheet_has_no_import_lines():
    text = CHEATSHEET.read_text(encoding="utf-8")
    for block in _FENCE.findall(text):
        for line in block.splitlines():
            assert not re.match(r"\s*(import|from)\s", line), line
