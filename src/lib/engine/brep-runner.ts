import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type BrepPart = {
  label: string;
  valid: boolean;
  volume: number;
  min: [number, number, number];
  max: [number, number, number];
  centroid?: [number, number, number];
  area?: number;
};

export type BrepFailure = 'script' | 'unreachable' | 'timeout';

export type BrepResult = {
  ok: boolean;
  error?: string;
  /** Why `ok` is false. Set from the runner's status or sentinel, not from traceback text. */
  failure?: BrepFailure;
  /** Line of the script that raised (the innermost frame in the script), when the runner knows it. */
  line?: number;
  /** Parts whose solid stayed invalid after the kernel's repair attempt: the run built a shape it will not export. */
  invalid?: string[];
  /** What the runner did that the caller should know, e.g. the STEP was written as separate solids. */
  notes?: string[];
  parts: BrepPart[];
  /** Each component measured in its own frame before placement, when the script lists `_local`. */
  local?: BrepPart[];
  solids: number;
  bbox?: {
    min: [number, number, number];
    max: [number, number, number];
  };
  stl?: string; /* base64 */
  step?: string; /* base64 */
  ms: number;
  interferences?: Array<{ a: string; b: string; volume: number }>;
  partMeshes?: Record<string, string>;
  disconnected?: string[];
};

export interface RunBrepOptions {
  timeoutMs?: number; /* default 60000 */
  fetchImpl?: typeof fetch;
  /** The run's stop signal: aborts the HTTP request or kills the local process group. Result error is 'cancelled'. */
  signal?: AbortSignal;
  interferences?: boolean;
  partMeshes?: boolean;
  connectivity?: boolean;
}

const cancelledResult = (t0: number): BrepResult => ({
  ok: false,
  error: 'cancelled',
  parts: [],
  solids: 0,
  ms: Math.max(1, Math.round(performance.now() - t0)),
});

/** The part names of an invalid-solid failure, from the runner's untrusted JSON. */
function invalidNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((v): v is string => typeof v === 'string' && v !== '').map((v) => v.slice(0, 100)).slice(0, 50);
  return names.length > 0 ? names : undefined;
}

/** Short runner notes from untrusted JSON: strings only, clipped. */
function runnerNotes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes = value.filter((v): v is string => typeof v === 'string' && v !== '').map((v) => v.slice(0, 300)).slice(0, 10);
  return notes.length > 0 ? notes : undefined;
}

function findProjectRoot(): string {
  let curr = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return process.cwd();
}

async function runBrepHttp(
  script: string,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
  t0: number,
  runSignal?: AbortSignal,
  opts?: RunBrepOptions
): Promise<BrepResult> {
  const geoUrl = process.env.CADAI_GEO_URL!.trim();
  const url = `${geoUrl.replace(/\/+$/, '')}/run`;
  const fetchFn = fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (process.env.CADAI_GEO_TOKEN) {
    headers['x-cadai-geo-token'] = process.env.CADAI_GEO_TOKEN;
  }

  const timeout_s = Math.max(1, Math.ceil(timeoutMs / 1000));
  const body = JSON.stringify({
    script,
    timeout_s,
    interferences: Boolean(opts?.interferences),
    partMeshes: Boolean(opts?.partMeshes),
    connectivity: Boolean(opts?.connectivity),
  });

  let res: Response;
  try {
    const timeout = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    const signals = [timeout, runSignal].filter((x): x is AbortSignal => Boolean(x));
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    res = await fetchFn(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });
  } catch (err: unknown) {
    if (runSignal?.aborted) return cancelledResult(t0);
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = name === 'TimeoutError' || name === 'AbortError' || message === 'timeout';
    return brepFailed(isTimeout ? 'timeout' : message, isTimeout ? 'timeout' : 'unreachable', t0);
  }

  if (!res.ok) {
    let errText = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as Record<string, unknown>;
      if (data && typeof data === 'object') {
        if (typeof data.error === 'string') {
          errText = data.error;
        } else if (typeof data.detail === 'string') {
          errText = data.detail;
        } else if (typeof data.message === 'string') {
          errText = data.message;
        }
      }
    } catch {
      try {
        const text = await res.text();
        if (text) errText = text;
      } catch {
        // ignore
      }
    }
    const failure: BrepFailure = res.status === 408 || res.status === 504
      ? 'timeout'
      : res.status === 401 || res.status === 403 || res.status >= 500
        ? 'unreachable'
        : 'script';
    return brepFailed(errText, failure, t0);
  }

  try {
    const data = (await res.json()) as Partial<BrepResult>;
    const ok = Boolean(data.ok);
    const failure = ok
      ? undefined
      : data.failure === 'script' || data.failure === 'unreachable' || data.failure === 'timeout'
        ? data.failure
        : data.error === 'timeout'
          ? 'timeout'
          : 'script';
    return {
      ok,
      error: data.error,
      ...(failure ? { failure } : {}),
      line: typeof data.line === 'number' ? data.line : undefined,
      ...(ok ? {} : { invalid: invalidNames((data as { invalid?: unknown }).invalid) }),
      ...(ok ? { notes: runnerNotes((data as { notes?: unknown }).notes) } : {}),
      parts: Array.isArray(data.parts) ? data.parts : [],
      local: Array.isArray(data.local) ? data.local : undefined,
      solids: typeof data.solids === 'number' ? data.solids : 0,
      bbox: data.bbox,
      stl: data.stl,
      step: data.step,
      ms: Math.max(1, Math.round(performance.now() - t0)),
      interferences: Array.isArray((data as { interferences?: unknown }).interferences)
        ? (data as { interferences: Array<{ a: string; b: string; volume: number }> }).interferences
        : undefined,
      partMeshes: (data.partMeshes ?? (data as Record<string, unknown>).part_meshes) as Record<string, string> | undefined,
      disconnected: Array.isArray((data as { disconnected?: unknown }).disconnected)
        ? ((data as { disconnected: string[] }).disconnected)
        : undefined,
    };
  } catch (err) {
    return brepFailed(err instanceof Error ? err.message : 'Invalid JSON response from geometry service', 'unreachable', t0);
  }
}

