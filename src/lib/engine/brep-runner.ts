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

export type BrepFailure = 'script' | 'unreachable' | 'timeout';

export type BrepResult = {
  ok: boolean;
  error?: string;
  /** Why `ok` is false. Set from the runner's status or sentinel, not from traceback text. */
  failure?: BrepFailure;
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
  t0: number
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
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    res = await fetchFn(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });
  } catch (err: unknown) {
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
      parts: Array.isArray(data.parts) ? data.parts : [],
      solids: typeof data.solids === 'number' ? data.solids : 0,
      bbox: data.bbox,
      stl: data.stl,
      step: data.step,
      ms: Math.max(1, Math.round(performance.now() - t0)),
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

async function runBrepLocal(
  script: string,
  timeoutMs: number,
  t0: number
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

    const childResult = await new Promise<LocalChildResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(pythonPath, ['-I', '-m', 'cadai_geo', scriptPath, outDir], {
          cwd: geoDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
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
          child.kill('SIGKILL');
        }, timeoutMs);
      }

      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
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
        if (timer) clearTimeout(timer);
        resolve({
          code,
          signal,
          stdout,
          stderr,
          timedOut,
        });
      });
    });

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

    return brepFailed(error, 'script', t0);
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

  try {
    if (process.env.CADAI_GEO_URL && process.env.CADAI_GEO_URL.trim().length > 0) {
      return await runBrepHttp(script, timeoutMs, opts?.fetchImpl, t0);
    }
    return await runBrepLocal(script, timeoutMs, t0);
  } catch (err) {
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
