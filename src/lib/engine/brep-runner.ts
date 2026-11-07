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
};

export type BrepResult = {
  ok: boolean;
  error?: string;
  parts: BrepPart[];
  solids: number;
  bbox?: {
    min: [number, number, number];
    max: [number, number, number];
  };
  stl?: string; /* base64 */
  step?: string; /* base64 */
  ms: number;
};

export interface RunBrepOptions {
  timeoutMs?: number; /* default 60000 */
  fetchImpl?: typeof fetch;
  /** The run's stop signal: aborts the HTTP request or kills the local process group. Result error is 'cancelled'. */
  signal?: AbortSignal;
}

const cancelledResult = (t0: number): BrepResult => ({
  ok: false,
  error: 'cancelled',
  parts: [],
  solids: 0,
  ms: Math.max(1, Math.round(performance.now() - t0)),
});

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
  runSignal?: AbortSignal
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
  const body = JSON.stringify({ script, timeout_s });

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
    const isTimeout =
      (err && typeof err === 'object' && 'name' in err && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
      (err instanceof Error && /timeout/i.test(err.message));
    return {
      ok: false,
      error: isTimeout ? 'timeout' : (err instanceof Error ? err.message : String(err)),
      parts: [],
      solids: 0,
      ms: Math.max(1, Math.round(performance.now() - t0)),
    };
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
    return {
      ok: false,
      error: errText,
      parts: [],
      solids: 0,
      ms: Math.max(1, Math.round(performance.now() - t0)),
    };
  }

  try {
    const data = (await res.json()) as Partial<BrepResult>;
    return {
      ok: Boolean(data.ok),
      error: data.error,
      parts: Array.isArray(data.parts) ? data.parts : [],
      solids: typeof data.solids === 'number' ? data.solids : 0,
      bbox: data.bbox,
      stl: data.stl,
      step: data.step,
      ms: Math.max(1, Math.round(performance.now() - t0)),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid JSON response from geometry service',
      parts: [],
      solids: 0,
      ms: Math.max(1, Math.round(performance.now() - t0)),
    };
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
  runSignal?: AbortSignal
): Promise<BrepResult> {
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
        child = spawn(pythonPath, ['-I', '-m', 'cadai_geo', scriptPath, outDir], {
          cwd: geoDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
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

    if (childResult.timedOut) {
      return {
        ok: false,
        error: 'timeout',
        parts: [],
        solids: 0,
        ms: Math.max(1, Math.round(performance.now() - t0)),
      };
    }

    if (childResult.error) {
      return {
        ok: false,
        error: childResult.error.message,
        parts: [],
        solids: 0,
        ms: Math.max(1, Math.round(performance.now() - t0)),
      };
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
        solids: typeof parsed.solids === 'number' ? parsed.solids : 0,
        bbox: parsed.bbox as BrepResult['bbox'],
        stl: stlBase64,
        step: stepBase64,
        ms: Math.max(1, Math.round(performance.now() - t0)),
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
      ok: false,
      error,
      parts: [],
      solids: 0,
      ms: Math.max(1, Math.round(performance.now() - t0)),
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
      return await runBrepHttp(script, timeoutMs, opts?.fetchImpl, t0, opts?.signal);
    }
    return await runBrepLocal(script, timeoutMs, t0, opts?.signal);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      parts: [],
      solids: 0,
      ms: Math.max(1, Math.round(performance.now() - t0)),
    };
  }
}
