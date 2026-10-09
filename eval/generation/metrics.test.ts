import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./judge', async () => {
  const actual = await vi.importActual<typeof import('./judge')>('./judge');
  return { ...actual, judgeCompiledModel: vi.fn() };
});

import { criticUserContent, judgeCompiledModel } from './judge';
import { measureVisualMatch, metricsFromState, summarize, scoresFor, GenerationMetrics } from './metrics';
import type { SpecBrief, SpecVariant } from '@/lib/agent/spec-variants';
import type { SpecViolation } from '@/lib/agent/spec-audit';

const judgeMock = vi.mocked(judgeCompiledModel);

function variant(id: SpecVariant['id'], review: SpecVariant['review']): SpecVariant {
  return {
    id, name: id, idea: '', spec: null, version: 1, drawnVersion: null, review, retries: 0, needsRevision: false,
  };
}

function brief(recommendedId: SpecBrief['recommendedId']): SpecBrief {
  return { markdown: '', assumptions: [], openQuestions: [], recommendedId };
}

const visual: SpecViolation = {
  kind: 'visual', severity: 'warning', field: 'geometry', expected: 'match', measured: 'off', message: 'off',
};

const counted = {
  variantCount: 0, variantsValidated: 0, reviewRounds: 0, chosenValidated: null, visualMatch: null, visualFindings: null,
} as const;

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
      floatingCount: 1, localFrameOk: false, shellsOk: true, attempts: 1, wallMs: 1234,
    });
    expect(m.errorKinds).toEqual(['floor', 'floating']);
  });

  it('returns nulls for measurements that could not be taken', () => {
    const m = metricsFromState('p2', 'm', { assemblySpec: null, currentCode: '', isValid: false, attemptCount: 0, validation: null, modelInfo: null, specViolations: [], placementReport: null }, 1);
    expect(m.specOk).toBe(false);
    expect(m.compileOk).toBe(false);
    expect(m.floorOk).toBeNull();
    expect(m.floatingCount).toBeNull();
    expect(m.localFrameOk).toBeNull();
    expect(m.variantCount).toBe(0);
    expect(m.chosenValidated).toBeNull();
  });

  it('counts variants still on the final state and ignores a stale capture', () => {
    const m = metricsFromState('p3', 'm', {
      specVariants: [
        variant('A', { validated: true, findings: [], attempts: 1 }),
        variant('B', { validated: false, findings: [], attempts: 4 }),
        variant('C', null),
      ],
      specBrief: brief('B'),
      specViolations: [visual],
    }, 10, {
      variants: [{ id: 'A', review: { validated: true, attempts: 9 } }],
      recommendedId: 'A',
    });
    expect(m.variantCount).toBe(3);
    expect(m.variantsValidated).toBe(1);
    expect(m.reviewRounds).toBe(4);
    expect(m.chosenValidated).toBe(false);
    expect(m.visualMatch).toBeNull();
    expect(m.visualFindings).toBeNull();
  });

  it('uses the spec-gate capture once the drafter has cleared the variants', () => {
    const m = metricsFromState('p4', 'm', { specVariants: [], specBrief: null, specViolations: [] }, 10, {
      variants: [
        { id: 'A', review: { validated: true, attempts: 2 } },
        { id: 'B', review: { validated: false, attempts: 5 } },
      ],
      recommendedId: 'A',
    });
    expect(m.variantCount).toBe(2);
    expect(m.variantsValidated).toBe(1);
    expect(m.reviewRounds).toBe(5);
    expect(m.chosenValidated).toBe(true);
    expect(m.visualMatch).toBeNull();
    expect(m.visualFindings).toBeNull();
  });

  it('does not treat a missing visual violation as a match', () => {
    const unjudged = metricsFromState('p5', 'm', {
      specViolations: [violation('interference')],
      stlContent: 'solid x',
      isValid: false,
    }, 1);
    expect(unjudged.visualMatch).toBeNull();
    expect(unjudged.visualFindings).toBeNull();

    const judged = metricsFromState('p5', 'm', {
      specViolations: [violation('interference')],
    }, 1, null, { visualMatch: false, visualFindings: 2 });
    expect(judged.visualMatch).toBe(false);
    expect(judged.visualFindings).toBe(2);
  });
});

