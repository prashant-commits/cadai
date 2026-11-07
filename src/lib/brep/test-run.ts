import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * TEST helper only: runs an emitted build123d script and measures it. The real
 * runner (`runBrep`, src/lib/engine/brep-runner.ts) is a separate lane.
 */

export interface TestPart {
  label: string;
  min: number[];
  max: number[];
  valid: boolean;
  volume: number;
}

export interface TestRun {
  ok: boolean;
  error?: string;
  parts: TestPart[];
  /** Each component in its own frame before placement (`_local`), when the script lists it. */
  local: TestPart[];
  /** Labels of the children of `result`. */
  children: string[];
  solids: number;
}

/** The interpreter with build123d installed: CADAI_GEO_PYTHON, else geo/.venv/bin/python. */
export function geoPython(): string {
  return process.env.CADAI_GEO_PYTHON || path.join(process.cwd(), 'geo', '.venv', 'bin', 'python');
}

// Measures `_cadai_parts` (the labelled, placed, un-fused parts the emitter binds) when
// the script has it, else the labelled children of `result`.
const RUNNER = `
import json, sys, traceback
try:
    ns = {}
    exec(compile(sys.stdin.read(), "<script>", "exec"), ns)
    result = ns.get("result")
    if result is None:
        raise RuntimeError("script did not assign result")
    items = ns.get("_cadai_parts")
    if items is None:
        items = [c for c in result.children if c.label]
    def measure(p):
        bb = p.bounding_box()
        return {
            "label": p.label,
            "min": [bb.min.X, bb.min.Y, bb.min.Z],
            "max": [bb.max.X, bb.max.Y, bb.max.Z],
            "valid": bool(p.is_valid),
            "volume": float(p.volume),
        }
    parts = [measure(p) for p in items]
    local = [measure(p) for p in ns.get("_local", [])]
    out = {"ok": True, "parts": parts, "local": local, "children": [c.label for c in result.children], "solids": len(result.solids())}
except BaseException:
    out = {"ok": False, "error": traceback.format_exc().strip().splitlines()[-1], "parts": [], "local": [], "children": [], "solids": 0}
print("@@RESULT@@" + json.dumps(out))
`;

export function runScriptForTest(script: string, timeoutMs = 90_000): Promise<TestRun> {
  return new Promise((resolve) => {
    const child = spawn(geoPython(), ['-I', '-c', RUNNER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, parts: [], local: [], children: [], solids: 0 });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('@@RESULT@@'));
      if (!line) {
        resolve({ ok: false, error: stderr.trim().split('\n').pop() || 'no output', parts: [], local: [], children: [], solids: 0 });
        return;
      }
      resolve(JSON.parse(line.slice('@@RESULT@@'.length)) as TestRun);
    });
    child.stdin.end(script);
  });
}

export interface GeoCliRun {
  ok: boolean;
  error?: string;
  /** Line of the script that raised, innermost. */
  line?: number;
  parts: TestPart[];
  local?: TestPart[];
  solids?: number;
  bbox?: { min: number[]; max: number[] };
}

/**
 * Runs THIS checkout's `geo/cadai_geo` CLI (not whichever copy the interpreter has installed)
 * on a script and returns its JSON line. Used by tests of what the CLI reports about a failure
 * or about each part's own frame.
 */
export async function runGeoCliForTest(script: string, timeoutMs = 90_000): Promise<GeoCliRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cadai-geo-test-'));
  try {
    const scriptPath = path.join(dir, 'model.py');
    const outDir = path.join(dir, 'out');
    await mkdir(outDir);
    await writeFile(scriptPath, script, 'utf-8');
    const boot = [
      'import sys, runpy',
      `sys.path.insert(0, ${JSON.stringify(path.join(process.cwd(), 'geo'))})`,
      'runpy.run_module("cadai_geo", run_name="__main__")',
    ].join('; ');
    const stdout = await new Promise<string>((resolve) => {
      const child = spawn(geoPython(), ['-I', '-c', boot, scriptPath, outDir], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    const line = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
    if (!line) return { ok: false, error: 'no output', parts: [] };
    return JSON.parse(line) as GeoCliRun;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
