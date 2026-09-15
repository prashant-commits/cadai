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
    expect(spec.stressPoints).toEqual([]);
    expect(spec.components?.[0].bedFace).toBeUndefined();
    expect(spec.components?.[0].matingFaces).toBeUndefined();
  });

  it('has no edge-treatment field: generated parts ship with sharp edges', () => {
    const json = assemblySpecRequestSchema() as any;
    expect(json.properties.edgeTreatments).toBeUndefined();
    // A stale client spec that still carries the field is accepted and the field dropped.
    const spec = AssemblySpecSchema.parse({
      ...minimal,
      edgeTreatments: [{ location: 'bed perimeter', category: 'printability', kind: 'chamfer', sizeMm: 0.4 }],
    });
    expect((spec as Record<string, unknown>).edgeTreatments).toBeUndefined();
  });

  it('carries bed faces, mating faces and graded stress points', () => {
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
      stressPoints: [
        { component: 'bracket', location: 'wall/floor junction', loadCase: '50 N bending the wall outward', risk: 'high', mitigation: '1.8 mm gusset every 25 mm' },
      ],
    });

    expect(spec.components?.[0].bedFace).toBe('-Z');
    expect(spec.components?.[0].matingFaces).toEqual(['-X (wall mount)']);
    expect(spec.stressPoints[0].risk).toBe('high');
  });

  it('rejects a bed face or risk outside the vocabulary the prompts teach', () => {
    expect(
      AssemblySpecSchema.safeParse({ ...minimal, components: [{ name: 'b', description: 'b', bedFace: 'bottom' }] }).success
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
      stressPoints: [{ location: 'root', loadCase: '10 N', risk: 'low', mitigation: 'thicken to 2.2 mm' }],
      components: [{ name: 'bracket', description: 'an L bracket', position: [-12.5, 0, 3.333], localExtents: [40.4, 30, 25.01] }],
    });
    expect(spec.components?.[0].localExtents).toEqual([40.4, 30, 25.01]);
    expect(spec.components?.[0].position).toEqual([-12.5, 0, 3.333]);
  });
});

describe('placement and extents fields', () => {
  it('accepts form, localExtents, positionNote and useModules, and tolerates their absence', () => {
    const spec = AssemblySpecSchema.parse({
      ...minimal,
      components: [
        { name: 'base', description: 'b', form: 'box', localExtents: [40, 30, 6], position: [0, 0, 0] },
        { name: 'arm', description: 'a', localExtents: [6, 30, 25], position: [0, 0, 6], positionNote: 'z = top of base (localExtents z = 6)', useModules: ['structural_ribs_gussets'] },
      ],
    });
    expect(spec.components?.[0].form).toBe('box');
    expect(spec.components?.[1].positionNote).toContain('top of base');
    expect(AssemblySpecSchema.safeParse(minimal).success).toBe(true);
  });

  it('marks position and localExtents required in the REQUEST schema only', () => {
    const json = assemblySpecRequestSchema() as any;
    const items = json.properties.components.items;
    expect(items.required).toEqual(expect.arrayContaining(['name', 'description', 'position', 'localExtents']));
    // Validation stays lenient: a component without them still parses.
    expect(AssemblySpecSchema.safeParse(minimal).success).toBe(true);
  });

  it('no longer carries a dimensions object on components', () => {
    const json = assemblySpecRequestSchema() as any;
    expect(json.properties.components.items.properties.dimensions).toBeUndefined();
    expect(json.properties.jointContracts.items.properties.dimensions).toBeDefined();
  });
});