describe('measureVisualMatch', () => {
  beforeEach(() => judgeMock.mockReset());

  it('stays null when the critic is off or there is no STL', async () => {
    const off = await measureVisualMatch({ criticOn: false, stl: 'solid', request: 'a stand', spec: null });
    const empty = await measureVisualMatch({ criticOn: true, stl: '', request: 'a stand', spec: null });
    expect(off).toEqual({ visualMatch: null, visualFindings: null });
    expect(empty).toEqual({ visualMatch: null, visualFindings: null });
    expect(judgeMock).not.toHaveBeenCalled();
  });

  it('stays null when the judge call fails', async () => {
    judgeMock.mockResolvedValue(null);
    const score = await measureVisualMatch({ criticOn: true, stl: 'solid', request: 'a stand', spec: null });
    expect(score).toEqual({ visualMatch: null, visualFindings: null });
  });

  it('is true when the judge matches and reports no major finding', async () => {
    judgeMock.mockResolvedValue({
      matchesIntent: true,
      findings: [{ issue: 'a small mark', severity: 'minor', view: 'front' }],
    });
    const score = await measureVisualMatch({ criticOn: true, stl: 'solid', request: 'a 30 degree stand', spec: null });
    expect(score).toEqual({ visualMatch: true, visualFindings: 1 });
    expect(judgeMock).toHaveBeenCalledWith({ stl: 'solid', request: 'a 30 degree stand', spec: null });
  });

  it('is false when intent does not match or a finding is major', async () => {
    judgeMock.mockResolvedValue({
      matchesIntent: true,
      findings: [{ issue: 'the arm points down', severity: 'major', view: 'front' }],
    });
    const major = await measureVisualMatch({ criticOn: true, stl: 'solid', request: 'a stand', spec: null });
    expect(major).toEqual({ visualMatch: false, visualFindings: 1 });

    judgeMock.mockResolvedValue({ matchesIntent: false, findings: [] });
    const rejected = await measureVisualMatch({ criticOn: true, stl: 'solid', request: 'a stand', spec: null });
    expect(rejected).toEqual({ visualMatch: false, visualFindings: 0 });
  });
});

describe('criticUserContent', () => {
  it('quotes the user request and labels each view image', () => {
    const content = criticUserContent('a 30 degree stand', null, [
      { name: 'front', dataUrl: 'data:image/png;base64,aa' },
      { name: 'iso', dataUrl: 'data:image/png;base64,bb' },
    ]);
    const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    expect(text).toContain('"a 30 degree stand"');
    expect(text).toContain('View: front');
    expect(text).toContain('View: iso');
    expect(content.filter((part) => part.type === 'image_url')).toHaveLength(2);
  });
});

describe('summarize', () => {
  it('reports rates over non-null values', () => {
    const rows: GenerationMetrics[] = [
      { id: 'a', model: 'm', specOk: true, composed: true, compileOk: true, floorOk: true, floatingCount: 0, localFrameOk: true, extentsOk: null, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 10, variantCount: 2, variantsValidated: 2, reviewRounds: 1, chosenValidated: true, visualMatch: true, visualFindings: 2 },
      { id: 'b', model: 'm', specOk: true, composed: false, compileOk: true, floorOk: false, floatingCount: null, localFrameOk: null, extentsOk: null, shellsOk: false, errorKinds: ['floor'], attempts: 1, wallMs: 21, variantCount: 0, variantsValidated: 0, reviewRounds: 3, chosenValidated: false, visualMatch: null, visualFindings: null },
    ];
    const s = summarize(rows);
    expect(s.composed).toBe('1/2');
    expect(s.floorOk).toBe('1/2');
    expect(s.noFloating).toBe('1/1');
    expect(s.localFrameOk).toBe('1/1');
    expect(s.extentsOk).toBe('0/0');
    expect(s.meanVariantCount).toBe('1.0');
    expect(s.meanVariantsValidated).toBe('1.0');
    expect(s.meanReviewRounds).toBe('2.0');
    expect(s.chosenValidated).toBe('1/2');
    expect(s.visualMatch).toBe('1/1');
    expect(s.meanVisualFindings).toBe('2.0');
    expect(s.meanWallMs).toBe('15.5');
  });
});

describe('scoresFor', () => {
  it('emits boolean scores and skips unmeasured ones', () => {
    const metrics: GenerationMetrics = { id: 'a', model: 'm', specOk: true, composed: true, compileOk: true, floorOk: null, floatingCount: null, localFrameOk: true, extentsOk: null, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 10, ...counted };
    const names = scoresFor(metrics).map((s) => s.name);
    expect(names).toEqual([
      'spec_ok', 'composed', 'compile_ok', 'local_frame_ok', 'shells_ok',
      'variant_count', 'variants_validated', 'review_rounds', 'wall_ms',
    ]);
  });

  it('scores the chosen variant and the visual match when they were measured', () => {
    const metrics: GenerationMetrics = {
      id: 'a', model: 'm', specOk: true, composed: true, compileOk: true, floorOk: null,
      floatingCount: null, localFrameOk: null, extentsOk: null, shellsOk: null, errorKinds: [],
      attempts: 1, wallMs: 10, variantCount: 2, variantsValidated: 1, reviewRounds: 3,
      chosenValidated: false, visualMatch: true, visualFindings: 2,
    };
    const scores = scoresFor(metrics);
    expect(scores.find((s) => s.name === 'chosen_validated')).toEqual({ name: 'chosen_validated', value: 0, dataType: 'BOOLEAN' });
    expect(scores.find((s) => s.name === 'visual_match')).toEqual({ name: 'visual_match', value: 1, dataType: 'BOOLEAN' });
    expect(scores.find((s) => s.name === 'visual_findings')).toEqual({ name: 'visual_findings', value: 2, dataType: 'NUMERIC' });
    expect(scores.find((s) => s.name === 'review_rounds')?.value).toBe(3);
  });
});
