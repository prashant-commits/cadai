# cadai geometry service

Runs a build123d script and returns per-part measurements, a STEP file, and an STL. The same package is the local CLI and the containerized HTTP service. Units are millimetres. `build123d` is pinned to `0.13.0`.

## Local setup

From the repository root:

```bash
npm run geo:setup
```

That creates `geo/.venv`, installs `geo/requirements.txt`, and installs this package in editable mode so `python -I -m cadai_geo` can import it (isolated mode does not put the working directory on `sys.path`).

Run a script. It must assign `result` to a Part or a Compound. One JSON line is printed to stdout, and `model.step` / `model.stl` are written to the output directory:

```bash
geo/.venv/bin/python -I -m cadai_geo path/to/model.py path/to/outdir
```

Start the HTTP service locally:

```bash
export CADAI_GEO_TOKEN=dev-token
export PORT=8000
geo/.venv/bin/uvicorn cadai_geo.service:app --host 127.0.0.1 --port "$PORT"
```

`POST /run` with JSON `{"script": "...", "timeout_s": 60}` and header `x-cadai-geo-token: $CADAI_GEO_TOKEN`. `timeout_s` defaults to 60. The response is the CLI JSON with `stl` and `step` replaced by base64 file contents. A timed-out run returns `{"ok": false, "error": "timeout"}`. A missing or wrong token returns 401.

## Environment

| Variable | Where | Meaning |
|---|---|---|
| `CADAI_GEO_TOKEN` | service process | Shared secret. Must equal the `x-cadai-geo-token` header. It is not passed into the script subprocess. |
| `PORT` | service process | Port uvicorn listens on. Defaults to 8000 in the image. |
| `PATH`, `HOME` | script subprocess | The only environment variables the script can see. |

Each request uses a new temp directory, a 60 s default timeout, and a 2 GB `RLIMIT_AS`.

## Deploy

The `Dockerfile` is host-agnostic (Fly.io, Cloud Run, Render, a VM, or any other container host). Build from `geo/`:

```bash
docker build -t cadai-geo .
```

Set `CADAI_GEO_TOKEN` and, if the host does not inject one, `PORT`, in the host's secret or environment config. Do not bake the token into the image. The process listens on `0.0.0.0:$PORT` and runs as the non-root user `geo`.

Point the Next.js app at the service with `CADAI_GEO_URL` (the origin, no path) and the same `CADAI_GEO_TOKEN`. The app sends `POST $CADAI_GEO_URL/run`.
