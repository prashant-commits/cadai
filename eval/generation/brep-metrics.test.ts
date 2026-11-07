import { describe, it, expect, vi } from 'vitest';
import { finalizeMetrics, geometryChanged, perturbParams, type BrepEvalDeps } from './brep-eval';
import { failureOf, isWorkable, metricsFromState, perturbedValue, withVerdict, type GenerationMetrics } from './metrics';
import type { BrepResult } from '@/lib/engine/brep-runner';
import type { AgentStateType } from '@/lib/agent/graph';

type State = Partial<AgentStateType>;
const as_ = <T,>(v: unknown) => v as T;

const SCRIPT = [
  'from build123d import *',
  'width = 40  # [20:5:80] width',
  'height = 80  # [20:10:80] at the max',
  'depth = 10  # [10:10:10] pinned',
  'note = 3  # [1:1:9] only drawn as a guide',
  'shim = 2  # [0:1:5] read by the body, but the mock ignores it',
  'def body():',
  '    return Box(width, 10, height + 0 * shim)',
].join('\n');

function result(width: number, extra: Partial<BrepResult> = {}): BrepResult {
  return {
    ok: true, solids: 1, ms: 5, step: 'U1RFUA==',
    parts: [{ label: 'body', valid: true, volume: width * 10 * 80, min: [0, 0, 0], max: [width, 10, 80] }],
    bbox: { min: [0, 0, 0], max: [width, 10, 80] },
    ...extra,
  };
}

const spec = as_<State['assemblySpec']>({ assemblyName: 'a', boundingBox: { width: 1, length: 1, height: 1 }, components: [{ name: 'body', description: '' }] });
const okAttempt = { n: 1, phase: 'draft', code: SCRIPT, exitCode: 0, errors: [], warnings: [], violations: [], diagnosis: '' };

function brepState(over: Record<string, unknown> = {}): State {
  return as_<State>({
    kernel: 'brep', assemblySpec: spec, currentCode: SCRIPT, attemptCount: 1, validation: { valid: true },
    modelInfo: { boundingBox: { min: [0, 0, 0], max: [1, 1, 1] } }, specViolations: [], stepContent: 'U1RFUA==',
    attemptHistory: [okAttempt], placementReport: null, ...over,
  });
}

const base = (state: State) => metricsFromState('p', 'claude-haiku-5.5', state, 1000);

/** Any change to width or height moves the model. Shim never does, so it is dead; depth is fixed and note is a guide. */
const liveWidthDeps = (over: Partial<BrepEvalDeps> = {}): BrepEvalDeps => ({
  checkStep: async () => ({ solids: 1, valid: true }),
  runBrep: async (script) => {
    const w = Number(/^width = (\d+)/m.exec(script)![1]);
    const h = Number(/^height = (\d+)/m.exec(script)![1]);
    return result(w + (h === 80 ? 0 : 1));
  },
  ...over,
});
/** A script whose three parameters all feed geometry, and a model that depends on all three. */
const LIVE_SCRIPT = [
  'from build123d import *',
  'width = 40  # [20:5:80] width',
  'height = 80  # [20:10:80] at the max',
  'depth = 10  # [10:10:50] depth',
  'def body():',
  '    return Box(width, depth, height)',
].join('\n');
const allLiveDeps = (over: Partial<BrepEvalDeps> = {}): BrepEvalDeps => ({
  checkStep: async () => ({ solids: 1, valid: true }),
  runBrep: async (script) => {
    const n = (k: string) => Number(new RegExp(`^${k} = (\\d+)`, 'm').exec(script)![1]);
    return result(n('width') + n('height') + n('depth'));
  },
  ...over,
});

describe('perturbedValue', () => {
  it('adds the step when it stays in range', () => expect(perturbedValue({ value: 40, min: 20, step: 5, max: 80 })).toBe(45));
  it('subtracts the step at the max', () => expect(perturbedValue({ value: 80, min: 20, step: 10, max: 80 })).toBe(70));
  it('falls to the midpoint when neither step fits', () => expect(perturbedValue({ value: 5, min: 0, step: 30, max: 20 })).toBe(10));
  it('returns null when the midpoint is the value itself', () => expect(perturbedValue({ value: 10, min: 0, step: 30, max: 20 })).toBeNull());
  it('returns null when the range admits no other value', () => expect(perturbedValue({ value: 10, min: 10, step: 10, max: 10 })).toBeNull());
  it('steps 10% for an unannotated parameter', () => expect(perturbedValue({ value: 50 })).toBe(55));
});

