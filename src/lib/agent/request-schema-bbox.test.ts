import { describe, it, expect } from 'vitest';
import { assemblySpecRequestSchema, variantSpecRequestSchema } from './assembly-spec';
import { claudeVariantSpecSchema } from './llm-schemas';
import { withComputedBoundingBox } from './spec-coherence';

type JsonSchema = { properties?: Record<string, unknown>; required?: string[] };

describe('boundingBox is computed by code, never requested from the model', () => {
  const schemas: [string, () => unknown][] = [
    ['variantSpecRequestSchema', () => variantSpecRequestSchema()],
    ['assemblySpecRequestSchema', () => assemblySpecRequestSchema()],
    ['claudeVariantSpecSchema', () => claudeVariantSpecSchema()],
  ];
  for (const [name, build] of schemas) {
    it(`${name} has no boundingBox property and does not require one`, () => {
      const s = build() as JsonSchema;
      expect(s.properties?.boundingBox).toBeUndefined();
      expect(s.required ?? []).not.toContain('boundingBox');
    });
  }
});

const caddy = () => ({
  assemblyName: 'pen_caddy',
  components: [
    { name: 'base', description: 'b', localExtents: [60, 40, 4], position: [0, 0, 0], shape: { kind: 'box' } },
    { name: 'panel', description: 'p', localExtents: [60, 6, 20], position: [0, 34, 4], shape: { kind: 'box' } },
    { name: 'cup', description: 'c', localExtents: [16, 16, 30], position: [6, 6, 4], shape: { kind: 'tube', axis: 'z', innerD: 12 } },
  ],
});

describe('withComputedBoundingBox', () => {
  it('sets width/length/height to the x/y/z span of the placed components', () => {
    expect(withComputedBoundingBox(caddy()).boundingBox).toEqual({ width: 60, length: 40, height: 34 });
  });

  it('overrides a boundingBox the model wrote, including one with width and length swapped', () => {
    const swapped = { ...caddy(), boundingBox: { width: 40, length: 60, height: 34 } };
    expect(withComputedBoundingBox(swapped).boundingBox).toEqual({ width: 60, length: 40, height: 34 });
  });

  it('accounts for rotation about each component origin', () => {
    const rotated = {
      assemblyName: 'r',
      components: [{ name: 'bar', description: 'bar', localExtents: [50, 10, 5], position: [10, 0, 0], rotation: [0, 0, 90], shape: { kind: 'box' } }],
    };
    expect(withComputedBoundingBox(rotated).boundingBox).toEqual({ width: 10, length: 50, height: 5 });
  });

  it('returns the input unchanged when no component declares localExtents', () => {
    const raw = { assemblyName: 'x', components: [{ name: 'a', description: 'a' }] };
    expect(withComputedBoundingBox(raw)).toEqual(raw);
  });

  it('does not mutate its input', () => {
    const raw = caddy();
    withComputedBoundingBox(raw);
    expect((raw as Record<string, unknown>).boundingBox).toBeUndefined();
  });
});
