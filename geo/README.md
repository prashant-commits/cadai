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

Local dev for the Next.js app. This starts the service on `127.0.0.1:8765`. The first boot imports build123d once in a helper process; later runs fork that process instead of importing again. `npm run geo:serve` writes `${TMPDIR:-/tmp}/cadai-geo-dev-token` (mode `0400`, contents `dev`) and sets `CADAI_GEO_TOKEN_FILE` for the service process.

```bash
unset CADAI_GEO_TOKEN
npm run geo:serve
```

The service refuses to start if `CADAI_GEO_TOKEN` is set in its environment. That variable is not a token source: deleting it from `os.environ` leaves the bytes in `/proc/<pid>/environ`.

In the Next.js app's environment (a different process from the service):

```bash
export CADAI_GEO_URL=http://127.0.0.1:8765
export CADAI_GEO_TOKEN=dev
```

This uid cannot `setuid`, so the uid split is not active outside the container. The one-shot CLI above does not use the helper and does not apply the two-stage split; it is for local scripts, not untrusted ones.

`POST /run` takes `{"script": "...", "timeout_s": 60}` and the header `x-cadai-geo-token`. `timeout_s` is clamped to 1..120 and defaults to 60. The response is the runner JSON with `stl` and `step` replaced by base64. A timeout returns `{"ok": false, "error": "timeout"}`. A bad token returns 401. A script larger than 256 KB returns 413. `GET /healthz` has no auth and returns `{"ok": true}`.

## What the code enforces

- The token is file-only (`CADAI_GEO_TOKEN_FILE`, mode `0400`, owned by the service user). The process exits at startup if `CADAI_GEO_TOKEN` is set. The environment value is not read and is not scrubbed out of `/proc`.
- A run has two stages. The untrusted stage (the script) may only write BREP into a scratch directory. A second child opens that directory with `O_NOFOLLOW`, loads each BREP from a file descriptor checked with `fstat`, measures the shapes, and writes `<outdir>/result.json`, `model.step`, and `model.stl`. The script is not given the outdir. The outdir is mode `0700` and is never owned by the run uid.
- Stdout and stderr of the untrusted stage are pipes owned by the supervisor. The service does not open a path inside a directory the script can write. At most 4 KB of that stream is kept, and only as a redacted error string when no BREP was produced. A crashed script (`SIGSEGV` or `SIGKILL`) gets `result.json` from the supervisor with `error` `script crashed`. `sys.exit()` is reported as `script exited` (with the status when it is a non-zero integer). A measure or parse failure is `measure`.
- At boot the service execs a zygote with an empty environment. The zygote imports build123d once, stays single-threaded, and holds no token and no token-file path. It accepts overlapping runs (up to `CADAI_GEO_CONCURRENCY`, default 4). Each run forks a supervisor; the service kills that process group on timeout. The wall-clock timeout starts when the request is accepted. If the zygote dies, the next request starts a new one.
- The untrusted stage's environment is `PATH`, `HOME` (the script home directory), `TMPDIR` when the service has one, and a one-thread cap for OpenBLAS, OpenMP, MKL, NUMEXPR, and VECLIB. The trusted stage's `HOME` and `TMPDIR` are the outdir. That thread cap keeps `RLIMIT_NPROC` 64 usable on a many-core host and keeps the zygote single-threaded so `fork` is safe. The token is never passed to the zygote or either stage.
- As root, each run gets its own uid from `CADAI_GEO_UID_BASE` (default 10100) through that base plus `CADAI_GEO_CONCURRENCY - 1` (the image creates `cadairun0`..`cadairun3`). The untrusted stage calls `setgroups([])`, `setgid`, and `setuid` to that uid. When the stage ends (normal exit, error, or timeout), a helper setuids to the same uid and calls `kill(-1, SIGKILL)`, repeating until no process of that uid remains. Only then does the trusted stage run, as `geotrust` (uid 10003) when that user exists, otherwise as the service uid. The run uid cannot read `/proc/<service-pid>/environ` or a `0400` token file owned by the service user. The uid is not reused until that kill has finished. `georun` (uid 10002) is not a run uid; it exists so the EACCES check below has a stable account.
- Without root there is no uid split. Startup logs `no isolation: local dev only` and the service still kills the supervisor's process group. A `setsid` survivor then shares the service uid and can write the outdir. Printed JSON and a forged `result.json` cannot change `ok`, `parts`, or the exports when the uid split is in effect, because the survivor is dead and the outdir was never writable by that uid. They are not a boundary in local dev. Bytes that are not a BREP fail the run (`measure`). A BREP the script wrote is measured again.
- The process refuses to start as root if `CAP_SETUID`, `CAP_SETGID`, `CAP_KILL`, `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, or `CAP_FOWNER` is missing, or if a pool uid does not exist.
- Timeout sends `SIGKILL` to the supervisor's process group, and when root also reaps the run uid, so a grandchild started with `Popen` dies with the request. A grandchild that called `setsid` dies in the uid reap when root.
- Cleanup kills first, then removes the temp directories. A failure to delete a file does not turn the run into HTTP 500.
- Limits on each run: `RLIMIT_AS` 2 GB (`CADAI_GEO_RLIMIT_AS`), `RLIMIT_CPU` timeout+5 s, `RLIMIT_FSIZE` 256 MB, `RLIMIT_NPROC` 64 for the run uid, `RLIMIT_CORE` 0. Outside the container the process cap is raised just above this uid's existing threads so a local run can still import; it stays a finite cap. The untrusted child also sets itself non-dumpable so a crash does not write a core of the zygote image.
- Each export must be at most 64 MB (`CADAI_GEO_MAX_EXPORT_BYTES`) or the response is `output too large`. Part indexes accept up to 4096 parts (an index over 8 MB, or a BREP over 256 MB, is `measure`).
- Error strings have `/tmp` paths, `model.py`, and the `TMPDIR` prefix stripped.

## What the host must enforce

The script shares the service's network namespace, mount namespace, and cgroup unless the host says otherwise.

- Block container egress, while still allowing inbound connections to `PORT`. `--network none` also blocks inbound, so it does not do this job by itself.
- `--cpus`, `--memory`, and `--pids-limit`. `RLIMIT_NPROC` is not a pids cgroup.
- `--read-only --tmpfs /tmp`. The per-request directory is not a filesystem jail; a script can still read every file its uid can read.
- `--cap-drop ALL` plus `--cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER`. The image is root so it can drop to a per-run uid and to `geotrust`, kill that uid, chown the work directories, and delete them afterwards. `SETUID` and `SETGID` alone are not enough: the first `chown` would fail and every request would be an error.
- `hidepid` on `/proc` if you want defense in depth behind the uid split.

```bash
docker build -t cadai-geo geo
install -m 0400 /dev/stdin /path/geo-token <<< 'replace-me'
docker run --rm \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --read-only --tmpfs /tmp \
  --pids-limit 128 --memory 3g --cpus 1 \
  -v /path/geo-token:/run/secrets/geo-token:ro \
  -e CADAI_GEO_TOKEN_FILE=/run/secrets/geo-token \
  -e PORT=8000 -p 8000:8000 \
  cadai-geo
