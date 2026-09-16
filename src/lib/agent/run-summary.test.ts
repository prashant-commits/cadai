import { describe, it, expect } from 'vitest';
import { composeRunSummary } from './run-summary';

const spec = {
  assemblyName: 'bracket_body',
  boundingBox: { width: 62, length: 40, height: 18 },
  components: [{ name: 'body', description: 'main body' }],
  assumptions: [],
  openQuestions: [],
} as never;

const modelInfo = {
  dimensions: { x: 62, y: 40, z: 18 },
  volumeMm3: 12_000,
} as never;

describe('composeRunSummary', () => {
  it('names the assembly and its measured dimensions', () => {
    const out = composeRunSummary({ spec, modelInfo, violations: [], attempts: 1, isValid: true });
    expect(out).toContain('bracket_body');
    expect(out).toContain('62 x 40 x 18 mm');
  });

  it('reports repairs when more than one attempt ran', () => {
    const out = composeRunSummary({ spec, modelInfo, violations: [], attempts: 3, isValid: true });
    expect(out).toMatch(/2 repair/);
  });

  it('says so plainly when the first attempt compiled', () => {
    const out = composeRunSummary({ spec, modelInfo, violations: [], attempts: 1, isValid: true });
    expect(out).not.toMatch(/repair/);
  });

  it('lists surviving violations as waived', () => {
    const out = composeRunSummary({
      spec, modelInfo, attempts: 1, isValid: true,
      violations: [{ kind: 'bbox', message: 'width is 2mm over', severity: 'warning' } as never],
    });
    expect(out).toContain('width is 2mm over');
    expect(out).toContain('waived');
  });

  it('reports a failed run without claiming a model was produced', () => {
    const out = composeRunSummary({ spec, modelInfo: null, violations: [], attempts: 3, isValid: false });
    expect(out).toMatch(/did not compile|could not be produced/i);
    expect(out).not.toContain('62 x 40 x 18 mm');
  });

  it('is never empty, even with nothing to report', () => {
    expect(composeRunSummary({ spec: null, modelInfo: null, violations: [], attempts: 0, isValid: false }).trim()).not.toBe('');
  });

  it('names the chosen research approach when one was picked', () => {
    const out = composeRunSummary({
      spec, modelInfo, violations: [], attempts: 1, isValid: true,
      approach: { partClass: 'bracket', chosenAt: 1, approach: { id: 'a1', name: 'Two-plate gusseted bracket' } } as never,
    });
    expect(out).toContain('Two-plate gusseted bracket');
  });
});
