"""Run a build123d script and report measurements plus STEP and STL paths.

CLI: ``python -I -m cadai_geo <script.py> <outdir>`` prints one JSON line and
writes the same object to ``<outdir>/result.json``. The HTTP service reads
only that file. The script must assign ``result`` (a Part or a Compound).
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shutil
import stat
import sys
import traceback
from collections.abc import Sequence

# Temp script paths and /tmp directories must not leak back to the caller.
# ``redact`` also strips the live ``TMPDIR`` prefix. Popping an environment
# variable does not rewrite ``/proc/<pid>/environ``, so this is only a
# display filter.
_MODEL_PY = re.compile(r"\S*[/\\]model\.py")
_TMP_LEAK = re.compile(r"/tmp/\S+")
# 512 used to reject a 600-part model as "geometry". 4096 covers 1000 parts
# with room; the index cap scales with that (about 2 KB per entry).
_MAX_PARTS = 4096
_MAX_INDEX_BYTES = 8 * 1024 * 1024
_MAX_BREP_BYTES = 256 * 1024 * 1024

# build123d's Compound([shapes]) keeps only the OCC topology, so labels set on
# the Python shapes are dropped. Remember the shapes that were passed in.
_RECORDER_FLAG = "_cadai_sources"


def redact(text: str) -> str:
    """Drop temp-file paths from an error string.

    ``/tmp/...`` and ``.../model.py`` are always removed. When ``TMPDIR`` is
    an absolute path other than ``/tmp``, that prefix is removed too.
    """
    text = _TMP_LEAK.sub("[redacted]", text)
    text = _MODEL_PY.sub("[redacted]", text)
    prefix = os.environ.get("TMPDIR", "").strip().rstrip("/\\")
    if prefix.startswith("/") and len(prefix) > 1 and prefix != "/tmp":
        text = re.sub(re.escape(prefix) + r"/\S*", "[redacted]", text)
    return text


def _last_line(exc: BaseException) -> str:
    text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    line = lines[-1] if lines else f"{type(exc).__name__}: {exc}"
    # The line-number prefix below is ours alone: an exception message cannot carry one.
    return redact(line).replace("␟", "�")


# A failed run reports the innermost line of the script that raised. The untrusted stage can only
# pass a string to the trusted one, so the line travels as a prefix of the error message.
_LINE_PREFIX = "\u241fL"
_LINE_SUFFIX = "\u241f"
_LINE_PATTERN = re.compile("^\u241fL(\\d{1,7})\u241f(.*)$", re.DOTALL)


def _script_line(exc: BaseException, script_path: str) -> int | None:
    """Innermost line in the script itself that the traceback passes through."""
    lines = [
        frame.lineno
        for frame in traceback.extract_tb(exc.__traceback__)
        if frame.filename == script_path and frame.lineno
    ]
    # A SyntaxError carries its own position and no frame in the script.
    if isinstance(exc, SyntaxError) and exc.filename == script_path and exc.lineno:
        lines.append(exc.lineno)
    return lines[-1] if lines else None


def _error_with_line(exc: BaseException, script_path: str) -> str:
    message = _last_line(exc)
    line = _script_line(exc, script_path)
    return f"{_LINE_PREFIX}{line}{_LINE_SUFFIX}{message}" if line else message


def split_error_line(text: str) -> tuple[str, int | None]:
    """Undo ``_error_with_line``: the message, and the line when the prefix is well formed."""
    match = _LINE_PATTERN.match(text)
    if not match:
        return text, None
    line = int(match.group(1))
    return match.group(2), (line if line > 0 else None)


def _shape_list(value: object, allow_empty: bool = False) -> list | None:
    """``value`` as a list of shapes when it is a list or tuple of shapes, else None."""
    if not isinstance(value, (list, tuple)) or (not value and not allow_empty):
        return None
    if not all(hasattr(item, "bounding_box") and hasattr(item, "wrapped") for item in value):
        return None
    return list(value)


# ---- the script's namespace

# Builtins a geometry script needs. Everything else (open, exec, eval, compile, getattr,
# globals, vars, type, object, __build_class__, ...) is absent. This is defense in depth
# behind the body check; the process sandbox is the security boundary.
_SAFE_BUILTIN_NAMES = (
    "abs", "min", "max", "round", "range", "len", "enumerate", "zip", "sum", "list", "tuple",
    "dict", "set", "frozenset", "float", "int", "bool", "str", "sorted", "reversed", "map",
    "filter", "any", "all", "isinstance", "print", "pow", "divmod", "slice", "next", "iter",
    "hasattr", "callable", "chr", "ord", "bytes", "hash",
    "Exception", "ValueError", "TypeError", "ZeroDivisionError", "ArithmeticError",
    "IndexError", "KeyError", "RuntimeError", "AssertionError", "NotImplementedError",
    "StopIteration",
    "True", "False", "None",
)
# The emitted prelude imports these, and nothing else.
_IMPORTABLE = ("build123d", "math")

# Test-only: the b1 sandbox tests run escape probes (import os, fork, sleep) to prove the process
# sandbox holds against a script that has full Python. Read once at import, from the service's own
# environment (a script's environment is cleared before it runs). Never set it in a deployment.
def _test_full_builtins_requested(environ=os.environ) -> bool:
    """The switch counts only inside a pytest run (PYTEST_CURRENT_TEST is set by pytest)."""
    return environ.get("CADAI_GEO_TEST_FULL_BUILTINS") == "1" and bool(environ.get("PYTEST_CURRENT_TEST"))


_FULL_BUILTINS = _test_full_builtins_requested()
if _FULL_BUILTINS:
    print("cadai_geo: CADAI_GEO_TEST_FULL_BUILTINS=1, scripts get full builtins (tests only)", file=sys.stderr)


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0 or name not in _IMPORTABLE:
        raise ImportError(f"import of {name} is not allowed")
    import importlib

    return importlib.import_module(name)


def _thinnest_wall(shape) -> float | None:
    from build123d import GeomType
    try:
        planar = [f for f in shape.faces() if f.geom_type == GeomType.PLANE]
        min_w = float("inf")
        for f in planar:
            iw_list = f.inner_wires()
            if iw_list:
                ow_bb = f.outer_wire().bounding_box()
                for iw in iw_list:
                    iw_bb = iw.bounding_box()
                    for d in (
                        iw_bb.min.X - ow_bb.min.X,
                        ow_bb.max.X - iw_bb.max.X,
                        iw_bb.min.Y - ow_bb.min.Y,
                        ow_bb.max.Y - iw_bb.max.Y,
                    ):
                        if 1e-3 < d < min_w:
                            min_w = d
        faces_to_check = planar[:30]
        for i, f1 in enumerate(faces_to_check):
            n1 = f1.normal_at(f1.center())
            for f2 in faces_to_check[i + 1 :]:
                n2 = f2.normal_at(f2.center())
                if (n1 + n2).length < 1e-4:
                    d = abs((f2.center() - f1.center()).dot(n1))
                    if 1e-3 < d < min_w:
                        min_w = d
        if min_w < float("inf"):
            return min_w
    except Exception:
        pass
    try:
        bb = shape.bounding_box()
        min_dim = min(bb.size.X, bb.size.Y, bb.size.Z)
        if min_dim > 1e-3:
            return min_dim
    except Exception:
        pass
    return None


def _select_edges(shape, edges="outer"):
    if not isinstance(edges, str):
        return edges
    from build123d import Axis
    if edges == "all":
        return shape.edges()
    elif edges == "vertical":
        return shape.edges().filter_by(Axis.Z)
    elif edges == "top":
        max_z = shape.bounding_box().max.Z
        top_faces = shape.faces().filter_by_position(Axis.Z, max_z - 1e-3, max_z + 1e-3)
        if not top_faces:
            top_faces = [shape.faces().sort_by(Axis.Z)[-1]]
        edges_out = []
        for face in top_faces:
            try:
                edges_out.extend(face.outer_wire().edges())
            except Exception:
                edges_out.extend(face.edges())
        return edges_out if edges_out else shape.edges()
    elif edges == "outer":
        bb = shape.bounding_box()
        tol = 1e-3
        outer = [
            e for e in shape.edges()
            if (
                abs(e.bounding_box().min.X - bb.min.X) < tol
                or abs(e.bounding_box().max.X - bb.max.X) < tol
                or abs(e.bounding_box().min.Y - bb.min.Y) < tol
                or abs(e.bounding_box().max.Y - bb.max.Y) < tol
            )
            and not (abs(e.bounding_box().max.Z - bb.min.Z) < tol)
        ]
        return outer if outer else shape.edges()
    return shape.edges()


def _make_round(notes: list):
    def _round(shape, r, edges="outer"):
        import math
        if not isinstance(r, (int, float)) or math.isnan(r) or r <= 0:
            return shape
        from build123d import fillet
        targets = _select_edges(shape, edges)
        if not targets:
            return shape
        min_dim = 0.0
        try:
            bb = shape.bounding_box()
            min_dim = min(bb.size.X, bb.size.Y, bb.size.Z)
            if min_dim > 0 and r >= min_dim / 2:
                notes.append(f"_round skipped: radius {r}mm exceeds half of minimum dimension {min_dim}mm")
                return shape
        except Exception:
            pass
        try:
            wall = _thinnest_wall(shape)
            if wall is not None and wall < min_dim and r >= wall / 2:
                r = (wall / 2) * 0.95
        except Exception:
            pass
        curr_r = float(r)
        last_exc = None
        for attempt in range(4):
            try:
                out = fillet(targets, curr_r)
                if out.is_valid:
                    return out
            except Exception as e:
                last_exc = e
            curr_r /= 2.0
            if curr_r < 0.05:
                break
        msg = (
            f"_round failed ({type(last_exc).__name__}: {last_exc}); returned unrounded shape"
            if last_exc is not None
            else f"_round produced invalid shape on {edges} edges; returned unrounded shape"
        )
        notes.append(msg)
        return shape
    return _round


def _make_bevel(notes: list):
    def _bevel(shape, d, edges="outer"):
        import math
        if not isinstance(d, (int, float)) or math.isnan(d) or d <= 0:
            return shape
        from build123d import chamfer
        targets = _select_edges(shape, edges)
        if not targets:
            return shape
        min_dim = 0.0
        try:
            bb = shape.bounding_box()
            min_dim = min(bb.size.X, bb.size.Y, bb.size.Z)
            if min_dim > 0 and d >= min_dim / 2:
                notes.append(f"_bevel skipped: chamfer {d}mm exceeds half of minimum dimension {min_dim}mm")
                return shape
        except Exception:
            pass
        try:
            wall = _thinnest_wall(shape)
            if wall is not None and wall < min_dim and d >= wall / 2:
                d = (wall / 2) * 0.95
        except Exception:
            pass
        curr_d = float(d)
        last_exc = None
        for attempt in range(4):
            try:
                out = chamfer(targets, curr_d)
                if out.is_valid:
                    return out
            except Exception as e:
                last_exc = e
            curr_d /= 2.0
            if curr_d < 0.05:
                break
        msg = (
            f"_bevel failed ({type(last_exc).__name__}: {last_exc}); returned unbeveled shape"
            if last_exc is not None
            else f"_bevel produced invalid shape on {edges} edges; returned unbeveled shape"
        )
        notes.append(msg)
        return shape
    return _bevel


def script_globals(full: bool | None = None) -> dict:
    """Initial globals for a geometry script: curated builtins, build123d's names and math."""
    import builtins
    import math

    import build123d

    if _FULL_BUILTINS if full is None else full:
        namespace: dict = {}
    else:
        safe = {name: getattr(builtins, name) for name in _SAFE_BUILTIN_NAMES if hasattr(builtins, name)}
        safe["__import__"] = _safe_import
        namespace = {"__builtins__": safe}
    for name in getattr(build123d, "__all__", ()):
        if hasattr(build123d, name):
            namespace[name] = getattr(build123d, name)
    for name in ("sin", "cos", "tan", "radians", "degrees", "sqrt", "pi", "atan2", "hypot"):
        namespace[name] = getattr(math, name)
    notes_list: list[str] = []
    namespace["_cadai_notes"] = notes_list
    namespace["_select_edges"] = _select_edges
    namespace["_round"] = _make_round(notes_list)
    namespace["_bevel"] = _make_bevel(notes_list)
    return namespace


