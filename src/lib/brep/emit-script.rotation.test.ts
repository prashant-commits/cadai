import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { normalizeSpec } from '@/lib/agent/spec-normalize';
import { placedBounds } from '@/lib/design/placement-geometry';
import { emitBrepScript } from './emit-script';
import { geoPython, runScriptForTest } from './test-run';

const run = existsSync(geoPython()) ? it : it.skip;

describe('emitBrepScript placement', () => {
  run('a three-axis rotation lands where placedBounds says (X, then Y, then Z)', async () => {
    const comp = { name: 'r', description: '', localExtents: [10, 20, 30], position: [100, 5, 7], rotation: [30, 40, 50] };
    const s = normalizeSpec({ sheet: '', assemblyName: 'a', assumptions: [], openQuestions: [], components: [comp] } as unknown as AssemblySpec);
    const r = await runScriptForTest(emitBrepScript(s).script);
    const want = placedBounds({ min: [0, 0, 0], max: [10, 20, 30] }, [100, 5, 7], [30, 40, 50]);
    const got = r.parts.find((p) => p.label === 'r')!;
    got.min.forEach((v, i) => expect(v).toBeCloseTo(want.min[i], 2));
    got.max.forEach((v, i) => expect(v).toBeCloseTo(want.max[i], 2));
  }, 120_000);
});