interface LocalChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: Error;
}

let warnedLocal = false;

/**
 * The local child's environment: what the venv interpreter needs, and the geometry settings.
 * No API keys, no token: a script that got past the body check sees only these.
 */
export function localChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const keep =
      key === 'PATH' || key === 'HOME' || key === 'TMPDIR' || key === 'LANG' || key.startsWith('LC_') ||
      key.startsWith('PYTHON') ||
      (key.startsWith('CADAI_GEO_') && key !== 'CADAI_GEO_TOKEN' && key !== 'CADAI_GEO_TOKEN_FILE');
    if (keep) env[key] = value;
  }
  return env;
}

/**
 * The local backend runs model-written Python as the app user with no process sandbox
 * (no uid drop, no rlimits, no network cut). It is for development and evals only: it
 * refuses to run under NODE_ENV=production unless CADAI_GEO_ALLOW_LOCAL=1.
 */
export function localRunnerRefusal(): string | null {
  if (process.env.NODE_ENV === 'production' && process.env.CADAI_GEO_ALLOW_LOCAL !== '1') {
    return 'local geometry runner is disabled in production: set CADAI_GEO_URL (or CADAI_GEO_ALLOW_LOCAL=1)';
  }
  if (!warnedLocal) {
    warnedLocal = true;
    console.warn('local geometry runner has no process sandbox: dev only');
  }
  return null;
}

