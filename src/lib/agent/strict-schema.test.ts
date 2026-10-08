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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any; // schema trees are walked by path in these assertions

describe('toAnthropicCompatibleSchema', () => {
  it('removes every unsupported keyword at any depth and keeps the strict invariants', async () => {
    const { toAnthropicCompatibleSchema } = await import('./strict-schema');
    const input = {
      type: 'object',
      additionalProperties: false,
      required: ['list', 'n', 's', 'e', 'maybe'],
      properties: {
        list: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: 0, maximum: 9, exclusiveMinimum: 0, exclusiveMaximum: 10, multipleOf: 0.5 } },
        n: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', minLength: 1, maxLength: 4, pattern: '^a' } } } },
        s: { type: 'array', minItems: 0, maxItems: 2, items: { type: 'string' } },
        e: { type: 'string', enum: ['x', 'y'] },
        maybe: { anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }] },
      },
    };
    const out = toAnthropicCompatibleSchema(input) as Loose;
    const text = JSON.stringify(out);
    for (const k of ['maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern']) {
      expect(text).not.toContain(`"${k}"`);
    }
    expect(out.properties.list).toEqual({ type: 'array', items: { type: 'number' } }); // minItems 3 dropped
    expect(out.properties.n.minItems).toBe(1); // 0 and 1 are allowed
    expect(out.properties.s.minItems).toBe(0);
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.n.items.additionalProperties).toBe(false);
    expect(out.required).toEqual(['list', 'n', 's', 'e', 'maybe']);
    expect(out.properties.e.enum).toEqual(['x', 'y']);
    expect(out.properties.maybe.anyOf).toEqual([{ type: 'number' }, { type: 'null' }]);
    expect(JSON.stringify(input)).toContain('maxItems'); // input not mutated
  });

  it('keeps a property literally named like a keyword', async () => {
    const { toAnthropicCompatibleSchema } = await import('./strict-schema');
    const out = toAnthropicCompatibleSchema({ type: 'object', properties: { pattern: { type: 'string', pattern: 'x' }, maxItems: { type: 'number' } } }) as Loose;
    expect(Object.keys(out.properties)).toEqual(['pattern', 'maxItems']);
    expect(out.properties.pattern).toEqual({ type: 'string' });
  });

  it('removes default keyword and $schema but keeps a property literally named default', async () => {
    const { toAnthropicCompatibleSchema } = await import('./strict-schema');
    const out = toAnthropicCompatibleSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        default: { type: 'string', default: 'val' },
        foo: { type: 'number', default: 42 },
      },
      required: ['default', 'foo'],
    }) as Loose;
    expect(out.$schema).toBeUndefined();
    expect(Object.keys(out.properties)).toEqual(['default', 'foo']);
    expect(out.properties.default).toEqual({ type: 'string' });
    expect(out.properties.foo).toEqual({ type: 'number' });
    expect(out.additionalProperties).toBe(false);
  });
});

