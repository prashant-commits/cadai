"""Re-import a STEP file with build123d and print JSON ``{"solids": n, "valid": bool}``.

    python step-check.py <file.step>

``valid`` is true when every solid in the file is a valid B-rep. Any import
failure prints ``{"solids": 0, "valid": false, "error": "..."}`` and exits 0, so
the caller reads one JSON line either way.
"""

import json
import sys


def main(path: str) -> dict:
    try:
        from build123d import import_step

        shape = import_step(path)
        solids = list(shape.solids())
        return {"solids": len(solids), "valid": bool(solids) and all(s.is_valid for s in solids)}
    except Exception as exc:  # noqa: BLE001 - report every failure as data
        return {"solids": 0, "valid": False, "error": f"{type(exc).__name__}: {exc}"[:300]}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1])))
