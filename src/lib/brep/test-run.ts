import { spawn } from 'node:child_process';
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
    parts = []
    for p in items:
        bb = p.bounding_box()
        parts.append({
            "label": p.label,
            "min": [bb.min.X, bb.min.Y, bb.min.Z],
            "max": [bb.max.X, bb.max.Y, bb.max.Z],
            "valid": bool(p.is_valid),
            "volume": float(p.volume),
        })
    out = {"ok": True, "parts": parts, "solids": len(result.solids())}
except BaseException:
    out = {"ok": False, "error": traceback.format_exc().strip().splitlines()[-1], "parts": [], "solids": 0}
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
      resolve({ ok: false, error: err.message, parts: [], solids: 0 });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('@@RESULT@@'));
      if (!line) {
        resolve({ ok: false, error: stderr.trim().split('\n').pop() || 'no output', parts: [], solids: 0 });
        return;
      }
      resolve(JSON.parse(line.slice('@@RESULT@@'.length)) as TestRun);
    });
    child.stdin.end(script);
  });
}
