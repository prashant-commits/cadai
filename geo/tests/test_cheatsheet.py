"""Execute every fenced Python example in the build123d cheat sheet."""

import re
from pathlib import Path

import pytest

CHEATSHEET = Path(__file__).resolve().parents[2] / "src" / "lib" / "brep" / "cheatsheet.md"
_FENCE = re.compile(r"```python\n(.*?)```", re.DOTALL)


def test_cheatsheet_examples_run():
    text = CHEATSHEET.read_text(encoding="utf-8")
    blocks = _FENCE.findall(text)
    assert blocks, f"no python fences in {CHEATSHEET}"
    namespace: dict = {}
    for index, block in enumerate(blocks, start=1):
        exec(compile(block, f"{CHEATSHEET.name}#block{index}", "exec"), namespace)


def test_cylinder_has_no_axis_kwarg():
    from build123d import Cylinder

    with pytest.raises(TypeError):
        Cylinder(3, 10, axis=(1, 0, 0))
