/** OpenAI-strict transform: every object lists ALL its properties in `required`; a property that was optional becomes `anyOf: [<schema>, { type: 'null' }]`; every object gets `additionalProperties: false`; every `default` keyword is removed. Pure; does not mutate its input. */
export function toStrictJsonSchema(json: unknown, inPropertyMap = false): Record<string, unknown> {
  if (Array.isArray(json)) {
    return json.map((j) => toStrictJsonSchema(j)) as unknown as Record<string, unknown>;
  }
  
  if (json && typeof json === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(json)) {
      // Inside a `properties` map the keys are property NAMES, not keywords.
      out[k] = toStrictJsonSchema(v, !inPropertyMap && k === 'properties');
    }

    if (out.type === 'object' && out.properties) {
      out.additionalProperties = false;
      const allKeys = Object.keys(out.properties);
      const existingRequired = new Set<string>(out.required || []);
      
      for (const key of allKeys) {
        const prop = out.properties[key];
        if (!existingRequired.has(key)) {
          out.properties[key] = {
            anyOf: [prop, { type: 'null' }]
          };
        }
      }
      out.required = allKeys;
    }

    if (!inPropertyMap && 'default' in out) {
      delete out.default; // the `default` keyword; a property literally named `default` is kept
    }

    return out;
  }
  return json as Record<string, unknown>;
}

/** Deep-converts null to undefined (arrays and plain objects), so a strict reply parses against the lenient zod schema. */
export function nullsToUndefined<T>(value: T): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (value === null) return undefined as any as T;
  if (Array.isArray(value)) {
    return value.map(nullsToUndefined) as unknown as T;
  }
  if (value && typeof value === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = nullsToUndefined(v);
    }
    return out as T;
  }
  return value;
}

/**
 * JSON Schema keywords Anthropic's structured outputs reject. The first eval on
 * claude-opus-5.5 (2026-10-08) failed every planner and variant call with:
 *   400 provider rejected the request: output_config.format.schema:
 *   For 'array' type, property 'maxItems' is not supported
 * The gateway forwards our json_schema to Anthropic, which accepts only a subset
 * (no numeric or string bounds, no pattern, minItems only 0 or 1). No Anthropic
 * SDK ships in node_modules to read the list from, so it is taken from that error
 * and Anthropic's documented limitations. Removed here:
 *   maxItems, minItems (unless 0 or 1), minimum, maximum, exclusiveMinimum,
 *   exclusiveMaximum, multipleOf, minLength, maxLength, pattern.
 * Kept: additionalProperties:false, required, anyOf, enum, type, items, properties.
 * The reply is still validated against the original zod schema, so a dropped
 * bound is enforced there (and a violation goes through the existing retry).
 */
const ANTHROPIC_UNSUPPORTED = [
  'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minLength', 'maxLength', 'pattern',
];

export function toAnthropicCompatibleSchema(json: unknown, inPropertyMap = false): Record<string, unknown> {
  if (Array.isArray(json)) {
    return json.map((j) => toAnthropicCompatibleSchema(j)) as unknown as Record<string, unknown>;
  }
  if (json && typeof json === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) {
      // Inside a `properties` map the keys are property names, not keywords.
      if (!inPropertyMap) {
        if (ANTHROPIC_UNSUPPORTED.includes(k)) continue;
        if (k === 'minItems' && v !== 0 && v !== 1) continue;
      }
      out[k] = toAnthropicCompatibleSchema(v, !inPropertyMap && k === 'properties');
    }
    return out;
  }
  return json as Record<string, unknown>;
}
