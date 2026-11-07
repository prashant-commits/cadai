"""Invalid solids never leave the runner as a success (f1).

mug_tree: every geometry step runs and the in-memory result is valid, but the exported STEP
re-imports with a face whose wires intersect. The runner re-reads its own STEP, tries a shape
fix, and, when none helps, writes the parts unfused as one multi-solid STEP (a kernel export
defect the model cannot repair). Only a part that is itself invalid fails the run.
"""
import os
import shutil

import pytest

from cadai_geo import run as geo

HERE = os.path.dirname(os.path.abspath(__file__))
MUG_TREE = os.path.join(HERE, "fixtures", "mug_tree_step_invalid.py")
PARTS = ["base", "post", "peg_1", "peg_2", "peg_3", "peg_4"]


def _boxes():
    from build123d import Align, Box, Pos

    a = Box(10, 10, 10, align=(Align.MIN, Align.MIN, Align.MIN))
    b = Pos(20, 0, 0) * Box(5, 5, 5, align=(Align.MIN, Align.MIN, Align.MIN))
    return a, b


def _part(label, shape):
    return geo._part(shape, label)


def test_mug_tree_fixture_is_valid_in_memory_and_invalid_after_step(tmp_path):
    """The reproduction: the repair attempt cannot make it valid, so it is a failure."""
    from build123d import import_step, export_step

    namespace = geo._run_script(MUG_TREE)
    result = namespace["result"]
    assert result.is_valid
    fixed, valid = geo._fixed_if_invalid(result)
    assert valid and fixed is result  # nothing to fix before export
    export_step(result, str(tmp_path / "a.step"))
    reread = import_step(str(tmp_path / "a.step"))
    assert not reread.is_valid
    assert not reread.fix().is_valid  # shape fixing does not repair it


NOTE = "STEP exported as separate solids (fused shape did not survive STEP export)"


def _assert_separate_valid_step(step_path):
    from build123d import import_step

    reread = import_step(step_path)
    assert reread.is_valid
    assert len(reread.solids()) == len(PARTS)
    assert [child.label for child in reread.children] == PARTS


