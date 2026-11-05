import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import labels from './intent-labels.json';
import { checkIntent, intentScore, type Fact } from './intent';

const facts = (labels.prompts as Record<string, Fact[]>).hair_dryer_holder;

function spec(components: NonNullable<AssemblySpec['components']>): AssemblySpec {
  return { sheet: '', assemblyName: 'holder', boundingBox: { width: 0, length: 0, height: 0 }, components, guides: [], stressPoints: [], assumptions: [], openQuestions: [] };
}

const backplate = {
  name: 'backplate', description: 'wall plate', localExtents: [120, 6, 160], position: [0, 0, 0],
  holes: [
    { d: 4.5, axis: 'y' as const, at: [60, 0, 20] },
    { d: 4.5, axis: 'y' as const, at: [60, 0, 140] },
  ],
};

describe('checkIntent on the hair dryer holder', () => {
  it('passes an upright plate with a vertical 90 mm cup ring in front of it', () => {
    const cup = spec([
      backplate,
      { name: 'cup_ring', description: 'ring the dryer drops into', localExtents: [100, 100, 30], position: [10, 6, 100], shape: { kind: 'tube', axis: 'z', innerD: 90 } },
    ]);
    const results = checkIntent(cup, facts);
    expect(results.map((r) => r.verdict)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(intentScore(results).allPass).toBe(true);
  });

  it('fails a horizontal sleeve on the axis fact only', () => {
    const sleeve = spec([
      backplate,
      { name: 'cup_ring', description: 'sleeve', localExtents: [100, 60, 100], position: [10, 6, 30], shape: { kind: 'tube', axis: 'y', innerD: 90 } },
    ]);
    const results = checkIntent(sleeve, facts);
    expect(results.find((r) => r.says.includes('axis is vertical'))?.verdict).toBe('fail');
    expect(results.filter((r) => r.verdict === 'fail')).toHaveLength(1);
  });

  it('fails a plate laid flat on the floor', () => {
    const flat = spec([
      { ...backplate, localExtents: [120, 160, 6], holes: [{ d: 4.5, axis: 'z' as const, at: [60, 20, 0] }, { d: 4.5, axis: 'z' as const, at: [60, 140, 0] }] },
      { name: 'cup_ring', description: 'ring', localExtents: [100, 100, 30], position: [10, 30, 6], shape: { kind: 'tube', axis: 'z', innerD: 90 } },
    ]);
    const results = checkIntent(flat, facts);
    expect(results[0].verdict).toBe('fail');
  });

  it('fails a fact whose part is missing, and never passes an unimplemented check', () => {
    const results = checkIntent(spec([backplate]), facts);
    expect(results.find((r) => r.says.includes('inner diameter'))?.verdict).toBe('fail');
    const unchecked = checkIntent(spec([backplate]), [{ says: 'x', check: { type: 'atTallEnd' } }]);
    expect(unchecked[0].verdict).toBe('unchecked');
  });
});