def _run_script(script_path: str) -> dict:
    import runpy

    return runpy.run_path(script_path, init_globals=script_globals(), run_name="__main__")


def _shape_sources(obj: object) -> list | None:
    if not isinstance(obj, Sequence) or isinstance(obj, (str, bytes)):
        return None
    if not all(hasattr(item, "label") and hasattr(item, "wrapped") for item in obj):
        return None
    return list(obj)


def _remember_compound_sources() -> None:
    from build123d import Compound

    init = Compound.__init__
    if getattr(init, "_cadai_recorder", False):
        return

    def wrapped(self, obj=None, *args, **kwargs):
        sources = _shape_sources(obj)
        init(self, obj, *args, **kwargs)
        if sources is not None:
            setattr(self, _RECORDER_FLAG, sources)

    wrapped._cadai_recorder = True
    Compound.__init__ = wrapped


def _xyz(vector) -> list[float]:
    return [float(vector.X), float(vector.Y), float(vector.Z)]


def _fixed_if_invalid(shape):
    """``(shape, True)`` when valid; else the OCC-fixed shape when that is valid; else ``(shape, False)``."""
    try:
        if shape.is_valid:
            return shape, True
    except Exception:
        return shape, False
    try:
        fixed = shape.fix()
        if fixed is not None and fixed.is_valid:
            return fixed, True
    except Exception:
        pass
    return shape, False