/** Kills the child and everything it started (it leads its own process group). */
function killGroup(child: ReturnType<typeof spawn>) {
  try {
    if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

async function runBrepLocal(
  script: string,
  timeoutMs: number,
  t0: number,
  runSignal?: AbortSignal,
  opts?: RunBrepOptions
): Promise<BrepResult> {
  const refusal = localRunnerRefusal();
  if (refusal) {
    return { ok: false, error: refusal, parts: [], solids: 0, ms: Math.max(1, Math.round(performance.now() - t0)) };
  }
  const root = findProjectRoot();
  const pyEnv = process.env.CADAI_GEO_PYTHON ?? 'geo/.venv/bin/python';
  const pythonPath = pyEnv.includes('/') || pyEnv.includes('\\')
    ? path.resolve(root, pyEnv)
    : pyEnv;
  const geoDir = path.resolve(root, 'geo');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadai-brep-'));
  try {
    const scriptPath = path.join(tmpDir, 'model.py');
    const outDir = path.join(tmpDir, 'out');
    await fs.writeFile(scriptPath, script, 'utf-8');
    await fs.mkdir(outDir, { recursive: true });
    // A Stop during the setup above fired no listener yet: check before spawning.
    if (runSignal?.aborted) return cancelledResult(t0);

    const childResult = await new Promise<LocalChildResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let onAbort: (() => void) | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort) runSignal?.removeEventListener('abort', onAbort);
      };

      let child: ReturnType<typeof spawn>;
      try {
        const args = ['-I', '-m', 'cadai_geo', scriptPath, outDir];
        if (opts?.interferences) {
          args.push('--interferences');
        }
        if (opts?.connectivity) {
          args.push('--connectivity');
        }
        if (opts?.partMeshes) {
          args.push('--part-meshes');
        }
        child = spawn(pythonPath, args, {
          cwd: geoDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: localChildEnv() as NodeJS.ProcessEnv,
          // Own process group, so a timeout or a stop kills the python process
          // and anything it spawned, not just the direct child.
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        return resolve({
          code: 1,
          signal: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          timedOut = true;
          killGroup(child);
        }, timeoutMs);
      }

      if (runSignal) {
        onAbort = () => killGroup(child);
        runSignal.addEventListener('abort', onAbort, { once: true });
        // Aborted between the check above and here: the listener will never fire.
        if (runSignal.aborted) killGroup(child);
      }

      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (err) => {
        cleanup();
        resolve({
          code: 1,
          signal: null,
          stdout,
          stderr,
          timedOut,
          error: err,
        });
      });

      child.on('close', (code, signal) => {
        cleanup();
        resolve({
          code,
          signal,
          stdout,
          stderr,
          timedOut,
        });
      });
    });

    if (runSignal?.aborted) return cancelledResult(t0);
    if (childResult.timedOut) return brepFailed('timeout', 'timeout', t0);

    if (childResult.error) {
      const message = childResult.error.message;
      const failure: BrepFailure = /ENOENT|EACCES|EPERM/.test(message) || message.startsWith('spawn ')
        ? 'unreachable'
        : 'script';
      return brepFailed(message, failure, t0);
    }

    const lines = childResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    let parsed: Record<string, unknown> | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('{') && lines[i].endsWith('}')) {
        try {
          parsed = JSON.parse(lines[i]);
          break;
        } catch {
          // ignore
        }
      }
    }

    if (parsed && parsed.ok === true) {
      const resolveAndReadFile = async (targetPath: unknown, fallbackName: string): Promise<string | undefined> => {
        const candidates: string[] = [];
        if (typeof targetPath === 'string' && targetPath.trim().length > 0) {
          if (path.isAbsolute(targetPath)) {
            candidates.push(targetPath);
          } else {
            candidates.push(path.resolve(geoDir, targetPath));
            candidates.push(path.resolve(outDir, targetPath));
            candidates.push(path.resolve(root, targetPath));
          }
        }
        candidates.push(path.join(outDir, fallbackName));

        for (const cand of candidates) {
          if (existsSync(cand)) {
            try {
              const buf = await fs.readFile(cand);
              return buf.toString('base64');
            } catch {
              // ignore
            }
          }
        }
        return undefined;
      };

      const stlBase64 = await resolveAndReadFile(parsed.stl, 'model.stl');
      const stepBase64 = await resolveAndReadFile(parsed.step, 'model.step');

      return {
        ok: true,
        parts: Array.isArray(parsed.parts) ? (parsed.parts as BrepPart[]) : [],
        local: Array.isArray(parsed.local) ? (parsed.local as BrepPart[]) : undefined,
        solids: typeof parsed.solids === 'number' ? parsed.solids : 0,
        notes: runnerNotes(parsed.notes),
        bbox: parsed.bbox as BrepResult['bbox'],
        stl: stlBase64,
        step: stepBase64,
        ms: Math.max(1, Math.round(performance.now() - t0)),
        interferences: Array.isArray(parsed.interferences)
          ? (parsed.interferences as Array<{ a: string; b: string; volume: number }>)
          : undefined,
        partMeshes: (parsed.partMeshes ?? parsed.part_meshes) as Record<string, string> | undefined,
        disconnected: Array.isArray(parsed.disconnected)
          ? (parsed.disconnected as string[])
          : undefined,
      };
    }

    let error = typeof parsed?.error === 'string' ? parsed.error : '';
    if (!error) {
      const combined = (childResult.stderr.trim() || childResult.stdout.trim());
      if (combined) {
        const errLines = combined.split('\n').map((l) => l.trim()).filter(Boolean);
        error = errLines[errLines.length - 1];
      } else {
        error = `CLI exited with code ${childResult.code ?? -1}`;
      }
    }

    return {
      ...brepFailed(error, 'script', t0),
      line: typeof parsed?.line === 'number' ? parsed.line : undefined,
      invalid: invalidNames(parsed?.invalid),
    };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function runBrep(
  script: string,
  opts?: RunBrepOptions
): Promise<BrepResult> {
  const t0 = performance.now();
  const timeoutMs = opts?.timeoutMs ?? 60000;
  if (opts?.signal?.aborted) return cancelledResult(t0);

  try {
    if (process.env.CADAI_GEO_URL && process.env.CADAI_GEO_URL.trim().length > 0) {
      return await runBrepHttp(script, timeoutMs, opts?.fetchImpl, t0, opts?.signal, opts);
    }
    return await runBrepLocal(script, timeoutMs, t0, opts?.signal, opts);
  } catch (err) {
    if (opts?.signal?.aborted) return cancelledResult(t0);
    const message = err instanceof Error ? err.message : String(err);
    const failure: BrepFailure = message === 'timeout'
      ? 'timeout'
      : /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ENOENT/.test(message)
        ? 'unreachable'
        : 'script';
    return brepFailed(message, failure, t0);
  }
}

function brepFailed(error: string, failure: BrepFailure, t0: number): BrepResult {
  return {
    ok: false,
    error,
    failure,
    parts: [],
    solids: 0,
    ms: Math.max(1, Math.round(performance.now() - t0)),
  };
}
