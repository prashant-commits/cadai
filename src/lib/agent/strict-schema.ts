/** OpenAI-strict transform: every object lists ALL its properties in `required`; a property that was optional becomes `anyOf: [<schema>, { type: 'null' }]`; every object gets `additionalProperties: false`; every `default` keyword is removed. Pure; does not mutate its input. */
export function toStrictJsonSchema(json: unknown): Record<string, unknown> {
  if (Array.isArray(json)) {
    return json.map(toStrictJsonSchema) as unknown as Record<string, unknown>;
  }
  
  if (json && typeof json === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(json)) {
      out[k] = toStrictJsonSchema(v);
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

    if ('default' in out) {
      delete out.default;
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