def _part(shape, label: str) -> dict:
    box = shape.bounding_box()
    return {
        "label": label or "",
        # An invalid part gets one shape-fix attempt before it is called invalid.
        "valid": _fixed_if_invalid(shape)[1],
        "volume": float(shape.volume),
        "min": _xyz(box.min),
        "max": _xyz(box.max),
    }


def _parts(result, measured=None) -> list[dict]:
    # The emitter binds the labelled, placed, pre-fusion parts to ``_cadai_parts``;
    # measure those, not the fused result.
    listed = _shape_list(measured)
    if listed is not None:
        return [_part(item, getattr(item, "label", "") or "") for item in listed]
    children = list(getattr(result, "children", []) or [])
    sources = getattr(result, _RECORDER_FLAG, None)
    if children:
        return [_part(child, getattr(child, "label", "") or "") for child in children]
    if sources is not None:
        return [_part(shape, getattr(shape, "label", "") or "") for shape in sources]
    return [_part(solid, "") for solid in result.solids()]


def _local(namespace: dict) -> list[dict]:
    """Labelled shapes in their own frames, before placement, when the script lists them in ``_local``."""
    shapes = _shape_list(namespace.get("_local"), allow_empty=True) or []
    return [_part(shape, getattr(shape, "label", "") or "") for shape in shapes]


