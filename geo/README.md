# cadai geometry service

Runs a build123d script and returns per-part measurements, a STEP file, and an STL. The same package is the local CLI and the containerized HTTP service. Units are millimetres. `build123d` is pinned to `0.13.0`.

The script is untrusted. The lists below separate what this code actually enforces from what only the container host can enforce. A scrubbed environment and a temp working directory are defense in depth, not a jail.

## Local setup

From the repository root:

```bash
npm run geo:setup
```

That creates `geo/.venv`, installs `geo/requirements-dev.txt` (runtime pins plus pytest and httpx), and installs this package in editable mode so `python -I -m cadai_geo` can import it.

Run a script. It must assign `result`. One JSON line is printed, and the same object is written to `<outdir>/result.json`:

```bash
geo/.venv/bin/python -I -m cadai_geo path/to/model.py path/to/outdir
```

Start the HTTP service on a developer machine (this uid cannot `setuid`, so the uid split is not active here):

```bash
export CADAI_GEO_TOKEN=dev-token
export PORT=8000
geo/.venv/bin/uvicorn cadai_geo.service:app --host 127.0.0.1 --port "$PORT"
```

Prefer a file for the token, including locally, so it is not sitting in the process environment:

```bash
install -m 0400 /dev/stdin "$HOME/geo-token" <<< "$CADAI_GEO_TOKEN"
unset CADAI_GEO_TOKEN
export CADAI_GEO_TOKEN_FILE="$HOME/geo-token"
```

`POST /run` takes `{"script": "...", "timeout_s": 60}` and the header `x-cadai-geo-token`. `timeout_s` is clamped to 1..120 and defaults to 60. The response is the runner JSON with `stl` and `step` replaced by base64. A timeout returns `{"ok": false, "error": "timeout"}`. A bad token returns 401. A script larger than 256 KB returns 413. `GET /healthz` has no auth and returns `{"ok": true}`.

## What the code enforces

- The service ignores the child's stdout. It reads only `<outdir>/result.json`, which the runner writes after the script returns. Printed JSON cannot change `ok` or `parts`.
- `stl` and `step` are loaded only from `<outdir>/model.stl` and `<outdir>/model.step` when they are regular files inside that directory. Symlinks are rejected, so a path such as `/etc/hostname` in the JSON is not opened.
- Child environment is `PATH`, `HOME` (the request temp directory), and a one-thread cap for OpenBLAS, OpenMP, MKL, NUMEXPR, and VECLIB. That cap keeps `RLIMIT_NPROC` 64 usable on a many-core host. `CADAI_GEO_TOKEN` is removed from the service environment after it is read. It is never passed to the child.
- As root, each run drops to the `georun` user (`setgroups([])`, `setgid`, `setuid`) before exec. `georun` cannot read `/proc/<service-pid>/environ` or a `0400` token file owned by the service user.
- Timeout sends `SIGKILL` to the child's process group, so a grandchild started with `Popen` dies with the request.
- Limits on each run: `RLIMIT_AS` 2 GB (`CADAI_GEO_RLIMIT_AS`), `RLIMIT_CPU` timeout+5 s, `RLIMIT_FSIZE` 256 MB, `RLIMIT_NPROC` 64 for `georun`, `RLIMIT_CORE` 0. Outside the container the process cap is raised just above this uid's existing threads so a local run can still import; it stays a finite cap.
- Stderr kept for errors is at most 4 KB. Each export must be at most 64 MB (`CADAI_GEO_MAX_EXPORT_BYTES`) or the response is `output too large`.
- Error strings have temp paths stripped.

## What the host must enforce

The script shares the service's network namespace, mount namespace, and cgroup unless the host says otherwise.

- Block container egress, while still allowing inbound connections to `PORT`. `--network none` also blocks inbound, so it does not do this job by itself.
- `--cpus`, `--memory`, and `--pids-limit`. `RLIMIT_NPROC` is not a pids cgroup.
- `--read-only --tmpfs /tmp`. The per-request directory is not a filesystem jail; a script can still read every file its uid can read.
- `--cap-drop ALL --cap-add SETUID --cap-add SETGID`. The image is root only so it can drop to `georun`.
- `hidepid` on `/proc` if you want defense in depth behind the uid split.

```bash
docker build -t cadai-geo geo
install -m 0400 /dev/stdin /path/geo-token <<< 'replace-me'
docker run --rm \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --read-only --tmpfs /tmp \
  --pids-limit 128 --memory 3g --cpus 1 \
  -v /path/geo-token:/run/secrets/geo-token:ro \
  -e CADAI_GEO_TOKEN_FILE=/run/secrets/geo-token \
  -e PORT=8000 -p 8000:8000 \
  cadai-geo
```

Do not put the token in the environment or in the image. The file must be mode `0400` and owned by root (the service user in this image). Point the Next.js app at the service with `CADAI_GEO_URL` (origin only) and the same token in the `x-cadai-geo-token` header.
