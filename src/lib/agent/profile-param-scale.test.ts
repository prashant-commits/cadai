import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from './assembly-spec';
import { normalizeSpec } from './spec-normalize';
import { resolveSpec } from './spec-expr';
import { auditSpecParameters } from './spec-param-lint';

// Front-half verification 2026-11-06: 304 saved profile components have
// parametric in-plane extents but a literal outline; the profile pass let the
// literal outline win and silently disconnected the parameters (127 of them).

const param = (name: string, value: number) => ({ name, value, min: 0, max: 1000, unit: 'mm', description: '' });
const bracket = (arm: number, plate: number) => ({
  sheet: '', assemblyName: 'shelf_bracket', assumptions: [], openQuestions: [],
  parameters: [param('width', 20), param('arm_len', arm), param('plate_len', plate)],
  components: [{
    name: 'l_bracket', description: '', localExtents: ['width', 'arm_len', 'plate_len'], position: [0, 0, 0],
    // L outline in the yz plane, drawn at 150 x 150 in plain numbers.
    shape: { kind: 'profile', plane: 'yz', points: [[0, 0], [150, 0], [150, 5], [5, 5], [5, 150], [0, 150]] },
  }],
}) as unknown as AssemblySpec;

describe('literal profile outline with parametric extents', () => {
  it('keeps the parameters driving the size: the outline is scaled to the resolved extents', () => {
    const n = normalizeSpec(bracket(200, 100));
    const c = n.components![0];
    expect(c.localExtents).toEqual([20, 200, 100]);
    const us = c.shape!.points!.map((p) => p[0]); const vs = c.shape!.points!.map((p) => p[1]);
    expect(Math.max(...us)).toBeCloseTo(200, 6);
    expect(Math.max(...vs)).toBeCloseTo(100, 6);
    expect(Math.min(...us)).toBe(0);
  });

  it('bumping a parameter moves the geometry, and the lint does not call it dead', () => {
    const a = normalizeSpec(bracket(150, 150)).components![0];
    const b = normalizeSpec(bracket(180, 150)).components![0];
    expect(b.localExtents![1]).toBe(180);
    expect(JSON.stringify(a.shape!.points)).not.toBe(JSON.stringify(b.shape!.points));
    expect(auditSpecParameters(normalizeSpec(bracket(150, 150))).map((v) => v.field)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = normalizeSpec(bracket(200, 100));
    expect(normalizeSpec(once).components![0].shape!.points).toEqual(once.components![0].shape!.points);
  });

  it('Item 1: scales expressed inner outline coordinates and rewrites expressions to match numbers', () => {
    // Grok 1 failure scenario: xz profile 50x20, localExtents ['w', 'd', 'h'] with w=40 (scale 0.8 on x).
    // Inner outline with 'hx' = 25 on x axis.
    const spec = {
      sheet: '', assemblyName: 'slot_test', assumptions: [], openQuestions: [],
      parameters: [param('w', 40), param('d', 10), param('h', 20), param('hx', 25)],
      components: [{
        name: 'plate', description: '', localExtents: ['w', 'd', 'h'], position: [0, 0, 0],
        shape: {
          kind: 'profile', plane: 'xz',
          points: [[0, 0], [50, 0], [50, 20], [0, 20]],
          holes: [[['hx', 5], [35, 5], [35, 15], [25, 15]]],
        },
      }],
    } as unknown as AssemblySpec;

    const n = normalizeSpec(spec);
    const c = n.components![0];
    // Numbers: 25 * 0.8 = 20, 35 * 0.8 = 28
    expect(c.shape!.holes![0][0]).toEqual([20, 5]);
    expect(c.shape!.holes![0][1]).toEqual([28, 5]);
    // Expressions: rewritten to ((term) - min) * k -> (hx) * 0.8
    expect(c.expr?.outlineHoles?.[0][0][0]).toBe('(hx) * 0.8');

    // Re-resolve reproduces normalized numbers (resolve-stable)
    const r = resolveSpec(n);
    expect(r.errors).toEqual([]);
    expect(r.spec.components![0].shape!.holes).toEqual(c.shape!.holes);

    // Second normalize is identical (idempotent)
    const n2 = normalizeSpec(n);
    expect(n2.components![0].shape!.holes).toEqual(c.shape!.holes);
  });

  it('Item 2: scales component holes[].at expressions on a scaled axis', () => {
    // Grok 2 failure scenario: xz profile 40x20, origin at (5, 2), extents [40, 10, 80] (scale 4 on z).
    // Hole at [12, 0, 'hz'] with hz = 12.
    const spec = {
      sheet: '', assemblyName: 'hole_cutter_test', assumptions: [], openQuestions: [],
      parameters: [param('w', 40), param('d', 10), param('h', 80), param('hz', 12)],
      components: [{
        name: 'bracket', description: '', localExtents: ['w', 'd', 'h'], position: [0, 0, 0],
        shape: { kind: 'profile', plane: 'xz', points: [[5, 2], [45, 2], [5, 22]] },
        holes: [{ d: 4, at: [12, 0, 'hz'], axis: 'y' }],
      }],
    } as unknown as AssemblySpec;

    const n = normalizeSpec(spec);
    const c = n.components![0];
    // Outline became [[0, 0], [40, 0], [0, 80]]
    expect(c.shape!.points).toEqual([[0, 0], [40, 0], [0, 80]]);
    // Hole: x shifted (12 - 5 = 7), z scaled ((12 - 2) * 4 = 40)
    expect(c.holes![0].at).toEqual([7, 0, 40]);
    // Hole expr rewritten to ((hz) - 2) * 4
    expect(c.expr?.holes?.[0].at).toEqual([null, null, '((hz) - 2) * 4']);

    // Re-resolve reproduces the hole position
    const r = resolveSpec(n);
    expect(r.errors).toEqual([]);
    expect(r.spec.components![0].holes![0].at).toEqual([7, 0, 40]);

    // Second normalize is identical
    const n2 = normalizeSpec(n);
    expect(n2.components![0].holes![0].at).toEqual([7, 0, 40]);
  });

  it('Item 3: divides by unrounded span for 33.333 and 1.004 cases', () => {
    // 33.333 case (Fable L1): xy profile with span 33.333, target extent w = 200
    const spec33 = {
      sheet: '', assemblyName: 'span33', assumptions: [], openQuestions: [],
      parameters: [param('w', 200), param('h', 50), param('t', 5)],
      components: [{
        name: 'part', description: '', localExtents: ['w', 'h', 't'], position: [0, 0, 0],
        shape: { kind: 'profile', plane: 'xy', points: [[0, 0], [33.333, 0], [33.333, 50], [0, 50]] },
      }],
    } as unknown as AssemblySpec;

    const n33 = normalizeSpec(spec33);
    const maxU33 = Math.max(...n33.components![0].shape!.points!.map((p) => p[0]));
    expect(Math.abs(maxU33 - 200)).toBeLessThanOrEqual(0.005);
    const n33_2 = normalizeSpec(n33);
    const maxU33_2 = Math.max(...n33_2.components![0].shape!.points!.map((p) => p[0]));
    expect(maxU33_2).toBe(maxU33);

    // 1.004 case (Grok 3): xz profile with span 1.004, target extent w = 100
    const spec1004 = {
      sheet: '', assemblyName: 'span1004', assumptions: [], openQuestions: [],
      parameters: [param('w', 100), param('d', 10), param('h', 20)],
      components: [{
        name: 'part', description: '', localExtents: ['w', 'd', 'h'], position: [0, 0, 0],
        shape: { kind: 'profile', plane: 'xz', points: [[0, 0], [1.004, 0], [0, 20]] },
      }],
    } as unknown as AssemblySpec;

    const n1004 = normalizeSpec(spec1004);
    const maxU1004 = Math.max(...n1004.components![0].shape!.points!.map((p) => p[0]));
    expect(Math.abs(maxU1004 - 100)).toBeLessThanOrEqual(0.005);
    const n1004_2 = normalizeSpec(n1004);
    const maxU1004_2 = Math.max(...n1004_2.components![0].shape!.points!.map((p) => p[0]));
    expect(maxU1004_2).toBe(maxU1004);
  });

  it('Item 4: does not scale when target extent <= 0 or non-finite (outline wins)', () => {
    // Extent resolves to 0 (Fable L2): outline wins, size is kept at 100
    const spec0 = {
      sheet: '', assemblyName: 'target_zero', assumptions: [], openQuestions: [],
      parameters: [param('w', 10), param('t', 5), param('h', 50)],
      components: [{
        name: 'part', description: '', localExtents: ['w - 2*t', 'h', 5], position: [0, 0, 0],
        shape: { kind: 'profile', plane: 'xy', points: [[0, 0], [100, 0], [100, 50], [0, 50]] },
      }],
    } as unknown as AssemblySpec;

    const n0 = normalizeSpec(spec0);
    const c0 = n0.components![0];
    expect(c0.localExtents![0]).toBe(100);
    expect(c0.expr?.localExtents?.[0] ?? null).toBeNull();
    expect(c0.shape!.points).toEqual([[0, 0], [100, 0], [100, 50], [0, 50]]);

    // Extent resolves to negative (-40) (Grok 5): outline wins, no negative mirroring
    const specNeg = {
      sheet: '', assemblyName: 'target_neg', assumptions: [], openQuestions: [],
      parameters: [param('w', -40), param('d', 10), param('h', 20)],
      components: [{
        name: 'part', description: '', localExtents: ['w', 'd', 'h'], position: [0, 0, 0],
        shape: { kind: 'profile', plane: 'xz', points: [[0, 0], [50, 0], [0, 20]] },
      }],
    } as unknown as AssemblySpec;

    const nNeg = normalizeSpec(specNeg);
    const cNeg = nNeg.components![0];
    expect(cNeg.localExtents![0]).toBe(50);
    expect(cNeg.expr?.localExtents?.[0] ?? null).toBeNull();
    expect(cNeg.shape!.points).toEqual([[0, 0], [50, 0], [0, 20]]);
  });

  it('Item 5: does not adopt expression extent when outline span on an axis is zero', () => {
    // Grok 4 / Fable L3 scenario: degenerate outline with span 0 on x (points all have x=5)
    const spec = {
      sheet: '', assemblyName: 'degen_span', assumptions: [], openQuestions: [],
      parameters: [param('w', 80), param('d', 10), param('h', 20)],
      components: [{
        name: 'part', description: '', localExtents: ['w', 'd', 'h'], position: [0, 0, 0],
        shape: { kind: 'profile', plane: 'xz', points: [[5, 0], [5, 10], [5, 20]] },
      }],
    } as unknown as AssemblySpec;

    const n = normalizeSpec(spec);
    const c = n.components![0];
    // Does not adopt w=80; finalSize is 0, extent expression is nulled
    expect(c.localExtents![0]).toBe(0);
    expect(c.expr?.localExtents?.[0] ?? null).toBeNull();
  });

  it('Item 6: scales literal axis when outline has expressions on the other axis only', () => {
    // Fable L4 scenario: outline has expression 'h' on y axis, but x axis is purely literal [0..100]
    const spec = {
      sheet: '', assemblyName: 'per_axis_gate', assumptions: [], openQuestions: [],
      parameters: [param('w', 200), param('h', 50), param('t', 5)],
      components: [{
        name: 'part', description: '', localExtents: ['w', 'h', 't'], position: [0, 0, 0],
        shape: {
          kind: 'profile', plane: 'xy',
          points: [[0, 0], [100, 0], [100, 'h'], [0, 'h']],
        },
      }],
    } as unknown as AssemblySpec;

    const n = normalizeSpec(spec);
    const c = n.components![0];
    // x axis (literal outline) scaled to w=200, kept extent expr 'w'
    expect(c.localExtents![0]).toBe(200);
    expect(c.expr?.localExtents?.[0]).toBe('w');
    // y axis (expression outline) outline wins at 50, kept extent expr 'h'
    expect(c.localExtents![1]).toBe(50);
    expect(c.expr?.localExtents?.[1]).toBe('h');

    // Both parameters remain live (lint reports neither dead)
    expect(auditSpecParameters(n).map((v) => v.field)).toEqual([]);
  });

  it('Item 7: lints normalizeSpec(bracket(200, 100)) and tests literal component hole scaling', () => {
    // Opus L3(a): old code flagged arm_len/plate_len on normalizeSpec(bracket(200, 100))
    expect(auditSpecParameters(normalizeSpec(bracket(200, 100))).map((v) => v.field)).toEqual([]);

    // Opus L3(b): component hole scaling with literal coordinates
    const base = bracket(200, 100);
    const bracketWithHole = {
      ...base,
      components: [{
        ...base.components![0],
        holes: [{ d: 4, at: [10, 75, 2.5], axis: 'z' }],
      }],
    } as unknown as AssemblySpec;

    const n = normalizeSpec(bracketWithHole);
    const c = n.components![0];
    // 75 on 150 span scaled to 200: 75 * (200 / 150) = 100
    // 2.5 on 150 span scaled to 100: 2.5 * (100 / 150) = 1.67
    expect(c.holes![0].at).toEqual([10, 100, 1.67]);
  });
});