def regular_file_inside(path: str, root: str) -> bool:
    """True when ``path`` is a regular file whose real path stays inside ``root``."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        return False
    root_real = os.path.realpath(root)
    real = os.path.realpath(path)
    try:
        inside = os.path.commonpath([real, root_real]) == root_real
    except ValueError:
        return False
    return inside and os.path.basename(real) == os.path.basename(path)


def _replace_output(path: str) -> None:
    """Remove anything already at ``path`` so export cannot follow a symlink."""
    if os.path.lexists(path):
        os.unlink(path)


def _part_shapes(result, measured=None) -> list[tuple[str, object]]:
    """Same part selection as ``_parts``: the script's ``_cadai_parts``, children, remembered sources, else solids."""
    listed = _shape_list(measured)
    children = list(getattr(result, "children", []) or [])
    sources = getattr(result, _RECORDER_FLAG, None)
    if listed is not None:
        shapes = listed
    elif children:
        shapes = children
    elif sources is not None:
        shapes = list(sources)
    else:
        shapes = list(result.solids())
    return [(getattr(shape, "label", "") or "", shape) for shape in shapes]


def _intersection_volume(shape_a, shape_b) -> float:
    try:
        common = shape_a & shape_b
    except Exception:
        try:
            common = shape_a.intersect(shape_b)
        except Exception:
            return 0.0
    if common is None:
        return 0.0
    try:
        if hasattr(common, "solids"):
            solids = list(common.solids())
            if solids:
                return float(sum(s.volume for s in solids))
            return 0.0
        return float(getattr(common, "volume", 0.0) or 0.0)
    except Exception:
        return 0.0


def compute_interferences(part_shapes: list[tuple[str, object]]) -> list[dict]:
    """Pairwise intersections of labelled parts (cap 40 parts, skip pairs whose bboxes do not overlap)."""
    labelled = [(label, shape) for label, shape in part_shapes if label][:40]
    if len(labelled) < 2:
        return []

    boxes = []
    for label, shape in labelled:
        try:
            bb = shape.bounding_box()
            boxes.append((_xyz(bb.min), _xyz(bb.max)))
        except Exception:
            boxes.append((None, None))

    interferences = []
    tol = 1e-4
    for i in range(len(labelled)):
        label_a, shape_a = labelled[i]
        box_a = boxes[i]
        if box_a[0] is None:
            continue
        for j in range(i + 1, len(labelled)):
            label_b, shape_b = labelled[j]
            box_b = boxes[j]
            if box_b[0] is None:
                continue
            overlap = True
            for d in range(3):
                if max(box_a[0][d], box_b[0][d]) >= min(box_a[1][d], box_b[1][d]) - tol:
                    overlap = False
                    break
            if not overlap:
                continue
            vol = _intersection_volume(shape_a, shape_b)
            if vol > tol:
                interferences.append({
                    "a": label_a,
                    "b": label_b,
                    "volume": round(vol, 4),
                })
    return interferences


