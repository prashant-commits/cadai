import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSpec } from '../spec-expr';
import type { AssemblySpec } from '../assembly-spec';
import { BUILDER_MODE_REASON } from '../../brep/body-check';

const runBrep = vi.hoisted(() => vi.fn());
vi.mock('../../engine/brep-runner', () => ({ runBrep }));

import { validateBrep } from './validate-brep';

const spec = resolveSpec({
  sheet: '## Holder', assemblyName: 'holder', boundingBox: { width: 120, length: 106, height: 160 },
  guides: [], stressPoints: [], assumptions: [], openQuestions: [],
  parameters: [{ name: 'ring_id', value: 90, min: 60, max: 120, unit: 'mm', description: 'ring inner diameter' }],
  components: [
    { name: 'backplate', description: 'plate', localExtents: [120, 6, 160], position: [0, 0, 0], shape: { kind: 'box' } },
    { name: 'cup_ring', description: 'ring', localExtents: [100, 100, 30], position: [10, 6, 100], shape: { kind: 'tube', axis: 'z', innerD: 'ring_id' } },
  ],
} as unknown as AssemblySpec).spec;

const base = { currentCode: 'result = 1', assemblySpec: spec, attemptCount: 1, compileFailures: 0, failureKind: 'none', buildNotes: [] };
const run = (over: Record<string, unknown> = {}) => validateBrep({ ...base, ...over } as never);

beforeEach(() => runBrep.mockReset());

describe('validateBrep repair hints', () => {
  it('adds one fix line for A face or sketch must be provided', async () => {
    runBrep.mockResolvedValue({ ok: false, error: 'Traceback\nValueError: A face or sketch must be provided', parts: [], solids: 0, ms: 1 });
    const out = await run();
    const message = out.specViolations![0].message;
    expect(message).toContain('build123d script failed:');
    expect(message).toContain('\nFix: ');
    expect(message).toContain('extrude(Plane.YZ * Polygon(*pts, align=None), amount=w)');
    expect(message.match(/\nFix: /g)).toHaveLength(1);
    expect(out.failureKind).toBe('compile');
  });

  it('adds the keyword and name hints, and nothing for an unknown error', async () => {
    runBrep.mockResolvedValue({ ok: false, error: "TypeError: Cylinder.__init__() got an unexpected keyword argument 'axis'", parts: [], solids: 0, ms: 1 });
    expect((await run()).specViolations![0].message).toContain('rotation=(0, 90, 0)');
    runBrep.mockResolvedValue({ ok: false, error: "NameError: name 'plate_w' is not defined", parts: [], solids: 0, ms: 1 });
    expect((await run()).specViolations![0].message).toContain('plate_w is not defined');
    runBrep.mockResolvedValue({ ok: false, error: 'RuntimeError: odd', parts: [], solids: 0, ms: 1 });
    expect((await run()).specViolations![0].message).not.toContain('Fix:');
  });
});

describe('validateBrep invalid solids', () => {
  it('routes an invalid-solid failure back to the build step with one error per named part', async () => {
    runBrep.mockResolvedValue({
      ok: false, error: 'invalid solid: the fused result after STEP export (backplate, cup_ring); the kernel could not repair it',
      invalid: ['backplate', 'cup_ring'], parts: [], solids: 0, ms: 1,
    });
    const out = await run();
    expect(out.isValid).toBe(false);
    expect(out.failureKind).toBe('compile');
    expect(out.specViolations!.map((v) => [v.kind, v.field, v.severity])).toEqual([
      ['manifold', 'backplate', 'error'],
      ['manifold', 'cup_ring', 'error'],
    ]);
    expect(out.specViolations![0].message).toContain('backplate belongs to a solid that is not valid');
  });
});

describe('validateBrep builder-mode notes', () => {
  const ok = { ok: true, parts: [], solids: 1, ms: 1, stl: undefined };

  it('a with Build... rejection is an error naming the part, other notes stay warnings', async () => {
    runBrep.mockResolvedValue(ok);
    const out = await run({
      buildNotes: [
        { name: 'backplate', reason: `body rejected (${BUILDER_MODE_REASON}); drawn from the blockout` },
        { name: 'cup_ring', reason: 'body rejected (import is not allowed in a body); drawn from the blockout' },
      ],
    });
    const notes = out.specViolations!.filter((v) => v.kind === 'build');
    expect(notes.map((v) => [v.field, v.severity])).toEqual([['backplate', 'error'], ['cup_ring', 'warning']]);
    expect(notes[0].message).toContain('algebra mode only');
  });
});

describe('validateBrep after a cut-off or refused build reply', () => {
  it.each(['truncated', 'no_code'])('%s: no geometry run, a failed attempt', async (failureKind) => {
    const out = await run({ failureKind });
    expect(runBrep).not.toHaveBeenCalled();
    expect(out.isValid).toBe(false);
    expect(out.attemptHistory![0]).toMatchObject({ diagnosis: failureKind, exitCode: 1, code: 'result = 1' });
  });
});
