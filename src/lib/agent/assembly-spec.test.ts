import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AssemblySpecSchema, assemblySpecRequestSchema } from './assembly-spec';

const minimal = {
  assemblyName: 'bracket',
  boundingBox: { width: 40, length: 30, height: 25 },
  components: [{ name: 'bracket', description: 'an L bracket' }],
};

describe('AssemblySpecSchema', () => {
  it('defaults the new lists to empty so consumers can iterate without guards', () => {
    const spec = AssemblySpecSchema.parse(minimal);
    expect(spec.edgeTreatments).toEqual([]);
    expect(spec.stressPoints).toEqual([]);
    expect(spec.components?.[0].bedFace).toBeUndefined();
    expect(spec.components?.[0].matingFaces).toBeUndefined();
  });

  it('carries bed faces, mating faces, categorised edge treatments and graded stress points', () => {
    const spec = AssemblySpecSchema.parse({
      ...minimal,
      components: [
        {
          name: 'bracket',
          description: 'an L bracket',
          bedFace: '-Z',
          matingFaces: ['-X (wall mount)'],
          position: [0, 0, 0],
        },
      ],
      edgeTreatments: [
        { component: 'bracket', location: 'inside corner where wall meets floor', category: 'stress_relief', kind: 'fillet', sizeMm: 1.2 },
        { location: 'bed perimeter', category: 'printability', kind: 'chamfer', sizeMm: 0.4, rationale: 'elephant foot' },
      ],
      stressPoints: [
        { component: 'bracket', location: 'wall/floor junction', loadCase: '50 N bending the wall outward', risk: 'high', mitigation: 'R1.2 fillet + 1.8 mm gusset every 25 mm' },
      ],
    });

    expect(spec.components?.[0].bedFace).toBe('-Z');
    expect(spec.components?.[0].matingFaces).toEqual(['-X (wall mount)']);
    expect(spec.edgeTreatments).toHaveLength(2);
    expect(spec.edgeTreatments[0].category).toBe('stress_relief');
    expect(spec.stressPoints[0].risk).toBe('high');
  });

  it('rejects a bed face, category or risk outside the vocabulary the prompts teach', () => {
    expect(
      AssemblySpecSchema.safeParse({ ...minimal, components: [{ name: 'b', description: 'b', bedFace: 'bottom' }] }).success
    ).toBe(false);
    expect(
      AssemblySpecSchema.safeParse({
        ...minimal,
        edgeTreatments: [{ location: 'x', category: 'cosmetic', kind: 'fillet', sizeMm: 1 }],
      }).success
    ).toBe(false);
    expect(
      AssemblySpecSchema.safeParse({
        ...minimal,
        stressPoints: [{ location: 'x', loadCase: 'y', risk: 'critical', mitigation: 'z' }],
      }).success
    ).toBe(false);
  });
});

describe('Gemini response_schema compatibility', () => {
  // A z.tuple() here compiles to `prefixItems`, which Gemini's response_schema
  // does not know: the API 400s, withStructuredOutput throws on every attempt,
  // and the Architect silently yields a null spec that renders as an empty
  // review gate. Assert the whole schema stays inside the subset Gemini parses.
  it('emits no JSON Schema keyword Gemini rejects', () => {
    const json = JSON.stringify(z.toJSONSchema(AssemblySpecSchema));
    for (const keyword of ['prefixItems', 'oneOf', 'not', 'additionalItems', '$ref']) {
      expect(json, `schema must not use "${keyword}"`).not.toContain(`"${keyword}"`);
    }
  });

  it('accepts position and rotation as 3-number vectors and rejects other lengths', () => {
    const spec = AssemblySpecSchema.parse({
      ...minimal,
      components: [
        { name: 'bracket', description: 'an L bracket', position: [10, 0, 5], rotation: [0, 0, 90] },
      ],
    });
    expect(spec.components?.[0].position).toEqual([10, 0, 5]);
    expect(spec.components?.[0].rotation).toEqual([0, 0, 90]);

    expect(() =>
      AssemblySpecSchema.parse({
        ...minimal,
        components: [{ name: 'bracket', description: 'an L bracket', position: [10, 0] }],
      })
    ).toThrow();
  });
});

describe('assemblySpecRequestSchema', () => {
  // An unbounded {"type":"number"} lets a constrained decoder emit digits
  // forever: a float artefact like 6.000000000000001 turns into a zero-padding
  // loop that exhausts the output budget and truncates the JSON mid-value.
  // Measured on deepseek-v4-flash over 10 prompts: 6/10 valid unbounded,
  // 8/10 bounded, with average latency down from 114s to 78s.
  it('constrains every number so the decoder cannot run away', () => {
    const json = assemblySpecRequestSchema();
    const numbers: Record<string, unknown>[] = [];
    (function walk(n: unknown) {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        if (o.type === 'number') numbers.push(o);
        Object.values(o).forEach(walk);
      }
    })(json);

    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) {
      expect(n.multipleOf).toBe(0.01);
      expect(n.minimum).toBe(-100000);
      expect(n.maximum).toBe(100000);
    }
  });

  it('stays signed so component positions can be negative', () => {
    const json = assemblySpecRequestSchema();
    expect(JSON.stringify(json)).not.toContain('"minimum":0');
  });

  it('drops $schema, which providers reject as an unknown field', () => {
    expect(assemblySpecRequestSchema().$schema).toBeUndefined();
  });

  // The bound belongs to the request only. Binary floating point makes
  // 0.4 % 0.01 come out as 0.0099999..., so validating multipleOf would reject
  // legitimate chamfer sizes the model was right to emit.
  it('does not narrow what the zod schema will accept', () => {
    const spec = AssemblySpecSchema.parse({
      ...minimal,
      edgeTreatments: [{ location: 'all outer edges', category: 'printability', kind: 'chamfer', sizeMm: 0.4 }],
      components: [{ name: 'bracket', description: 'an L bracket', position: [-12.5, 0, 3.333] }],
    });
    expect(spec.edgeTreatments[0].sizeMm).toBe(0.4);
    expect(spec.components?.[0].position).toEqual([-12.5, 0, 3.333]);
  });
});