# ---- validity: every exported solid must be valid, before and after the STEP round trip

def _names_in(shape, parts: list[dict]) -> list[str]:
    """Labels of the parts that sit inside an invalid solid of ``shape`` (all labels when none is singled out)."""
    try:
        solids = [solid for solid in shape.solids() if not solid.is_valid] or [shape]
    except Exception:
        solids = [shape]
    tol = 0.05
    names: list[str] = []
    for part in parts:
        label = part.get("label") or ""
        if not label or label in names:
            continue
        for solid in solids:
            try:
                box = solid.bounding_box()
            except Exception:
                continue
            low, high = _xyz(box.min), _xyz(box.max)
            if all(low[i] - tol <= part["min"][i] and part["max"][i] <= high[i] + tol for i in range(3)):
                names.append(label)
                break
    return names or [p["label"] for p in parts if p.get("label")] or ["result"]


def _invalid(names: list[str], what: str, parts: list[dict]) -> dict:
    listed = ", ".join(names)
    return {
        "ok": False,
        "error": f"invalid solid: {what} ({listed}); the kernel could not repair it",
        "invalid": names,
        "parts": parts,
    }


def _discard_exports(*paths: str) -> None:
    for path in paths:
        _replace_output(path)


_LABEL_MAX = 64


def _step_label(label: str) -> str:
    """A label that is safe to write into a STEP file: printable ASCII, no backslash, at most 64 characters."""
    cleaned = re.sub(r"[^\x20-\x7e]|\\", "_", str(label))
    return cleaned[:_LABEL_MAX]


_FUSED_STEP_NOTE = "STEP exported as separate solids (fused shape did not survive STEP export)"


def _export_unfused_step(part_shapes: list[tuple[str, object]], step_path: str):
    """Write the individually valid parts as one multi-solid STEP, labels kept.

    Returns the re-imported shape when it is valid, else None. The parts are the same shapes
    that were measured, each after its own shape-fix attempt.
    """
    from build123d import Compound, export_step, import_step

    children = []
    for label, shape in part_shapes:
        shape, valid = _fixed_if_invalid(shape)
        if not valid:
            return None
        try:
            shape.label = _step_label(label)
        except Exception:
            pass
        children.append(shape)
    if not children:
        return None
    if not export_step(Compound(children=children, label="parts"), step_path):
        return None
    reread = import_step(step_path)
    return reread if reread.is_valid else None


def _checked_export(
    result,
    parts: list[dict],
    step_path: str,
    stl_path: str,
    part_shapes: list[tuple[str, object]] | None = None,
    extras: dict | None = None,
) -> dict | None:
    """Validate, try to fix, then export ``result``. None on success; else the failure payload.

    A part that is invalid (after one OCC shape-fix attempt) fails the run and is named: the
    model can fix its own geometry. The fused result is different: when it is invalid, or valid
    in memory but invalid after the STEP round trip, and no fix helps, that is a kernel defect
    the model cannot repair. The STEP is then written as the parts, unfused, in one multi-solid
    file and re-checked; ``extras`` gets a note and the solid count, and the STL stays the fused
    shape. Only when that file is invalid too is the run a failure, naming the parts.
    """
    from build123d import export_step, export_stl, import_step

    bad = [part["label"] or "(unlabelled)" for part in parts if not part["valid"]]
    if bad:
        return _invalid(bad, "part" if len(bad) == 1 else "parts", parts)
    result, fused_ok = _fixed_if_invalid(result)

    reread = None
    for attempt in range(2 if fused_ok else 0):
        if not export_step(result, step_path):
            return {"ok": False, "error": "export_step failed"}
        reread = import_step(step_path)
        if reread.is_valid:
            break
        if attempt == 0:
            # Valid in memory, invalid after the STEP round trip: fix what was read back and write it again.
            repaired, fixed = _fixed_if_invalid(reread)
            if fixed:
                result = repaired
                continue
        fused_ok = False
        break

    if not fused_ok:
        _discard_exports(step_path, stl_path)
        separate = _export_unfused_step(part_shapes or [], step_path)
        if separate is None:
            _discard_exports(step_path, stl_path)
            return _invalid(
                _names_in(reread if reread is not None else result, parts),
                "the parts do not export as a valid STEP, fused or separate",
                parts,
            )
        if extras is not None:
            existing = extras.get("notes", [])
            extras["notes"] = existing + [_FUSED_STEP_NOTE]
            extras["solids"] = len(list(separate.solids()))
    # ASCII so consumers that read the file as text (the web compile
    # route decodes STL as UTF-8) get a mesh that starts with "solid".
    if not export_stl(result, stl_path, ascii_format=True):
        _discard_exports(step_path, stl_path)
        return {"ok": False, "error": "export_stl failed"}
    return None


