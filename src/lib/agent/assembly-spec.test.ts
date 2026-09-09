import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AssemblySpecSchema } from './assembly-spec';

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
