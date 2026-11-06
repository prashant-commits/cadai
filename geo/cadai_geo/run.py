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
import sys
import traceback
from collections.abc import Sequence

# Temp script paths and /tmp directories must not leak back to the caller.
_PATH_LEAK = re.compile(r"/tmp/\S+|\S*[/\\]model\.py")

# build123d's Compound([shapes]) keeps only the OCC topology, so labels set on
# the Python shapes are dropped. Remember the shapes that were passed in.
_RECORDER_FLAG = "_cadai_sources"


def redact(text: str) -> str:
    """Drop temp-file paths from an error string."""
    return _PATH_LEAK.sub("[redacted]", text)


def _last_line(exc: BaseException) -> str:
    text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    line = lines[-1] if lines else f"{type(exc).__name__}: {exc}"
    return redact(line)


def _script_lines(exc: BaseException, script_path: str) -> list[int]:
    """Line numbers in the script itself that the traceback passes through, outermost first."""
    lines = [
        frame.lineno
        for frame in traceback.extract_tb(exc.__traceback__)
        if frame.filename == script_path and frame.lineno
    ]
    # A SyntaxError carries its own position and no frame in the script.
    if isinstance(exc, SyntaxError) and exc.filename == script_path and exc.lineno:
        lines.append(exc.lineno)
    return lines


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


def _parts(result) -> list[dict]:
    children = list(getattr(result, "children", []) or [])
    sources = getattr(result, _RECORDER_FLAG, None)
    if children:
        return [_part(child, getattr(child, "label", "") or "") for child in children]
    if sources is not None:
        return [_part(shape, getattr(shape, "label", "") or "") for shape in sources]
    return [_part(solid, "") for solid in result.solids()]


def _local(namespace: dict) -> list[dict]:
    """Labelled shapes in their own frames, before placement, when the script lists them in ``_local``."""
    shapes = namespace.get("_local")
    if not isinstance(shapes, (list, tuple)):
        return []
    return [
        _part(shape, getattr(shape, "label", "") or "")
        for shape in shapes
        if hasattr(shape, "wrapped") and hasattr(shape, "bounding_box")
    ]


def _replace_output(path: str) -> None:
    """Remove anything already at ``path`` so export cannot follow a symlink."""
    if os.path.lexists(path):
        os.unlink(path)


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
            lines = _script_lines(exc, os.fspath(script_path))
            if lines:
                # The innermost line of the script that raised: which function body failed.
                failed["line"] = lines[-1]
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
            "parts": _parts(result),
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
