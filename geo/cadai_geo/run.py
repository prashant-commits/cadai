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
    return redact(line)


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


def _part(shape, label: str) -> dict:
    box = shape.bounding_box()
    return {
        "label": label or "",
        "valid": bool(shape.is_valid),
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


def _discard_geometry(scratch: str) -> None:
    """Remove BREP outputs in ``scratch``. Symlinks are unlinked, not followed."""
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
    import runpy
    from build123d import export_brep

    try:
        namespace = runpy.run_path(os.fspath(script_path), run_name="__main__")
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
    except Exception as exc:
        _discard_geometry(scratch)
        on_error(_last_line(exc))


def _measured_shapes(scratch: str, name: str) -> list[dict]:
    """Measure the BREPs in ``<scratch>/<name>``. Labels come from the index; numbers come from the shapes."""
    parts_dir = os.path.join(scratch, name)
    index_path = os.path.join(parts_dir, "index.json")
    loaded: list[dict] = []
    if regular_file_inside(index_path, parts_dir) and os.path.getsize(index_path) <= 1024 * 1024:
        with open(index_path, encoding="utf-8") as handle:
            entries = json.load(handle)
        if isinstance(entries, list) and entries:
            if len(entries) > 512:
                raise ValueError(name)
            from build123d import import_brep

            for entry in entries:
                if not isinstance(entry, dict):
                    raise ValueError(name)
                file = entry.get("file")
                if (
                    not isinstance(file, str)
                    or file != os.path.basename(file)
                    or file in ("", ".", "..")
                ):
                    raise ValueError(name)
                path = os.path.join(parts_dir, file)
                if not regular_file_inside(path, parts_dir):
                    raise ValueError(name)
                shape = import_brep(path)
                label = entry.get("label")
                if not isinstance(label, str):
                    label = ""
                loaded.append(_part(shape, label[:256]))
    return loaded


def _parts_from_scratch(scratch: str, result) -> list[dict]:
    loaded = _measured_shapes(scratch, "parts")
    if loaded:
        return loaded
    return [_part(solid, "") for solid in result.solids()]


def measure_and_export(scratch: str, outdir: str, fallback_error: str | None = None) -> dict:
    """Trusted stage: load BREP from ``scratch``, measure it, write exports into ``outdir``.

    Bytes that are not a BREP become ``ok: false``. A parsed shape is measured
    here; a ``result.json`` sitting in the scratch directory is never read.
    """
    result_path = os.path.join(scratch, "result.brep")
    if not regular_file_inside(result_path, scratch):
        message, line = split_error_line(fallback_error or "no geometry")
        failed: dict = {"ok": False, "error": message}
        if line:
            failed["line"] = line
        return failed
    try:
        from build123d import export_step, export_stl, import_brep

        result = import_brep(result_path)
        parts = _parts_from_scratch(scratch, result)
        local = _measured_shapes(scratch, "local")
        step_path = os.path.join(os.fspath(outdir), "model.step")
        stl_path = os.path.join(os.fspath(outdir), "model.stl")
        _replace_output(step_path)
        _replace_output(stl_path)
        if not export_step(result, step_path):
            return {"ok": False, "error": "export_step failed"}
        if not export_stl(result, stl_path, ascii_format=True):
            return {"ok": False, "error": "export_stl failed"}
        box = result.bounding_box()
        return {
            "ok": True,
            "parts": parts,
            "local": local,
            "solids": len(list(result.solids())),
            "bbox": {"min": _xyz(box.min), "max": _xyz(box.max)},
            "stl": None,
            "step": None,
        }
    except Exception:
        return {"ok": False, "error": "geometry"}


def run(script_path: str | os.PathLike, outdir: str | os.PathLike) -> dict:
    """Execute ``script_path`` and write ``model.step`` / ``model.stl`` into ``outdir``."""
    try:
        _remember_compound_sources()
        import runpy
        from build123d import export_step, export_stl

        try:
            namespace = runpy.run_path(os.fspath(script_path), run_name="__main__")
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
        if not export_step(result, step_path):
            return {"ok": False, "error": "export_step failed"}
        # ASCII so consumers that read the file as text (the web compile
        # route decodes STL as UTF-8) get a mesh that starts with "solid".
        if not export_stl(result, stl_path, ascii_format=True):
            return {"ok": False, "error": "export_stl failed"}
        box = result.bounding_box()
        return {
            "ok": True,
            "parts": _parts(result, namespace.get("_cadai_parts")),
            "local": _local(namespace),
            "solids": len(list(result.solids())),
            "bbox": {"min": _xyz(box.min), "max": _xyz(box.max)},
            "stl": stl_path,
            "step": step_path,
        }
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
    if len(args) != 3:
        payload = {"ok": False, "error": "usage: python -m cadai_geo <script.py> <outdir>"}
    else:
        os.makedirs(args[2], exist_ok=True)
        sink = io.StringIO()
        with contextlib.redirect_stdout(sink):
            payload = run(args[1], args[2])
            try:
                write_result(args[2], payload)
            except OSError:
                payload = {"ok": False, "error": "result file"}
    sys.stdout.write(json.dumps(payload) + "\n")


if __name__ == "__main__":
    main()
