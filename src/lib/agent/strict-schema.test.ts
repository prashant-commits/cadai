import { describe, it, expect } from 'vitest';
import { toStrictJsonSchema, nullsToUndefined } from './strict-schema';

describe('toStrictJsonSchema', () => {
  it('optional -> nullable anyOf, required lists all keys, defaults stripped, nested objects/arrays handled, input not mutated', () => {
    const input = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number', default: 0 },
        c: { 
          type: 'object',
          required: ['d'],
          properties: {
            d: { type: 'boolean' },
            e: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      required: ['a']
    };

    const strict = toStrictJsonSchema(input);
    expect(strict).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['a', 'b', 'c'],
      properties: {
        a: { type: 'string' },
        b: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        c: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['d', 'e'],
              properties: {
                d: { type: 'boolean' },
                e: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] }
              }
            },
            { type: 'null' }
          ]
        }
      }
    });
    
    // input not mutated
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((input as any).properties.b.default).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((input as any).additionalProperties).toBeUndefined();
  });
});

describe('nullsToUndefined', () => {
  it('deep converts null to undefined', () => {
    const input = {
      a: null,
      b: [1, null, { c: null }],
      d: 'string'
    };
    expect(nullsToUndefined(input)).toEqual({
      a: undefined,
      b: [1, undefined, { c: undefined }],
      d: 'string'
    });
  });
});

describe('toStrictJsonSchema keeps a property literally named `default`', () => {
  it('removes the default keyword but not a property called default', () => {
    const out = toStrictJsonSchema({
      type: 'object',
      properties: {
        default: { type: 'string', default: 'x' },
        other: { type: 'number', default: 3 },
      },
      required: ['default', 'other'],
    }) as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(Object.keys(out.properties)).toEqual(['default', 'other']);
    expect(out.properties.default).toEqual({ type: 'string' });
    expect(out.properties.other).toEqual({ type: 'number' });
    expect(out.required).toEqual(['default', 'other']);
  });
});