def _exit_message(exc: SystemExit) -> str:
    code = exc.code
    if isinstance(code, int) and code != 0:
        return f"script exited: {code}"
    return "script exited"


def _discard_geometry(scratch: str) -> None:
    """Remove BREP outputs in ``scratch``. Symlinks are unlinked, not followed."""
    try:
        info = os.lstat(scratch)
    except OSError:
        return
    # A scratch path the script replaced with a symlink is not a directory
    # we created. Do not walk it.
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        return
    result_path = os.path.join(scratch, "result.brep")
    if os.path.lexists(result_path):
        if os.path.islink(result_path) or not os.path.isdir(result_path):
            os.unlink(result_path)
        else:
            shutil.rmtree(result_path)
    for name in ("parts", "local"):
        directory = os.path.join(scratch, name)
        if os.path.islink(directory):
            os.unlink(directory)
        elif os.path.isdir(directory):
            shutil.rmtree(directory)
    notes_path = os.path.join(scratch, "notes.json")
    if os.path.lexists(notes_path):
        os.unlink(notes_path)


def _write_shapes(scratch: str, name: str, shapes: list[tuple[str, object]]) -> bool:
    """Write ``<scratch>/<name>/NNNN.brep`` and ``index.json``. False when an export fails."""
    from build123d import export_brep

    directory = os.path.join(scratch, name)
    os.makedirs(directory, mode=0o700)
    index = []
    for number, (label, shape) in enumerate(shapes):
        file = f"{number:04d}.brep"
        if not export_brep(shape, os.path.join(directory, file)):
            return False
        index.append({"label": label or "", "file": file})
    with open(os.path.join(directory, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(index, handle)
    return True


def capture_geometry(script_path: str, scratch: str, on_error) -> None:
    """Run the script and write BREP only.

    This is the untrusted stage. It does not write ``result.json``, STEP, or
    STL, and it does not receive the service outdir. ``on_error`` is called
    with a redacted message when the script fails and our code is still
    running. A script that ``os._exit``s leaves whatever it planted in
    ``scratch``; the trusted stage must treat that as untrusted bytes.
    """
    _remember_compound_sources()
    from build123d import export_brep

    try:
        namespace = _run_script(os.fspath(script_path))
    except SystemExit as exc:
        _discard_geometry(scratch)
        on_error(_exit_message(exc))
        return
    except Exception as exc:
        _discard_geometry(scratch)
        on_error(_error_with_line(exc, os.fspath(script_path)))
        return
    if "result" not in namespace:
        _discard_geometry(scratch)
        on_error("assign result")
        return
    try:
        _discard_geometry(scratch)
        result = namespace["result"]
        result_path = os.path.join(scratch, "result.brep")
        if not export_brep(result, result_path):
            _discard_geometry(scratch)
            on_error("export_brep failed")
            return
        if not _write_shapes(
            scratch, "parts", _part_shapes(result, namespace.get("_cadai_parts"))
        ):
            _discard_geometry(scratch)
            on_error("export_brep failed")
            return
        # Each component in its own frame, before placement, when the script lists it.
        listed = _shape_list(namespace.get("_local"))
        local = [(getattr(shape, "label", "") or "", shape) for shape in listed or []]
        if local and not _write_shapes(scratch, "local", local):
            _discard_geometry(scratch)
            on_error("export_brep failed")
            return
        cadai_notes = namespace.get("_cadai_notes")
        if isinstance(cadai_notes, list) and cadai_notes:
            notes_path = os.path.join(scratch, "notes.json")
            capped = [str(n)[:500] for n in cadai_notes[:50] if n]
            if capped:
                with open(notes_path, "w", encoding="utf-8") as handle:
                    json.dump(capped, handle)
    except SystemExit as exc:
        _discard_geometry(scratch)
        on_error(_exit_message(exc))
    except Exception as exc:
        _discard_geometry(scratch)
        on_error(_last_line(exc))


def _open_directory(path: str) -> int:
    """Open a real directory. A symlink raises ``OSError`` and is not followed."""
    return os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)


def _read_regular_at(dir_fd: int, name: str, max_bytes: int) -> bytes | None:
    """Read one regular file under ``dir_fd``.

    ``None`` means the name does not exist. A symlink, a non-regular file, or
    an oversized file raises ``ValueError`` so the caller reports ``measure``
    and does not follow the link.
    """
    if (
        not isinstance(name, str)
        or name != os.path.basename(name)
        or "/" in name
        or "\\" in name
        or name in ("", ".", "..")
    ):
        raise ValueError("measure")
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ValueError("measure") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("measure")
        if info.st_size > max_bytes:
            raise ValueError("measure")
        return os.read(fd, info.st_size)
    finally:
        os.close(fd)


def _import_brep_bytes(data: bytes, outdir: str):
    """Import BREP bytes that were read from an already-open, no-follow fd.

    OCC wants a filesystem path. The copy lives in the trusted outdir, which
    the run uid cannot write, and it is removed after the import.
    """
    from build123d import import_brep

    dest = os.path.join(os.fspath(outdir), ".cadai-load.brep")
    _replace_output(dest)
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short write")
            view = view[written:]
    finally:
        os.close(fd)
    try:
        return import_brep(dest)
    finally:
        _replace_output(dest)


def _measured_shapes(
    scratch_fd: int, outdir: str, name: str, strict: bool, shapes_out: list | None = None
) -> list[dict] | None:
    """Measure the BREPs in <scratch>/<name>. Labels come from the index; numbers come from the shapes.

    Every read is no-follow and fstat-checked. None means there is no such directory or no
    entries. strict (parts/): a symlinked directory or index, an oversized file or any bad
    entry is a measure failure. Otherwise (local/) a bad entry, or the whole directory when it
    cannot be read safely, is dropped and logged, and the run goes on.
    """

    def bad(reason: str) -> None:
        if strict:
            raise ValueError("measure")
        print(f"cadai_geo: dropped {name}/ entry: {reason}", file=sys.stderr)

    try:
        dir_fd = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=scratch_fd,
        )
    except FileNotFoundError:
        return None
    except OSError as exc:
        if strict:
            raise ValueError("measure") from exc
        bad("directory is not a real directory")
        return None
    try:
        try:
            raw = _read_regular_at(dir_fd, "index.json", _MAX_INDEX_BYTES)
            entries = json.loads(raw.decode("utf-8")) if raw else None
        except (ValueError, UnicodeDecodeError):
            bad("index.json is not a readable JSON file")
            return None
        if not isinstance(entries, list) or not entries:
            return None
        if len(entries) > _MAX_PARTS:
            bad(f"more than {_MAX_PARTS} entries")
            return None
        loaded = []
        for entry in entries:
            if not isinstance(entry, dict):
                bad("entry is not an object")
                continue
            try:
                data = _read_regular_at(dir_fd, entry.get("file"), _MAX_BREP_BYTES)
            except ValueError:
                bad("file is not a plain regular file of allowed size")
                continue
            if data is None:
                bad("file is missing")
                continue
            try:
                shape = _import_brep_bytes(data, outdir)
            except Exception:
                if strict:
                    raise
                bad("file is not a BREP shape")
                continue
            label = entry.get("label")
            if not isinstance(label, str):
                label = ""
            loaded.append(_part(shape, label[:256]))
            if shapes_out is not None:
                shapes_out.append((label[:256], shape))
        return loaded
    finally:
        os.close(dir_fd)


