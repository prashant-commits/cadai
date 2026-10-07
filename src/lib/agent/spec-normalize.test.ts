import { describe, it, expect } from 'vitest';
import { normalizeSpec, toSnakeCase } from './spec-normalize';
import { AssemblySpecSchema } from './assembly-spec';

describe('toSnakeCase', () => {
  it('turns free-text names into valid module identifiers', () => {
    expect(toSnakeCase('Wall Mount Backplate')).toBe('wall_mount_backplate');
    expect(toSnakeCase('Cup Receptacle (88mm)')).toBe('cup_receptacle_88mm');
    expect(toSnakeCase('laptopCradle')).toBe('laptop_cradle');
    expect(toSnakeCase('base_plate')).toBe('base_plate');
    expect(toSnakeCase('2nd tier')).toBe('part_2nd_tier');
  });
});

describe('normalizeSpec', () => {
  it('renames components and every reference to them, defaults position, drops unknown modules', () => {
    const spec = AssemblySpecSchema.parse({
      assemblyName: 'holder',
      boundingBox: { width: 100, length: 120, height: 80 },
      components: [
        { name: 'Wall Mount Backplate', description: 'b' },
        { name: 'Cup Receptacle', description: 'c', position: [0, 5, 0] },
      ],
      jointContracts: [{ type: 'cantilever_gusset', clearance: 0, partA: 'Wall Mount Backplate', partB: 'Cup Receptacle' }],
      stressPoints: [{ component: 'Wall Mount Backplate', location: 'screw holes', loadCase: '20 N', risk: 'low', mitigation: 'none' }],
    });
    const n = normalizeSpec(spec);
    expect(n.components?.map((c) => c.name)).toEqual(['wall_mount_backplate', 'cup_receptacle']);
    expect(n.components?.[0].position).toEqual([0, 0, 0]);
    expect(n.components?.[1].position).toEqual([0, 5, 0]);
    expect(n.jointContracts?.[0]).toMatchObject({ partA: 'wall_mount_backplate', partB: 'cup_receptacle' });
    expect(n.stressPoints[0].component).toBe('wall_mount_backplate');
  });

  it('keeps names unique after normalisation', () => {
    const spec = AssemblySpecSchema.parse({
      assemblyName: 'x', boundingBox: { width: 1, length: 1, height: 1 },
      components: [{ name: 'Leg', description: '' }, { name: 'leg', description: '' }, { name: 'LEG', description: '' }],
    });
    expect(normalizeSpec(spec).components?.map((c) => c.name)).toEqual(['leg', 'leg_2', 'leg_3']);
  });
});
