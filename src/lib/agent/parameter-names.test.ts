import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from './assembly-spec';
import { resolveSpec } from './spec-expr';
import { parameterBlock } from './parameter-block';
import { blockoutScad } from '../spec-sheet/blockout-scad';
import { composeAssembly } from '../design/compose-assembly';
import { validateOpenScadCode } from './code-validator';

const base = { sheet: '', assemblyName: 'a', boundingBox: { width: 40, length: 30, height: 15 }, guides: [], stressPoints: [], assumptions: [], openQuestions: [] };

describe('Task 2 follow-up (review M1, M2, L1)', () => {
  it('a parameter named like a generated placement variable still places the part', async () => {
    const spec = resolveSpec({ ...base,
      parameters: [{ name: 'post_pos_z', value: 5, min: 0, max: 10, unit: 'mm', description: 'post height' }],
      components: [
        { name: 'base', description: 'b', localExtents: [40, 30, 5], position: [0, 0, 0], shape: { kind: 'box' } },
        { name: 'post', description: 'p', localExtents: [4, 4, 10], position: [18, 13, 'post_pos_z'], shape: { kind: 'box' } },
      ] } as unknown as AssemblySpec).spec;
    const code = composeAssembly(blockoutScad(spec).code, spec).code;
    expect(code).not.toMatch(/post_pos_z = post_pos_z;/);
    const r = await validateOpenScadCode(code);
    expect(r.valid).toBe(true);
    expect(r.summary!.boundingBox!.size[2]).toBeCloseTo(15, 1);
  }, 120_000);

  it('a newline in a parameter description stays inside the comment', () => {
    const spec = resolveSpec({ ...base,
      parameters: [{ name: 'w', value: 40, min: 20, max: 80, unit: 'mm', description: 'width\nof the plate' }], components: [] } as unknown as AssemblySpec).spec;
    const block = parameterBlock(spec);
    expect(block.trim().split('\n')).toHaveLength(1);
    expect(block).toMatch(/^w = 40; \/\/ \[20:80\] width of the plate\n$/);
  });

  it('rejects OpenSCAD keywords and built-in names as parameter names', () => {
    for (const name of ['for', 'let', 'each', 'if', 'module', 'function', 'true', 'undef', 'cube', 'translate']) {
      const { errors } = resolveSpec({ ...base, parameters: [{ name, value: 1, min: 0, max: 2, unit: 'mm', description: 'x' }], components: [] } as unknown as AssemblySpec);
      expect(errors.join(' '), name).toMatch(new RegExp(name));
    }
  });
});

describe('Task 2 follow-up, round 2', () => {
  it('keeps the derivation comment when a placement expression is inlined', () => {
    const spec = resolveSpec({ ...base,
      parameters: [{ name: 'lid_pos_z', value: 10, min: 0, max: 20, unit: 'mm', description: 'lid height' }],
      components: [
        { name: 'body', description: 'b', localExtents: [40, 30, 10], position: [0, 0, 0], shape: { kind: 'box' } },
        { name: 'lid', description: 'l', localExtents: [40, 30, 2], position: [0, 0, 'lid_pos_z'], positionNote: 'z = top of body', shape: { kind: 'box' } },
      ] } as unknown as AssemblySpec).spec;
    const code = composeAssembly(blockoutScad(spec).code, spec).code;
    expect(code).toContain('z = top of body');
  });

  it('accepts floor, offset and round as names (OpenSCAD allows them as variables)', () => {
    for (const name of ['floor', 'offset', 'round']) {
      const { errors } = resolveSpec({ ...base, parameters: [{ name, value: 1, min: 0, max: 2, unit: 'mm', description: 'x' }], components: [] } as unknown as AssemblySpec);
      expect(errors, name).toEqual([]);
    }
  });
});