def _parts_from_scratch(scratch_fd: int, outdir: str, result, shapes_out: list | None = None) -> list[dict]:
    """Measure part BREPs. A missing parts directory falls back to unlabeled solids.

    A symlinked parts directory or index is a measure failure.
    """
    loaded = _measured_shapes(scratch_fd, outdir, "parts", strict=True, shapes_out=shapes_out)
    if loaded:
        return loaded
    solids = list(result.solids())
    if shapes_out is not None:
        shapes_out.extend(("", solid) for solid in solids)
    return [_part(solid, "") for solid in solids]


def measure_and_export(
    scratch: str, outdir: str, fallback_error: str | None = None, interferences: bool = False
) -> dict:
    """Trusted stage: load BREP from ``scratch``, measure it, write exports into ``outdir``.

    Bytes that are not a BREP become ``ok: false`` with error ``measure``.
    A parsed shape is measured here; a ``result.json`` sitting in the scratch
    directory is never read. ``scratch`` itself is opened with ``O_NOFOLLOW``,
    so a symlink planted in place of that directory is not followed.
    """
    try:
        scratch_fd = _open_directory(scratch)
    except OSError:
        return {"ok": False, "error": "measure"}
    try:
        try:
            data = _read_regular_at(scratch_fd, "result.brep", _MAX_BREP_BYTES)
        except ValueError:
            return {"ok": False, "error": "measure"}
        if data is None:
            message, line = split_error_line(fallback_error or "no geometry")
            failed: dict = {"ok": False, "error": message}
            if line:
                failed["line"] = line
            return failed
        try:
            result = _import_brep_bytes(data, outdir)
            part_shapes: list = []
            parts = _parts_from_scratch(scratch_fd, outdir, result, part_shapes)
            local = _measured_shapes(scratch_fd, outdir, "local", strict=False) or []
            step_path = os.path.join(os.fspath(outdir), "model.step")
            stl_path = os.path.join(os.fspath(outdir), "model.stl")
            _replace_output(step_path)
            _replace_output(stl_path)
            extras: dict = {}
            failure = _checked_export(result, parts, step_path, stl_path, part_shapes, extras)
            if failure is not None:
                return failure
            try:
                notes_bytes = _read_regular_at(scratch_fd, "notes.json", 64 * 1024)
                if notes_bytes:
                    loaded = json.loads(notes_bytes.decode("utf-8"))
                    if isinstance(loaded, list) and loaded:
                        existing = extras.get("notes", [])
                        extras["notes"] = existing + [str(n) for n in loaded if n]
            except Exception:
                pass
            box = result.bounding_box()
            payload = {
                "ok": True,
                "parts": parts,
                "local": local,
                "solids": len(list(result.solids())),
                "bbox": {"min": _xyz(box.min), "max": _xyz(box.max)},
                "stl": None,
                "step": None,
                **extras,
            }
            if interferences:
                payload["interferences"] = compute_interferences(part_shapes)
            return payload
        except Exception:
            return {"ok": False, "error": "measure"}
    finally:
        os.close(scratch_fd)


