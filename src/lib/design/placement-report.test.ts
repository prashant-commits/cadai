import { describe, it, expect } from 'vitest';
import { buildPlacementComponents, findFloating, placementSummary, PlacementComponent } from './placement-report';
import type { ModuleFrame } from '../engine/module-frames';
import type { AssemblySpec } from '../agent/assembly-spec';

const frame = (name: string, min: [number, number, number], max: [number, number, number]): ModuleFrame => ({
  name, valid: true, min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
});

const spec = (components: AssemblySpec['components']): AssemblySpec => ({
  assemblyName: 't', boundingBox: { width: 1, length: 1, height: 1 }, components,
  stressPoints: [], assumptions: [], openQuestions: [],
});

describe('buildPlacementComponents', () => {
  it('places a measured module at its spec position with an origin correction', () => {
    const s = spec([{ name: 'arm', description: 'a', position: [0, 0, 6] }]);
    const [c] = buildPlacementComponents(s, [frame('arm', [-5, -5, 0], [5, 5, 40])], true);
    expect(c.measured).toBe(true);
    expect(c.correction).toEqual([5, 5, 0]);
    expect(c.placedMin).toEqual([0, 0, 6]);
    expect(c.placedMax).toEqual([10, 10, 46]);
  });

  it('leaves correction at zero when asked not to correct', () => {
    const s = spec([{ name: 'arm', description: 'a', position: [0, 0, 6] }]);
    const [c] = buildPlacementComponents(s, [frame('arm', [-5, -5, 0], [5, 5, 40])], false);
    expect(c.correction).toEqual([0, 0, 0]);
    expect(c.placedMin).toEqual([-5, -5, 6]);
  });

  it('marks components without a usable frame as unmeasured', () => {
    const s = spec([{ name: 'ghost', description: 'g' }]);
    const [c] = buildPlacementComponents(s, [], true);
    expect(c.measured).toBe(false);
    expect(c.position).toEqual([0, 0, 0]);
  });
});

describe('findFloating', () => {
  const part = (name: string, min: [number, number, number], max: [number, number, number]): PlacementComponent => ({
    name, measured: true, localMin: [0, 0, 0], localMax: [0, 0, 0], size: [0, 0, 0], correction: [0, 0, 0],
    position: [0, 0, 0], rotation: [0, 0, 0], placedMin: min, placedMax: max,
  });

  it('accepts a part on the floor and a part resting on it', () => {
    const base = part('base', [0, 0, 0], [40, 40, 10]);
    const peg = part('peg', [10, 10, 10], [20, 20, 20]);
    expect(findFloating([base, peg])).toEqual([]);
  });

  it('flags a part hovering above another with the gap', () => {
    const base = part('base', [0, 0, 0], [40, 40, 10]);
    const peg = part('peg', [10, 10, 15], [20, 20, 25]);
    expect(findFloating([base, peg])).toEqual([{ name: 'peg', gapMm: 5 }]);
  });

  it('flags a part with nothing beneath it by its height above the floor', () => {
    const base = part('base', [0, 0, 0], [40, 40, 10]);
    const bar = part('bar', [100, 100, 150], [120, 120, 160]);
    expect(findFloating([base, bar])).toEqual([{ name: 'bar', gapMm: 150 }]);
  });

  it('propagates support through a stack', () => {
    const a = part('a', [0, 0, 0], [10, 10, 10]);
    const b = part('b', [0, 0, 10], [10, 10, 20]);
    const c = part('c', [0, 0, 20], [10, 10, 30]);
    expect(findFloating([c, b, a])).toEqual([]);
  });

  it('ignores unmeasured components', () => {
    const ghost = { ...part('ghost', [0, 0, 99], [1, 1, 100]), measured: false };
    expect(findFloating([ghost])).toEqual([]);
  });
});

describe('placementSummary', () => {
  it('is a single markdown sentence with no JSON', () => {
    const s = placementSummary(
      { composed: false, removedStatements: 0, components: [] },
      -150
    );
    expect(s).toMatch(/lowest point is at z = -150 mm/);
    expect(s).not.toContain('{');
    expect(s.split('\n')).toHaveLength(1);
  });
});
