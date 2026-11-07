import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { normalizeSpec } from '@/lib/agent/spec-normalize';
import { emitBrepScript } from './emit-script';
import { specNames } from './py-names';
import { geoPython, runScriptForTest } from './test-run';

const run = existsSync(geoPython()) ? it : it.skip;

const base = { sheet: '', assemblyName: 'dock', assumptions: [], openQuestions: [], guides: [], stressPoints: [] };
const comp = (name: string, extents: number[], position: number[]) =>
  ({ name, description: '', localExtents: extents, position, shape: { kind: 'box' as const } });

describe('DL1 designLanguage emitter parameters', () => {
  it('emits edge_r and minor_r when designLanguage specifies them', () => {
    const s: AssemblySpec = {
      ...base,
      designLanguage: {
        name: 'soft monolith',
        principles: ['one continuous body', 'soft 6mm radius'],
        edgeRadius: 6,
        minorRadius: 1.5,
      },
      boundingBox: { width: 100, length: 100, height: 50 },
      components: [comp('base', [100, 100, 20], [0, 0, 0])],
    };
    const { names, parameterLines } = specNames(normalizeSpec(s), String);
    expect(names.map.get('edge_r')).toBe('edge_r');
    expect(names.map.get('minor_r')).toBe('minor_r');
    expect(parameterLines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^edge_r = 6\s+# \[\S+\] main edge radius$/),
        expect.stringMatching(/^minor_r = 1\.5\s+# \[\S+\] minor edge radius$/),
      ])
    );
  });

  it('does not overwrite existing parameters named edge_r or minor_r', () => {
    const s: AssemblySpec = {
      ...base,
      parameters: [
        { name: 'edge_r', value: 4, min: 1, max: 10, unit: 'mm', description: 'custom radius' },
      ],
      designLanguage: {
        name: 'custom',
        principles: ['custom'],
        edgeRadius: 8,
      },
      boundingBox: { width: 100, length: 100, height: 50 },
      components: [comp('base', [100, 100, 20], [0, 0, 0])],
    };
    const { parameterLines } = specNames(normalizeSpec(s), String);
    const edgeRLines = parameterLines.filter((l) => l.startsWith('edge_r ='));
    expect(edgeRLines).toHaveLength(1);
    expect(edgeRLines[0]).toContain('custom radius');
  });

  it('handles small radius, off-grid steps, and thickness-aware max (L3)', () => {
    const sSmall: AssemblySpec = {
      ...base,
      designLanguage: {
        name: 'tiny',
        principles: [],
        edgeRadius: 0.05,
        minorRadius: 1.51,
      },
      boundingBox: { width: 100, length: 100, height: 10 },
      components: [comp('base', [100, 100, 10], [0, 0, 0])],
    };
    const { parameterLines } = specNames(normalizeSpec(sSmall), String);
    const edgeLine = parameterLines.find((l) => l.startsWith('edge_r ='))!;
    const minorLine = parameterLines.find((l) => l.startsWith('minor_r ='))!;
    // edge_r=0.05: min must be <= 0.05
    expect(edgeLine).toMatch(/^edge_r = 0\.05\s+# \[0\.05:0\.01:2\]/);
    // minor_r=1.51: step must be 0.01 to stay on grid, max capped at thickness half (5)
    expect(minorLine).toMatch(/^minor_r = 1\.51\s+# \[0\.5:0\.01:5\]/);

    // Derived edge_r avoids collision
    const sDerived: AssemblySpec = {
      ...base,
      derived: [{ name: 'edge_r', expr: '5' }],
      designLanguage: { name: 'dl', principles: [], edgeRadius: 6 },
      boundingBox: { width: 100, length: 100, height: 50 },
      components: [],
    };
    const resDerived = specNames(normalizeSpec(sDerived), String);
    expect(resDerived.parameterLines.filter((l) => l.includes('main edge radius'))).toHaveLength(0);
  });
});

describe('DL1 safe rounding helpers in execution', () => {
  run('_round succeeds on a box and preserves extents', async () => {
    const s = normalizeSpec({
      ...base,
      designLanguage: {
        name: 'soft monolith',
        principles: ['soft 2mm radius'],
        edgeRadius: 2,
      },
      boundingBox: { width: 40, length: 30, height: 20 },
      components: [comp('body', [40, 30, 20], [0, 0, 0])],
    });
    const bodyCode = `
b = Box(40, 30, 20, align=(Align.MIN, Align.MIN, Align.MIN))
return _round(b, edge_r, "outer")
`;
    const { script } = emitBrepScript(s, { body: bodyCode });
    const r = await runScriptForTest(script);
    expect(r.ok, r.error).toBe(true);
    const p = r.parts.find((x) => x.label === 'body')!;
    expect(p.valid).toBe(true);
    expect(p.max[0] - p.min[0]).toBeCloseTo(40, 1);
    expect(p.max[1] - p.min[1]).toBeCloseTo(30, 1);
    expect(p.max[2] - p.min[2]).toBeCloseTo(20, 1);
  }, 90_000);

  run('_round on an impossible radius degrades gracefully, returns unrounded shape with a note, and keeps extents', async () => {
    const s = normalizeSpec({
      ...base,
      designLanguage: {
        name: 'soft monolith',
        principles: ['soft edges'],
        edgeRadius: 25, // Impossible for a 20mm high box (half is 10)
      },
      boundingBox: { width: 40, length: 30, height: 20 },
      components: [comp('body', [40, 30, 20], [0, 0, 0])],
    });
    const bodyCode = `
b = Box(40, 30, 20, align=(Align.MIN, Align.MIN, Align.MIN))
return _round(b, edge_r, "outer")
`;
    const { script } = emitBrepScript(s, { body: bodyCode });
    const r = await runScriptForTest(script);
    expect(r.ok, r.error).toBe(true);
    const p = r.parts.find((x) => x.label === 'body')!;
    expect(p.valid).toBe(true);
    // Preserves extents of the unrounded box
    expect(p.max[0] - p.min[0]).toBeCloseTo(40, 1);
    expect(p.max[1] - p.min[1]).toBeCloseTo(30, 1);
    expect(p.max[2] - p.min[2]).toBeCloseTo(20, 1);
    // Note was recorded
    expect(r.notes?.some((n) => n.includes('_round skipped') || n.includes('_round failed'))).toBe(true);
  }, 90_000);

  run('_bevel succeeds on a box and degrades gracefully on impossible distance', async () => {
    const s = normalizeSpec({
      ...base,
      boundingBox: { width: 30, length: 20, height: 10 },
      components: [comp('body', [30, 20, 10], [0, 0, 0])],
    });
    const bodySuccess = `
b = Box(30, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))
return _bevel(b, 1, "top")
`;
    const rSuccess = await runScriptForTest(emitBrepScript(s, { body: bodySuccess }).script);
    expect(rSuccess.ok, rSuccess.error).toBe(true);

    const bodyFail = `
b = Box(30, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))
return _bevel(b, 15, "top")
`;
    const rFail = await runScriptForTest(emitBrepScript(s, { body: bodyFail }).script);
    expect(rFail.ok, rFail.error).toBe(true);
    expect(rFail.notes?.some((n) => n.includes('_bevel skipped') || n.includes('_bevel failed'))).toBe(true);
  }, 90_000);

  run('direct fillet and chamfer in body work', async () => {
    const s = normalizeSpec({
      ...base,
      boundingBox: { width: 30, length: 20, height: 10 },
      components: [comp('body', [30, 20, 10], [0, 0, 0])],
    });
    const bodyCode = `
b = Box(30, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))
f = fillet(b.edges().filter_by(Axis.Z), 2)
c = chamfer(f.faces().sort_by(Axis.Z)[-1].edges(), 0.5)
return c
`;
    const r = await runScriptForTest(emitBrepScript(s, { body: bodyCode }).script);
    expect(r.ok, r.error).toBe(true);
    const p = r.parts.find((x) => x.label === 'body')!;
    expect(p.valid).toBe(true);
    expect(p.max[0] - p.min[0]).toBeCloseTo(30, 1);
    expect(p.max[1] - p.min[1]).toBeCloseTo(20, 1);
    expect(p.max[2] - p.min[2]).toBeCloseTo(10, 1);
  }, 90_000);
});
