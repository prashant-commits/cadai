import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { normalizeSpec } from '@/lib/agent/spec-normalize';
import type { AgentStateType } from '@/lib/agent/graph';
import type { BrepResult } from '@/lib/engine/brep-runner';
import { emitBrepScript } from './emit-script';
import { geoPython } from './test-run';

// The emitter fuses touching parts into one solid for the result, but the runner
// must measure each part before fusing, so the extents audit has something to compare.
let override: ((r: BrepResult) => BrepResult) | null = null;
vi.mock('@/lib/engine/brep-runner', async () => {
  const actual = await vi.importActual<typeof import('@/lib/engine/brep-runner')>('@/lib/engine/brep-runner');
  return { ...actual, runBrep: async (script: string) => { const r = await actual.runBrep(script); return override ? override(r) : r; } };
});
import { validateBrep } from '@/lib/agent/nodes/validate-brep';
import { runBrep } from '@/lib/engine/brep-runner';

const run = existsSync(geoPython()) ? it : it.skip;

const tube = (name: string, x: number, y: number) => ({
  name, description: '', localExtents: [12, 12, 40], position: [x, y, 5], shape: { kind: 'tube', axis: 'z', innerD: 8 },
});
const spec = normalizeSpec({
  sheet: '', assemblyName: 'pen_holder', assumptions: [], openQuestions: [],
  boundingBox: { width: 60, length: 60, height: 45 },
  components: [
    { name: 'base_plate', description: '', localExtents: [60, 60, 5], position: [0, 0, 0] },
    tube('tube_front_left', 5, 5), tube('tube_front_right', 43, 5), tube('tube_back_left', 5, 43), tube('tube_back_right', 43, 43),
  ],
} as unknown as AssemblySpec);

const stateFor = (code: string) => ({
  assemblySpec: spec, currentCode: code, attemptCount: 1, compileFailures: 0, semanticFailures: 0, modelInfo: null,
}) as unknown as AgentStateType;

describe('measure each part before fusing', () => {
  it('binds the labelled pre-fusion parts to _cadai_parts', () => {
    const { script } = emitBrepScript(spec);
    expect(script).toMatch(/^_cadai_parts = \[_p_base_plate, _p_tube_front_left,/m);
  });

  run('returns 5 labelled parts with their spec boxes and 1 fused solid', async () => {
    override = null;
    const r = await runBrep(emitBrepScript(spec).script);
    expect(r.ok, r.error).toBe(true);
    expect(r.parts.map((p) => p.label).sort()).toEqual(['base_plate', 'tube_back_left', 'tube_back_right', 'tube_front_left', 'tube_front_right']);
    for (const c of spec.components!) {
      const p = r.parts.find((x) => x.label === c.name)!;
      p.max.forEach((v, i) => expect(v - p.min[i]).toBeCloseTo(c.localExtents![i] as number, 1));
    }
    expect(r.solids).toBe(1);
  }, 60_000);

  run('validateBrep is clean for the real run and flags a part that differs from its localExtents', async () => {
    const code = emitBrepScript(spec).script;
    override = null;
    const clean = await validateBrep(stateFor(code));
    expect(clean.specViolations?.filter((v) => v.severity === 'error'), JSON.stringify(clean.specViolations)).toEqual([]);

    override = (r) => ({ ...r, parts: r.parts.map((p) => (p.label === 'tube_back_left' ? { ...p, max: [p.max[0], p.max[1], p.max[2] - 10] as [number, number, number] } : p)) });
    const bad = await validateBrep(stateFor(code));
    override = null;
    const extents = bad.specViolations?.filter((v) => v.kind === 'extents' && v.severity === 'error') ?? [];
    expect(extents.map((v) => v.field)).toEqual(['tube_back_left.z']);
    expect(bad.isValid).toBe(false);
  }, 60_000);
});