def test_mug_tree_run_falls_back_to_separate_solids(tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    payload = geo.run(MUG_TREE, out)
    assert payload["ok"] is True
    assert payload["notes"] == [NOTE]
    assert payload["solids"] == len(PARTS)
    assert [part["label"] for part in payload["parts"]] == PARTS
    assert all(part["valid"] for part in payload["parts"])
    _assert_separate_valid_step(payload["step"])
    # The STL is still the fused shape.
    assert os.path.getsize(payload["stl"]) > 0
    assert open(payload["stl"]).read(5) == "solid"


def test_mug_tree_trusted_stage_falls_back_the_same_way(tmp_path):
    scratch = tmp_path / "scratch"
    out = tmp_path / "out"
    scratch.mkdir()
    out.mkdir()
    errors: list[str] = []
    geo.capture_geometry(MUG_TREE, str(scratch), errors.append)
    assert errors == []
    payload = geo.measure_and_export(str(scratch), str(out))
    assert payload["ok"] is True
    assert payload["notes"] == [NOTE]
    assert payload["solids"] == len(PARTS)
    assert sorted(os.listdir(out)) == ["model.step", "model.stl"]
    _assert_separate_valid_step(str(out / "model.step"))


def test_no_note_when_the_fused_step_survives(tmp_path):
    src = tmp_path / "model.py"
    src.write_text("from build123d import *\nresult = Box(5, 5, 5)\n")
    out = tmp_path / "out"
    out.mkdir()
    payload = geo.run(src, out)
    assert payload["ok"] is True and "notes" not in payload


def test_valid_model_still_exports(tmp_path):
    src = tmp_path / "model.py"
    src.write_text("from build123d import *\nresult = Box(5, 5, 5)\n")
    out = tmp_path / "out"
    out.mkdir()
    payload = geo.run(src, out)
    assert payload["ok"] is True
    assert os.path.getsize(payload["step"]) > 0 and os.path.getsize(payload["stl"]) > 0


class _Stub:
    """A shape-like object: ``is_valid`` and ``fix()``."""

    def __init__(self, valid, fixes_to=None):
        self.is_valid = valid
        self._fixes_to = fixes_to

    def fix(self):
        if self._fixes_to is None:
            raise RuntimeError("cannot fix")
        return self._fixes_to


def test_fixed_if_invalid_uses_the_fixed_shape_only_when_it_is_valid():
    good = _Stub(True)
    assert geo._fixed_if_invalid(good) == (good, True)
    repaired = _Stub(True)
    assert geo._fixed_if_invalid(_Stub(False, repaired)) == (repaired, True)
    still_bad = _Stub(False)
    broken = _Stub(False, still_bad)
    assert geo._fixed_if_invalid(broken) == (broken, False)
    unfixable = _Stub(False)  # fix() raises
    assert geo._fixed_if_invalid(unfixable) == (unfixable, False)


def test_part_marked_valid_when_the_fix_repairs_it(monkeypatch):
    a, _ = _boxes()
    monkeypatch.setattr(geo, "_fixed_if_invalid", lambda shape: (shape, False))
    assert geo._part(a, "lid")["valid"] is False
    monkeypatch.setattr(geo, "_fixed_if_invalid", lambda shape: (shape, True))
    assert geo._part(a, "lid")["valid"] is True


def test_invalid_part_is_named_and_nothing_is_exported(tmp_path):
    a, b = _boxes()
    parts = [_part("base", a), _part("lid", b)]
    parts[1]["valid"] = False
    step, stl = str(tmp_path / "m.step"), str(tmp_path / "m.stl")
    failure = geo._checked_export(a + b, parts, step, stl)
    assert failure["ok"] is False and failure["invalid"] == ["lid"]
    assert "part" in failure["error"] and "lid" in failure["error"]
    assert not os.path.exists(step) and not os.path.exists(stl)


def test_invalid_fused_result_in_memory_also_exports_the_parts_separately(tmp_path, monkeypatch):
    a, b = _boxes()
    parts = [_part("base", a), _part("lid", b)]
    real = geo._fixed_if_invalid
    fused = a + b
    monkeypatch.setattr(geo, "_fixed_if_invalid", lambda shape: (shape, False) if shape is fused else real(shape))
    extras: dict = {}
    step, stl = str(tmp_path / "m.step"), str(tmp_path / "m.stl")
    assert geo._checked_export(fused, parts, step, stl, [("base", a), ("lid", b)], extras) is None
    assert extras["notes"] == [NOTE] and extras["solids"] == 2
    assert os.path.getsize(step) > 0 and os.path.getsize(stl) > 0


def test_fails_naming_the_parts_when_even_the_separate_step_is_invalid(tmp_path, monkeypatch):
    a, b = _boxes()
    parts = [_part("base", a), _part("lid", b)]
    fused = a + b
    real = geo._fixed_if_invalid
    monkeypatch.setattr(geo, "_fixed_if_invalid", lambda shape: (shape, False) if shape is fused else real(shape))
    monkeypatch.setattr(geo, "_export_unfused_step", lambda shapes, path: None)
    step, stl = str(tmp_path / "m.step"), str(tmp_path / "m.stl")
    failure = geo._checked_export(fused, parts, step, stl, [("base", a), ("lid", b)], {})
    assert failure["ok"] is False
    assert failure["invalid"] == ["base", "lid"]
    assert not os.path.exists(step) and not os.path.exists(stl)


def test_step_round_trip_is_repaired_by_a_fix_when_the_fix_works(tmp_path, monkeypatch):
    import build123d

    a, _ = _boxes()
    parts = [_part("base", a)]
    real_import = build123d.import_step
    calls = {"n": 0}

    class Broken:
        is_valid = False

        def __init__(self, inner):
            self._inner = inner

        def fix(self):
            return self._inner

    def import_step(path):
        calls["n"] += 1
        shape = real_import(path)
        return Broken(shape) if calls["n"] == 1 else shape

    monkeypatch.setattr(build123d, "import_step", import_step)
    step, stl = str(tmp_path / "m.step"), str(tmp_path / "m.stl")
    assert geo._checked_export(a, parts, step, stl) is None
    assert calls["n"] == 2  # re-written from the fixed shape and checked again
    assert os.path.getsize(step) > 0 and os.path.getsize(stl) > 0


def test_ok_payload_has_no_invalid_key(tmp_path):
    src = tmp_path / "model.py"
    src.write_text("from build123d import *\nresult = Box(5, 5, 5)\n")
    out = tmp_path / "out"
    out.mkdir()
    assert "invalid" not in geo.run(src, out)


def test_step_label_is_printable_ascii_without_backslash_and_at_most_64():
    assert geo._step_label("base_plate") == "base_plate"
    cleaned = geo._step_label("\\X2\\\u00e9\x01\n'q'")
    assert cleaned.isascii() and cleaned.isprintable() and "\\" not in cleaned
    assert len(geo._step_label("x" * 500)) == 64
    assert geo._step_label("") == ""


def test_unfused_step_carries_only_sanitized_labels(tmp_path):
    from build123d import import_step

    a, b = _boxes()
    step = str(tmp_path / "m.step")
    assert geo._export_unfused_step([("ba\\se\u00e9\x01", a), ("l" * 200, b)], step) is not None
    text = open(step, encoding="utf-8").read()
    assert "\\X2\\" not in text and "\x01" not in text and "\u00e9" not in text
    assert [c.label for c in import_step(step).children] == ["ba_se__", "l" * 64]
