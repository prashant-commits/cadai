import { describe, it, expect } from 'vitest';
import { metricsFromState, summarize, scoresFor } from './metrics';

const violation = (kind: string, severity: 'error' | 'warning' = 'error') =>
  ({ kind, severity, field: '', expected: '', measured: '', message: '' }) as any;

describe('metricsFromState', () => {
  it('reads composition, floor, floating and local-frame from state', () => {
    const m = metricsFromState('p1', 'deepseek-v4-flash', {
      assemblySpec: { assemblyName: 'a', boundingBox: { width: 1, length: 1, height: 1 }, components: [{ name: 'x', description: '' }] } as any,
      currentCode: 'module x() {}',
      isValid: false,
      attemptCount: 1,
      validation: { valid: true } as any,
      modelInfo: { boundingBox: { min: [0, 0, -5], max: [1, 1, 1] } } as any,
      specViolations: [violation('floor'), violation('floating'), violation('local_frame', 'warning')],
      placementReport: {
        composed: true, removedStatements: 2,
        components: [{ name: 'x', measured: true, localMin: [0, 0, -5], localMax: [1, 1, 1], size: [1, 1, 6], correction: [0, 0, 5], position: [0, 0, 0], rotation: [0, 0, 0], placedMin: [0, 0, 0], placedMax: [1, 1, 6] }],
      },
    }, 1234);
    expect(m).toMatchObject({
      id: 'p1', specOk: true, composed: true, compileOk: true, floorOk: false,
      floatingCount: 1, localFrameOk: false, shellsOk: true, attempts: 1, wallMs: 1234, researchRan: false, citedApproachChosen: null,
    });
    expect(m.errorKinds).toEqual(['floor', 'floating']);
  });

  it('returns nulls for measurements that could not be taken', () => {
    const m = metricsFromState('p2', 'm', { assemblySpec: null, currentCode: '', isValid: false, attemptCount: 0, validation: null, modelInfo: null, specViolations: [], placementReport: null, researchSkipReason: null, designBrief: null }, 1);
    expect(m.specOk).toBe(false);
    expect(m.compileOk).toBe(false);
    expect(m.floorOk).toBeNull();
    expect(m.floatingCount).toBeNull();
    expect(m.localFrameOk).toBeNull();
    expect(m.researchRan).toBe(false);
    expect(m.citedApproachChosen).toBeNull();
  });

  it('records whether research ran and whether the chosen approach was cited', () => {
    const chosen = (grounding: 'cited' | 'recalled') => ({
      partClass: 'x',
      chosenAt: 1,
      approach: { id: 'a1', name: 'n', construction: 'c', strengths: [], weaknesses: [], sources: [], grounding },
    });
    const ran = metricsFromState('p3', 'm', {
      researchSkipReason: null,
      designBrief: { partClass: 'x', approaches: [], recommendedId: 'a1', searchQueries: [] } as any,
      designContract: { standing: {}, pinnedParams: {}, researchApproach: chosen('cited') },
      specViolations: [],
    }, 1);
    expect(ran.researchRan).toBe(true);
    expect(ran.citedApproachChosen).toBe(true);

    const skipped = metricsFromState('p4', 'm', { researchSkipReason: 'no_provider', designBrief: null, specViolations: [] }, 1);
    expect(skipped.researchRan).toBe(false);
    expect(skipped.citedApproachChosen).toBeNull();

    const recalled = metricsFromState('p5', 'm', {
      researchSkipReason: null,
      designBrief: { partClass: 'x', approaches: [], recommendedId: 'a1', searchQueries: [] } as any,
      designContract: { standing: {}, pinnedParams: {}, researchApproach: chosen('recalled') },
      specViolations: [],
    }, 1);
    expect(recalled.citedApproachChosen).toBe(false);
  });
});

describe('summarize', () => {
  it('reports rates over non-null values', () => {
    const rows = [
      { id: 'a', model: 'm', specOk: true, composed: true, compileOk: true, floorOk: true, floatingCount: 0, localFrameOk: true, extentsOk: null, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 10, researchRan: false, citedApproachChosen: null },
      { id: 'b', model: 'm', specOk: true, composed: false, compileOk: true, floorOk: false, floatingCount: null, localFrameOk: null, extentsOk: null, shellsOk: false, errorKinds: ['floor'], attempts: 1, wallMs: 20, researchRan: false, citedApproachChosen: null },
    ];
    const s = summarize(rows);
    expect(s.composed).toBe('1/2');
    expect(s.floorOk).toBe('1/2');
    expect(s.noFloating).toBe('1/1');
    expect(s.localFrameOk).toBe('1/1');
    expect(s.extentsOk).toBe('0/0');
    expect(s.researchRan).toBe('0/2');
    expect(s.citedApproachChosen).toBe('0/0');
    expect(s.meanWallMs).toBe('15');
  });
});

describe('scoresFor', () => {
  it('emits boolean scores and skips unmeasured ones', () => {
    const names = scoresFor({ id: 'a', model: 'm', specOk: true, composed: true, compileOk: true, floorOk: null, floatingCount: null, localFrameOk: true, extentsOk: null, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 10, researchRan: false, citedApproachChosen: null }).map((s) => s.name);
    expect(names).toEqual(['spec_ok', 'composed', 'compile_ok', 'local_frame_ok', 'shells_ok', 'research_ran', 'wall_ms']);
  });
});