describe('geometryChanged', () => {
  it('ignores sub-1e-6 relative noise', () => expect(geometryChanged(result(40), result(40 + 1e-9))).toBe(false));
  it('sees a bbox change', () => expect(geometryChanged(result(40), result(41))).toBe(true));
  it('sees a volume-only change', () => {
    const b = result(40);
    b.parts[0].volume += 10;
    expect(geometryChanged(result(40), b)).toBe(true);
  });
});

describe('perturbParams', () => {
  it('counts live, dead and breaking parameters', async () => {
    const run = vi.fn(async (script: string) => {
      if (/^width = 45/m.test(script)) return result(45);
      if (/^height = 70/m.test(script)) return { ...result(40), ok: false, error: 'boom' } as BrepResult;
      return result(40);
    });
    const r = await perturbParams(SCRIPT, result(40), run);
    expect(r).toEqual({
      tested: 3, live: 2, dead: 1, deadNames: ['shim'], breaking: 1, total: 5, fixed: ['depth'], guide: ['note'],
    });
  });

  it('caps the tested parameters at 12', async () => {
    const names = Array.from({ length: 15 }, (_, i) => `p${i}`);
    const many = ['from build123d import *', ...names.map((n) => `${n} = 10  # [0:1:20]`), 'def body():', `    return Box(${names.slice(0, 3).join(', ')}) + ${names.slice(3).map((n) => `${n}`).join(' + ')}`].join('\n');
    const r = await perturbParams(many, result(40), async () => result(40));
    expect(r).toMatchObject({ tested: 12, total: 15, dead: 12, guide: [] });
  });
});

describe('finalizeMetrics (B-rep)', () => {
  it('scores a good run as workable', async () => {
    const state = brepState({ currentCode: LIVE_SCRIPT });
    const m = await finalizeMetrics(base(state), state, allLiveDeps());
    expect(m).toMatchObject({
      kernel: 'brep', brepOk: true, stepOk: true, partsTotal: 1, partsValid: 1,
      paramCount: 3, paramTotal: 3, eligibleParams: 3, liveParams: 3, deadParams: 0, deadParamNames: [], fixedParams: [], guideParams: [], breakingParams: 0,
      failureStage: 'none', workable: true,
    });
  });

  it('fails at geometry when the last run failed', async () => {
    const state = brepState({
      attemptHistory: [{ ...okAttempt, exitCode: 1, errors: [{ message: 'NameError: x' }] }],
      stepContent: null, validation: { valid: true },
    });
    const m = await finalizeMetrics(base(state), state, liveWidthDeps());
    expect(m).toMatchObject({ brepOk: false, workable: false, failureStage: 'geometry' });
    expect(m.failureDetail).toContain('NameError');
    expect(m.liveParams).toBeUndefined();
  });

  it('fails at step when the STEP is missing', async () => {
    const state = brepState({ stepContent: null });
    const checkStep = vi.fn();
    const m = await finalizeMetrics(base(state), state, liveWidthDeps({ checkStep }));
    expect(checkStep).not.toHaveBeenCalled();
    expect(m).toMatchObject({ stepOk: false, workable: false, failureStage: 'step' });
  });

  it('fails at step when the STEP does not re-import', async () => {
    const m = await finalizeMetrics(base(brepState()), brepState(), liveWidthDeps({ checkStep: async () => ({ solids: 0, valid: false, error: 'bad file' }) }));
    expect(m).toMatchObject({ stepOk: false, failureStage: 'step', failureDetail: 'bad file' });
  });

  it('fails at params when every parameter is dead', async () => {
    const m = await finalizeMetrics(base(brepState()), brepState(), liveWidthDeps({ runBrep: async () => result(40) }));
    expect(m).toMatchObject({ eligibleParams: 3, liveParams: 0, deadParams: 3, workable: false, failureStage: 'params' });
    expect(m.deadParamNames).toEqual(['width', 'height', 'shim']);
    expect(m.fixedParams).toEqual(['depth']);
    expect(m.guideParams).toEqual(['note']);
    expect(m.failureDetail).toContain('dead: width, height, shim');
  });

  it('treats a baseline that does not re-run as a geometry failure', async () => {
    const m = await finalizeMetrics(base(brepState()), brepState(), liveWidthDeps({ runBrep: async () => ({ ...result(1), ok: false, error: 'flaky' }) }));
    expect(m).toMatchObject({ brepOk: false, failureStage: 'geometry' });
    expect(m.failureDetail).toContain('flaky');
  });

  it('counts a breaking perturbation as live and reports it separately', async () => {
    const m = await finalizeMetrics(base(brepState()), brepState(), liveWidthDeps({
      runBrep: async (script) => (/^height = 70/m.test(script) ? ({ ...result(1), ok: false, error: 'x' } as BrepResult) : result(40)),
    }));
    expect(m).toMatchObject({ eligibleParams: 3, liveParams: 1, breakingParams: 1, deadParams: 2 });
    expect(m.failureStage).toBe('params');
  });
});

