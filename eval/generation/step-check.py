"""Re-import a STEP file with build123d and print JSON ``{"solids": n, "valid": bool}``.

    python step-check.py <file.step>

``valid`` is true when every solid in the file is a valid B-rep. Any import
failure reports ``{"solids": 0, "valid": false, "error": "..."}`` and exits 0.
The result is the one line that starts with PREFIX; the caller ignores every
other line (library banners, escape codes) and strips escape codes around it.
"""

import json
import sys

PREFIX = "@@cadai-step-check@@"


def main(path: str) -> dict:
    try:
        from build123d import import_step

        shape = import_step(path)
        solids = list(shape.solids())
        return {"solids": len(solids), "valid": bool(solids) and all(s.is_valid for s in solids)}
    except Exception as exc:  # noqa: BLE001 - report every failure as data
        return {"solids": 0, "valid": False, "error": f"{type(exc).__name__}: {exc}"[:300]}


if __name__ == "__main__":
    result = main(sys.argv[1])
    sys.stdout.flush()
    print(f"\n{PREFIX} {json.dumps(result)}", flush=True)
