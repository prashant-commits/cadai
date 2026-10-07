import { describe, it, expect } from 'vitest';
import type { ZodType } from 'zod';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { VisualCritiqueSchema, SheetReviewSchema, ArchitectPlanSchema } from './llm-schemas';

type Node = { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };

/** Collects every object node that violates OpenAI strict json_schema (all properties required). */
function violations(node: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(node)) {
    node.forEach((n, i) => violations(n, `${path}[${i}]`, out));
  } else if (node && typeof node === 'object') {
    const n = node as Node;
    if (n.properties) {
      const missing = Object.keys(n.properties).filter((k) => !(n.required ?? []).includes(k));
      if (missing.length) out.push(`${path}: not required: ${missing.join(', ')}`);
    }
    for (const [k, v] of Object.entries(n)) violations(v, `${path}.${k}`, out);
  }
  return out;
}

describe('structured-output schemas are strict-json_schema safe', () => {
  const schemas: Record<string, ZodType> = { VisualCritiqueSchema, SheetReviewSchema, ArchitectPlanSchema };
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name}: every object lists all its properties as required`, () => {
      const json = toJsonSchema(schema, { cycles: 'ref', reused: 'ref' }) // same options as interopZodResponseFormat;
      expect(violations(json, name, [])).toEqual([]);
    });
  }
});