const openscad = (over: Partial<GenerationMetrics> = {}): GenerationMetrics => ({
  id: 'p', model: 'm', kernel: 'openscad', specOk: true, composed: true, compileOk: true, floorOk: true, floatingCount: 0,
  localFrameOk: true, extentsOk: true, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 1, paramCount: 10, deadParams: 1,
  liveParams: 9, variantCount: 0, variantsValidated: 0, reviewRounds: 0, chosenValidated: null, visualMatch: null, visualFindings: null,
  ...over,
});

describe('workable', () => {
  it('accepts a clean OpenSCAD run', () => expect(isWorkable(openscad())).toBe(true));
  it('accepts null extents/floor/floating (unmeasured)', () =>
    expect(isWorkable(openscad({ extentsOk: null, floorOk: null, floatingCount: null }))).toBe(true));
  it.each([
    ['no spec', { specOk: false }, 'spec'],
    ['compile failed', { compileOk: false }, 'geometry'],
    ['extents', { extentsOk: false }, 'validation'],
    ['floor', { floorOk: false }, 'validation'],
    ['floating', { floatingCount: 2 }, 'validation'],
    ['dead params', { deadParams: 5, liveParams: 5 }, 'params'],
  ] as const)('rejects OpenSCAD with %s', (_n, over, stage) => {
    const m = openscad(over as Partial<GenerationMetrics>);
    expect(isWorkable(m)).toBe(false);
    expect(failureOf(m).failureStage).toBe(stage);
  });
  it('passes at exactly 80% live', () => expect(isWorkable(openscad({ paramCount: 10, liveParams: 8 }))).toBe(true));
  it('accepts zero parameters', () => expect(isWorkable(openscad({ paramCount: 0, liveParams: 0 }))).toBe(true));
  it('needs stepOk on the B-rep kernel only', () => {
    const brep = openscad({ kernel: 'brep', brepOk: true, compileOk: false, stepOk: false });
    expect(isWorkable(brep)).toBe(false);
    expect(failureOf(brep).failureStage).toBe('step');
    expect(isWorkable({ ...brep, stepOk: true })).toBe(true);
  });
  it('uses brepOk, not compileOk, for geometry on B-rep', () =>
    expect(isWorkable(openscad({ kernel: 'brep', brepOk: false, compileOk: true, stepOk: true }))).toBe(false));
  it('withVerdict writes the three verdict fields', () =>
    expect(withVerdict(openscad())).toMatchObject({ workable: true, failureStage: 'none' }));
});

describe('OpenSCAD rows', () => {
  it('get kernel, live params and a verdict without touching the kernel', async () => {
    const state = as_<State>({
      assemblySpec: spec, currentCode: 'a = 5; // [1:1:9] a\nb = 6; // [1:1:9] b\nmodule m() { cube([a, b, 1]); }\n', validation: { valid: true }, attemptCount: 1,
      modelInfo: { boundingBox: { min: [0, 0, 0], max: [1, 1, 1] } },
      specViolations: [{ kind: 'dead_parameter', severity: 'warning', field: 'b', expected: '', measured: '', message: '' }],
      placementReport: null,
    });
    const deps = { runBrep: vi.fn(), checkStep: vi.fn() };
    const m = await finalizeMetrics(base(state), state, deps);
    expect(deps.runBrep).not.toHaveBeenCalled();
    expect(m).toMatchObject({ kernel: 'openscad', paramCount: 2, eligibleParams: 2, deadParams: 1, deadParamNames: ['b'], liveParams: 1, workable: false, failureStage: 'params' });
  });
});