def run(script_path: str | os.PathLike, outdir: str | os.PathLike, interferences: bool = False) -> dict:
    """Execute ``script_path`` and write ``model.step`` / ``model.stl`` into ``outdir``."""
    try:
        os.makedirs(outdir, exist_ok=True)
        _remember_compound_sources()

        try:
            namespace = _run_script(os.fspath(script_path))
        except Exception as exc:
            failed = {"ok": False, "error": _last_line(exc)}
            line = _script_line(exc, os.fspath(script_path))
            if line:
                failed["line"] = line
            return failed
        if "result" not in namespace:
            return {"ok": False, "error": "assign result"}

        result = namespace["result"]
        step_path = os.path.join(os.fspath(outdir), "model.step")
        stl_path = os.path.join(os.fspath(outdir), "model.stl")
        _replace_output(step_path)
        _replace_output(stl_path)
        parts = _parts(result, namespace.get("_cadai_parts"))
        part_shapes = _part_shapes(result, namespace.get("_cadai_parts"))
        extras: dict = {}
        failure = _checked_export(
            result, parts, step_path, stl_path, part_shapes, extras
        )
        if failure is not None:
            return failure
        cadai_notes = namespace.get("_cadai_notes")
        if isinstance(cadai_notes, list) and cadai_notes:
            existing = extras.get("notes", [])
            extras["notes"] = existing + [str(n) for n in cadai_notes if n]
        box = result.bounding_box()
        payload = {
            "ok": True,
            "parts": parts,
            "local": _local(namespace),
            "solids": len(list(result.solids())),
            "bbox": {"min": _xyz(box.min), "max": _xyz(box.max)},
            "stl": stl_path,
            "step": step_path,
            **extras,
        }
        if interferences:
            payload["interferences"] = compute_interferences(part_shapes)
        return payload
    except Exception as exc:
        return {"ok": False, "error": _last_line(exc)}


def write_result(outdir: str | os.PathLike, payload: dict) -> None:
    """Atomically write ``<outdir>/result.json`` after the script has returned."""
    path = os.path.join(os.fspath(outdir), "result.json")
    temporary = path + ".tmp"
    _replace_output(path)
    if os.path.lexists(temporary):
        os.unlink(temporary)
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
    os.replace(temporary, path)


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv if argv is None else argv)
    interferences = "--interferences" in args
    if interferences:
        args.remove("--interferences")
    if len(args) != 3:
        payload = {"ok": False, "error": "usage: python -m cadai_geo <script.py> <outdir> [--interferences]"}
    else:
        os.makedirs(args[2], exist_ok=True)
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink):
            payload = run(args[1], args[2], interferences=interferences)
            try:
                write_result(args[2], payload)
            except OSError:
                payload = {"ok": False, "error": "result file"}
    sys.stdout.write(json.dumps(payload) + "\n")


if __name__ == "__main__":
    main()
