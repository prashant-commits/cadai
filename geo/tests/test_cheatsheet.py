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


def test_cylinder_has_no_axis_kwarg():
    from build123d import Cylinder

    with pytest.raises(TypeError):
        Cylinder(3, 10, axis=(1, 0, 0))


def test_cheatsheet_has_no_import_lines():
    text = CHEATSHEET.read_text(encoding="utf-8")
    for block in _FENCE.findall(text):
        for line in block.splitlines():
            assert not re.match(r"\s*(import|from)\s", line), line
