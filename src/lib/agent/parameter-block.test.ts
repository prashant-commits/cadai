import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from './assembly-spec';
import { resolveSpec } from './spec-expr';
import { parameterBlock } from './parameter-block';
import { blockoutScad } from '../spec-sheet/blockout-scad';
import { composeAssembly } from '../design/compose-assembly';
import { validateOpenScadCode } from './code-validator';

const raw = {
  sheet: '', assemblyName: 'shelf', boundingBox: { width: 80, length: 40, height: 46 },
  guides: [], stressPoints: [], assumptions: [], openQuestions: [],
  parameters: [
    { name: 'w', value: 80, min: 40, max: 160, step: 1, unit: 'mm', description: 'shelf width' },
    { name: 'base_t', value: 6, min: 3, max: 12, unit: 'mm', description: 'base thickness' },
  ],
  derived: [{ name: 'half_w', expr: 'w / 2' }],
  components: [
    { name: 'base', description: 'plate', localExtents: ['w', 40, 'base_t'], position: [0, 0, 0], shape: { kind: 'box' } },
    { name: 'post', description: 'post', localExtents: [6, 6, 40], position: ['half_w - 3', 17, 'base_t'], shape: { kind: 'box' } },
  ],
};
const spec = (): AssemblySpec => resolveSpec(raw as unknown as AssemblySpec).spec;

describe('parameterBlock', () => {
  it('writes parameters with Customizer ranges, then derived values, in order', () => {
    const block = parameterBlock(spec());
    const lines = block.trim().split('\n');
    expect(lines[0]).toMatch(/^w = 80; \/\/ \[40:1:160\] shelf width$/);
    expect(lines[1]).toMatch(/^base_t = 6; \/\/ \[3:12\] base thickness$/);
    expect(lines[2]).toBe('half_w = w / 2;');
  });

  it('is empty for a spec without parameters', () => {
    expect(parameterBlock({ ...spec(), parameters: undefined, derived: undefined })).toBe('');
  });
});

describe('parametric blockout and placement', () => {
  it('uses expressions in module bodies and in placement', () => {
    const s = spec();
    const code = blockoutScad(s).code;
    expect(code.startsWith('w = 80;')).toBe(true);
    expect(code).toContain('cube([w, 40, base_t])');
    const composed = composeAssembly(code, s).code;
    expect(composed).toMatch(/post_pos_x = half_w - 3;/);
    expect(composed).toMatch(/post_pos_z = base_t;/);
  });

  it('follows a slider: changing w grows the base and moves the post', async () => {
    const s = spec();
    const composed = composeAssembly(blockoutScad(s).code, s).code;
    const at80 = await validateOpenScadCode(composed);
    const at120 = await validateOpenScadCode(composed.replace(/^w = 80;/m, 'w = 120;'));
    expect(at80.valid && at120.valid).toBe(true);
    const size = (r: typeof at80) => r.summary!.boundingBox!.size;
    expect(size(at120)[0] - size(at80)[0]).toBeCloseTo(40, 1);
  }, 120_000);

  it('leaves a literal-only spec byte-identical', () => {
    const literal = resolveSpec({ ...raw, parameters: undefined, derived: undefined,
      components: [{ name: 'base', description: 'plate', localExtents: [80, 40, 6], position: [0, 0, 0], shape: { kind: 'box' } }] } as unknown as AssemblySpec).spec;
    const code = blockoutScad(literal).code;
    expect(code.startsWith('$fn = 48;')).toBe(true);
    expect(code).toContain('cube([80, 40, 6])');
  });
});