```

Do not put the token in the environment or in the image. The file must be mode `0400` and owned by root (the service user in this image). Point the Next.js app at the service with `CADAI_GEO_URL` (origin only) and the same token in the `x-cadai-geo-token` header.

## Before hosting

This machine has no container runtime, so the root-only uid split is not exercised here. `test_token_file_and_proc_environ_are_unreadable` skips unless the process is root. Before hosting, build the image and run these checks.

```bash
docker build -t cadai-geo geo
install -m 0400 /dev/stdin /tmp/geo-token <<< 'file-token-not-in-env-9f3c'
```

1. Run the root-only tests inside the image. The image does not install pytest, so the venv goes on the tmpfs. The full capability set is required: without `CHOWN` the service refuses to start, and without `KILL` a timeout cannot reap the run uid. This also runs `test_setsid_survivor_cannot_forge_result`.

```bash
docker run --rm \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --read-only --tmpfs /tmp \
  --pids-limit 256 --memory 3g --cpus 1 \
  -v "$PWD":/work:ro \
  -v /tmp/geo-token:/run/secrets/geo-token:ro \
  -e CADAI_GEO_TOKEN_FILE=/run/secrets/geo-token \
  --entrypoint bash \
  cadai-geo -lc 'python -m venv --system-site-packages /tmp/venv && /tmp/venv/bin/pip install -q pytest==9.2.0 httpx==0.28.1 && cd /work/geo && /tmp/venv/bin/python -m pytest -q tests/test_sandbox.py::test_token_file_and_proc_environ_are_unreadable tests/test_sandbox.py::test_setsid_survivor_cannot_forge_result'
```

`test_token_file_and_proc_environ_are_unreadable` passes only when the script cannot read `/proc/1/environ`, `/proc/<ppid>/environ`, or the token file. `test_setsid_survivor_cannot_forge_result` passes only when a `setsid` grandchild cannot publish a forged `result.json`.

2. Confirm `georun` gets `EACCES` on the `0400` root-owned token file. `georun` is the stand-in account; the run uids (`cadairun0`..`cadairun3`) are in the same position.

```bash
docker run --rm \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --read-only --tmpfs /tmp \
  -v /tmp/geo-token:/run/secrets/geo-token:ro \
  --entrypoint python \
  cadai-geo -c 'import os,pwd; a=pwd.getpwnam("georun"); p=os.fork()
if p==0:
 os.setgroups([]); os.setgid(a.pw_gid); os.setuid(a.pw_uid)
 try:
  open("/run/secrets/geo-token").read()
 except PermissionError:
  print("EACCES"); os._exit(0)
 print("READABLE"); os._exit(1)
os.waitpid(p,0)'
```

The output is `EACCES`. `stat` on the file shows mode `0400` and owner root.

3. Re-run the forged-export probe under the uid split. Start the service with the flags in the host section above (token file mounted, `CADAI_GEO_TOKEN` unset). `POST /run` a script that copies `/etc/hostname` into `model.step` and `result.brep`, writes a `result.json` with `parts: [{label: FORGED, volume: 999}]`, and calls `os._exit(0)`. The response is `ok: false` (those bytes are not a BREP; the error is `measure`) and does not contain the hostname. A script that writes a real BREP and a forged `result.json` comes back as measurements of that shape, not volume `999` and not the hostname bytes. Copying the `0400` token file into the scratch dir fails for the run uid, so the token is not in the response. A script that `setsid`s and writes `/tmp/cadai-geo-out-*/result.json` still gets the real measurement: that uid is killed before the trusted stage, and the outdir is not writable by it. World-readable files can still be read by the script; they cannot be returned as STEP/STL unless they are valid BREP geometry the trusted stage re-exports. This machine has no container runtime, so those root checks were not executed here.
