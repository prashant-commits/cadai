import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { firstErrorOf, finalizeMetrics, geometryChanged, perturbParams, thrownDetail, type BrepEvalDeps } from './brep-eval';
import { stlFingerprint } from './fingerprint';
import { metricsFromState } from './metrics';
import { saveRunArtifacts } from './run-artifacts';
import type { BrepResult } from '@/lib/engine/brep-runner';
import type { AgentStateType } from '@/lib/agent/graph';

type State = Partial<AgentStateType>;
const b64 = (text: string) => Buffer.from(text).toString('base64');

/** A plate-shaped STL with a hole outline at x. The plate bbox never moves. */
function plateStl(holeX: number, fmt = (n: number) => String(n)): string {
  const tri = (a: number[], b: number[], c: number[]) =>
    `facet normal 0 0 1\nouter loop\n${[a, b, c].map((v) => `vertex ${v.map(fmt).join(' ')}`).join('\n')}\nendloop\nendfacet\n`;
  return b64('solid m\n'
    + tri([0, 0, 0], [40, 0, 0], [40, 20, 0]) + tri([0, 0, 0], [40, 20, 0], [0, 20, 0])
    + tri([holeX, 5, 0], [holeX + 4, 5, 0], [holeX + 4, 9, 0]) + tri([holeX, 5, 0], [holeX + 4, 9, 0], [holeX, 9, 0])
    + 'endsolid m\n');
}

const part = { label: 'plate', valid: true, volume: 1600, min: [0, 0, 0] as [number, number, number], max: [40, 20, 2] as [number, number, number] };
const run = (holeX: number): BrepResult => ({ ok: true, solids: 1, ms: 1, parts: [part], bbox: { min: part.min, max: part.max }, stl: plateStl(holeX) });

describe('stlFingerprint', () => {
  it('sees a hole that moves inside a plate with bbox and volume unchanged', () => {
    expect(stlFingerprint(plateStl(10))).not.toBe(stlFingerprint(plateStl(14)));
    expect(geometryChanged(run(10), run(14))).toBe(true);
  });

  it('ignores float formatting at 1e-4 and the order of vertices and triangles', () => {
    const noisy = plateStl(10, (n) => (n + 0.00001).toFixed(7));
    expect(stlFingerprint(noisy)).toBe(stlFingerprint(plateStl(10)));
    expect(geometryChanged(run(10), { ...run(10), stl: noisy })).toBe(false);
    const lines = Buffer.from(plateStl(10), 'base64').toString().split('facet normal 0 0 1\n');
    const shuffled = b64([lines[0], lines[2], lines[1], lines[4], lines[3]].join('facet normal 0 0 1\n'));
    expect(stlFingerprint(shuffled)).toBe(stlFingerprint(plateStl(10)));
  });

  it('still falls back to bbox and volume when a run has no STL', () => {
    const a = { ...run(10), stl: undefined };
    expect(geometryChanged(a, { ...a })).toBe(false);
    expect(geometryChanged(a, { ...a, parts: [{ ...part, volume: 1700 }] })).toBe(true);
  });

  it('counts hole parameters live', async () => {
    const script = ['from build123d import *', 'hole_z1 = 10  # [5:1:30] hole', 'plate_t = 2  # [1:1:5] thickness',
      'def plate():', '    return Box(40, 20, plate_t) - Pos(hole_z1, 7, 0) * Cylinder(2, 5)'].join('\n');
    const r = await perturbParams(script, run(10), async (s) => run(/hole_z1 = (\d+)/.exec(s)![1] === '10' ? 10 : Number(/hole_z1 = (\d+)/.exec(s)![1])));
    expect(r.live).toBe(1);
    expect(r.deadNames).toEqual(['plate_t']);
  });
});

describe('failure detail', () => {
  const noSpec = (over: State = {}) =>
    metricsFromState('p', 'm', { kernel: 'openscad', assemblySpec: null, currentCode: '', specViolations: [], ...over } as State, 5);
  const deps: BrepEvalDeps = { runBrep: async () => run(10), checkStep: async () => ({ solids: 1, valid: true }) };

  it('says why a run produced no spec, from the last message', async () => {
    const state = { messages: [{ content: 'The spec failed validation: components[2].shape is not a profile' }] } as unknown as State;
    expect(firstErrorOf(state)).toContain('components[2].shape');
    const m = await finalizeMetrics(noSpec(), state, deps);
    expect(m.failureStage).toBe('spec');
    expect(m.failureDetail).toContain('no assembly spec: last message: The spec failed validation');
  });

  it('keeps the old text when the state has nothing to say', async () => {
    expect((await finalizeMetrics(noSpec(), {}, deps)).failureDetail).toBe('no assembly spec was produced');
  });

  it('records a thrown error with its stack head, and never calls the run workable', async () => {
    const err = new Error('429 rate limited');
    err.stack = 'Error: 429 rate limited\n    at callModel (graph.ts:10:5)\n    at run (graph.ts:20:1)';
    const detail = thrownDetail(err);
    expect(detail).toBe('graph threw: 429 rate limited | at callModel (graph.ts:10:5) | at run (graph.ts:20:1)');
    const m = await finalizeMetrics(noSpec(), {}, deps, detail);
    expect(m).toMatchObject({ workable: false, failureStage: 'spec' });
    expect(m.failureDetail).toContain('graph threw: 429 rate limited');
    const ok = metricsFromState('p', 'm', { kernel: 'openscad', assemblySpec: {}, currentCode: '', validation: { valid: true }, specViolations: [] } as unknown as State, 5);
    const thrownOk = await finalizeMetrics(ok, {}, deps, detail);
    expect(thrownOk).toMatchObject({ workable: false, failureDetail: detail });
  });
});

describe('saveRunArtifacts', () => {
  it('writes the script and the spec next to each other', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
    const jsonl = path.join(dir, 't-brep-s1-m-stamp.jsonl');
    const files = saveRunArtifacts(jsonl, 'pen', 'brep', { currentCode: 'x = 1', assemblySpec: { assemblyName: 'pen' } as never });
    expect(files.map((f) => path.basename(f))).toEqual(['t-brep-s1-m-stamp-pen.py', 't-brep-s1-m-stamp-pen.spec.json']);
    expect(JSON.parse(fs.readFileSync(files[1], 'utf8'))).toEqual({ assemblyName: 'pen' });
    expect(saveRunArtifacts(jsonl, 'none', 'openscad', {})).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });
});
