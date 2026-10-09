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

describe('structuredFor', () => {
  const FORBIDDEN = ['maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'default'];

  const recorder = () => {
    const seen: Array<{ schema: unknown; opts: unknown }> = [];
    return { seen, model: { withStructuredOutput(schema: unknown, opts: unknown) { seen.push({ schema, opts }); return 'bound'; } } };
  };

  /**
   * Test-local walker that counts optional property paths across a schema.
   * Enters properties (with or without type: 'object'), items, prefixItems,
   * anyOf, oneOf, allOf, and $defs.
   */
  function walkOptionalPaths(schema: unknown, parentPath = ''): string[] {
    const optional: string[] = [];
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return optional;
    const node = schema as Record<string, unknown>;

    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      const props = node.properties as Record<string, unknown>;
      const req = new Set((Array.isArray(node.required) ? node.required : []) as string[]);
      for (const [k, v] of Object.entries(props)) {
        const propPath = parentPath ? `${parentPath}.${k}` : k;
        if (!req.has(k)) {
          optional.push(propPath);
        }
        optional.push(...walkOptionalPaths(v, propPath));
      }
    }

    if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
      optional.push(...walkOptionalPaths(node.items, `${parentPath}[]`));
    } else if (Array.isArray(node.items)) {
      for (const item of node.items) {
        optional.push(...walkOptionalPaths(item, `${parentPath}[]`));
      }
    }

    if (Array.isArray(node.prefixItems)) {
      for (const item of node.prefixItems) {
        optional.push(...walkOptionalPaths(item, `${parentPath}[]`));
      }
    }

    for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
      if (Array.isArray(node[unionKey])) {
        for (const branch of node[unionKey] as unknown[]) {
          optional.push(...walkOptionalPaths(branch, parentPath));
        }
      }
    }

    if (node.$defs && typeof node.$defs === 'object' && !Array.isArray(node.$defs)) {
      for (const [defName, def] of Object.entries(node.$defs as Record<string, unknown>)) {
        const defPath = parentPath ? `${parentPath}.$defs.${defName}` : `$defs.${defName}`;
        optional.push(...walkOptionalPaths(def, defPath));
      }
    }

    return optional;
  }

  function countUnions(schema: unknown): { total: number; nullable: number; genuine: number } {
    let total = 0;
    let nullable = 0;
    let genuine = 0;

    function walk(node: unknown) {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        const union = obj.anyOf ?? obj.oneOf;
        if (Array.isArray(union)) {
          total++;
          const isNullable = union.some(
            (branch) => branch && typeof branch === 'object' && (branch as Record<string, unknown>).type === 'null'
          );
          if (isNullable) {
            nullable++;
          } else {
            genuine++;
          }
        }
        for (const v of Object.values(obj)) {
          walk(v);
        }
      }
    }

    walk(schema);
    return { total, nullable, genuine };
  }

  it('claude slugs get an Anthropic-safe strict JSON schema; other slugs get the schema unchanged', async () => {
    const { structuredFor, ArchitectPlanSchema } = await import('./llm-schemas');
    const { variantSpecRequestSchema } = await import('./assembly-spec');

    const claude = recorder();
    structuredFor(claude.model as never, 'claude-opus-5.5', ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true });
    const sent = JSON.stringify(claude.seen[0].schema);
    for (const k of FORBIDDEN) expect(sent).not.toContain(`"${k}"`);
    expect(claude.seen[0].opts).toMatchObject({ name: 'ArchitectPlan', strict: true });
    expect((claude.seen[0].schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);

    // The variant JSON schema for Claude has 0 nullable unions and stripped forbidden keywords.
    const variantJson = variantSpecRequestSchema();
    const claudeVariant = recorder();
    structuredFor(claudeVariant.model as never, 'claude-opus-5.5', variantJson, { name: 'AssemblySpec', strict: true });
    const variantSent = JSON.stringify(claudeVariant.seen[0].schema);
    for (const k of FORBIDDEN) expect(variantSent).not.toContain(`"${k}"`);

    // Claude variant branch passes method: 'functionCalling' and has NO strict property
    expect(claudeVariant.seen[0].opts).toMatchObject({ name: 'AssemblySpec', method: 'functionCalling' });
    expect('strict' in (claudeVariant.seen[0].opts as object)).toBe(false);

    // Claude non-variant schema (e.g. SheetReviewSchema) still gets strict: true and no method
    const { SheetReviewSchema } = await import('./llm-schemas');
    const claudeReview = recorder();
    structuredFor(claudeReview.model as never, 'claude-opus-5.5', SheetReviewSchema, { name: 'SheetReview', strict: true });
    expect(claudeReview.seen[0].opts).toMatchObject({ name: 'SheetReview', strict: true });
    expect('method' in (claudeReview.seen[0].opts as object)).toBe(false);

    // Verify union-typed parameters: 0 nullable unions in Claude variant schema,
    // whereas OpenAI strict variant schema has ~30 nullable unions.
    const openaiCounts = countUnions(variantJson);
    expect(openaiCounts.nullable).toBeGreaterThanOrEqual(25);

    const claudeCounts = countUnions(claudeVariant.seen[0].schema);
    expect(claudeCounts.nullable).toBe(0);
    expect(claudeCounts.total).toBe(claudeCounts.genuine);
    expect(claudeCounts.total).toBeLessThan(5); // far below Anthropic's limit

    // Structural requirements on Claude variant schema:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaObj = claudeVariant.seen[0].schema as any;
    expect(schemaObj.additionalProperties).toBe(false);
    expect(schemaObj.required[0]).toBe('sheet'); // sheet first
    expect(schemaObj.required).toContain('components');
    const compReq = schemaObj.properties.components.items.required;
    expect(compReq).toContain('position');
    expect(compReq).toContain('localExtents');
    expect(compReq).toContain('shape');

    // OpenAI routes (gpt-5.6-luna, gpt-6-sol) stay byte-identical.
    const luna = recorder();
    structuredFor(luna.model as never, 'gpt-5.6-luna', ArchitectPlanSchema, { name: 'ArchitectPlan', strict: true });
    expect(luna.seen[0].schema).toBe(ArchitectPlanSchema);
    expect(luna.seen[0].opts).toEqual({ name: 'ArchitectPlan', strict: true });
    const lunaVariant = recorder();
    structuredFor(lunaVariant.model as never, 'gpt-5.6-luna', variantJson, { name: 'AssemblySpec', strict: true });
    expect(lunaVariant.seen[0].schema).toBe(variantJson);
    expect(lunaVariant.seen[0].opts).toEqual({ name: 'AssemblySpec', strict: true });

    const solVariant = recorder();
    structuredFor(solVariant.model as never, 'gpt-6-sol', variantJson, { name: 'AssemblySpec', strict: true });
    expect(solVariant.seen[0].schema).toBe(variantJson);
    expect(solVariant.seen[0].opts).toEqual({ name: 'AssemblySpec', strict: true });
    expect(JSON.stringify(solVariant.seen[0].schema)).toBe(JSON.stringify(variantJson));
  });

  it('replies are still validated by the original zod schema (too many variants fails)', async () => {
    const { ArchitectPlanSchema } = await import('./llm-schemas');
    const v = (id: string) => ({ id, name: id, idea: id });
    expect(ArchitectPlanSchema.safeParse({ variants: [v('A'), v('B'), v('C'), v('A')] }).success).toBe(false);
  });

  it('replies still go through nullsToUndefined and the same zod schemas', async () => {
    const { nullsToUndefined } = await import('./strict-schema');
    const { AssemblySpecSchema } = await import('./assembly-spec');

    // A model reply with nulls for optional fields or omitted fields parses cleanly
    const rawReply = {
      sheet: '## Plate\nPlate design.',
      assemblyName: 'plate_assembly',
      boundingBox: { width: 100, length: 50, height: 10 },
      jointContracts: null,
      components: [
        {
          name: 'base_plate',
          description: 'A mounting plate',
          position: [0, 0, 0],
          localExtents: [100, 50, 10],
          shape: { kind: 'box' },
          holes: null,
          bedFace: null,
        },
      ],
      guides: null,
      stressPoints: null,
      assumptions: null,
      openQuestions: null,
    };

    const cleaned = nullsToUndefined(rawReply);
    const parsed = AssemblySpecSchema.safeParse(cleaned);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sheet).toBe('## Plate\nPlate design.');
      expect(parsed.data.components?.[0].name).toBe('base_plate');
      expect(parsed.data.components?.[0].holes).toBeUndefined();
    }
  });

  const LITERAL_R11_OPTIONAL_PATHS = [
    'components[].holes[].depth',
    'guides[].shape',
    'guides[].localExtents',
    'guides[].position',
    'guides[].points',
    'stressPoints[].gusset',
  ];

  it('counts optional properties across claudeVariantSpecSchema(): exactly the 6 literal R11 table paths via test-local walker (L1)', async () => {
    const { claudeVariantSpecSchema, getOptionalProperties } = await import('./llm-schemas');
    const schema = claudeVariantSpecSchema();

    // Test-local walker enters anyOf, oneOf, allOf, $defs, and untyped properties nodes
    const testWalkerPaths = walkOptionalPaths(schema);
    expect(testWalkerPaths).toHaveLength(6);
    expect([...testWalkerPaths].sort()).toEqual([...LITERAL_R11_OPTIONAL_PATHS].sort());

    // Module walker also matches the literal R11 table array
    const moduleWalkerPaths = getOptionalProperties(schema);
    expect(moduleWalkerPaths).toHaveLength(6);
    expect([...moduleWalkerPaths].sort()).toEqual([...LITERAL_R11_OPTIONAL_PATHS].sort());
  });

  it('requireAllExcept and getOptionalProperties handle walker blind spots: untyped properties, anyOf, oneOf, allOf, $defs (L3)', async () => {
    const { requireAllExcept, getOptionalProperties } = await import('./llm-schemas');

    const synthetic = {
      properties: {
        untyped: {
          properties: {
            a: { type: 'string' },
            b: { type: 'number' },
          },
        },
        unionAny: {
          anyOf: [
            {
              properties: {
                c: { type: 'string' },
              },
            },
          ],
        },
        unionOne: {
          oneOf: [
            {
              properties: {
                d: { type: 'string' },
              },
            },
          ],
        },
        unionAll: {
          allOf: [
            {
              properties: {
                e: { type: 'string' },
              },
            },
          ],
        },
      },
      $defs: {
        DefA: {
          properties: {
            f: { type: 'string' },
            g: { type: 'number' },
          },
        },
      },
    };

    const initialOptional = getOptionalProperties(synthetic);
    expect(initialOptional).toContain('untyped.a');
    expect(initialOptional).toContain('untyped.b');
    expect(initialOptional).toContain('unionAny.c');
    expect(initialOptional).toContain('unionOne.d');
    expect(initialOptional).toContain('unionAll.e');
    expect(initialOptional).toContain('$defs.DefA.f');
    expect(initialOptional).toContain('$defs.DefA.g');

    // Make everything required except untyped.b and $defs.DefA.g
    const keepOptional = new Set(['untyped.b', '$defs.DefA.g']);
    requireAllExcept(synthetic, keepOptional);

    const afterOptional = getOptionalProperties(synthetic);
    expect(afterOptional.sort()).toEqual(['untyped.b', '$defs.DefA.g'].sort());

    // Test-local walker sees identical optional paths
    expect(walkOptionalPaths(synthetic).sort()).toEqual(['untyped.b', '$defs.DefA.g'].sort());
  });

  it('CLAUDE_KEEP_OPTIONAL is immutable and read-only', async () => {
    const { CLAUDE_KEEP_OPTIONAL } = await import('./llm-schemas');
    expect(Object.isFrozen(CLAUDE_KEEP_OPTIONAL)).toBe(true);
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (CLAUDE_KEEP_OPTIONAL as any).add('foo');
    }).toThrow();
  });

  it('has no anyOf containing { type: "null" } anywhere in the Claude schema', async () => {
    const { claudeVariantSpecSchema } = await import('./llm-schemas');
    const schema = claudeVariantSpecSchema();
    const str = JSON.stringify(schema);
    expect(str).not.toMatch(/\{\s*"type"\s*:\s*"null"\s*\}/);
  });

  it('description is present on shape.innerD, jointContracts[].partA, components[].rotation', async () => {
    const { claudeVariantSpecSchema } = await import('./llm-schemas');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = claudeVariantSpecSchema() as any;
    expect(schema.properties.components.items.properties.shape.properties.innerD.description).toBeTruthy();
    expect(schema.properties.jointContracts.items.properties.partA.description).toBeTruthy();
    expect(schema.properties.components.items.properties.rotation.description).toBeTruthy();
  });

  it('normalizeClaudeSentinels removes neutral sentinels, leaves input unmutated, and parses equal to lenient original', async () => {
    const { normalizeClaudeSentinels } = await import('./llm-schemas');
    const { AssemblySpecSchema } = await import('./assembly-spec');

    const input = {
      sheet: '## Plate\nDesign.',
      assemblyName: 'plate',
      boundingBox: { width: 100, length: 50, height: 10 },
      jointContracts: [
        { type: 'butt', clearance: 0.2, partA: '', partB: '' },
      ],
      components: [
        {
          name: 'box_part',
          description: 'A box',
          position: [0, 0, 0],
          localExtents: [100, 50, 10],
          rotation: [0, 0, 0],
          positionNote: '',
          holes: [
            { d: 3, axis: 'z', at: [10, 10, 0], note: '' },
          ],
          shape: {
            kind: 'box',
            axis: 'z',
            innerD: 0,
            wall: 0,
            openFace: '+Z',
            plane: 'xy',
            points: [],
            holes: [],
          },
        },
        {
          name: 'tube_part',
          description: 'A tube',
          position: [10, 10, 0],
          localExtents: [10, 10, 20],
          rotation: [0, 0, 0],
          positionNote: '',
          holes: [],
          shape: {
            kind: 'tube',
            axis: 'z',
            innerD: 4,
            wall: 0,
            openFace: '+Z',
            plane: 'xy',
            points: [],
            holes: [],
          },
        },
      ],
      guides: [
        {
          label: 'line_guide',
          kind: 'line',
          rotation: [0, 0, 0],
          points: [[0, 0, 0], [10, 10, 0]],
        },
      ],
      stressPoints: [
        {
          component: '',
          location: 'centre',
          loadCase: 'tension',
          risk: 'low',
          mitigation: 'none',
        },
      ],
      assumptions: [],
    };

    const cloneInput = JSON.parse(JSON.stringify(input));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const normalized = normalizeClaudeSentinels(input) as any;

    // Input object is not mutated
    expect(input).toEqual(cloneInput);

    // Box component shape becomes { kind: 'box' }
    expect(normalized.components[0].shape).toEqual({ kind: 'box' });
    // positionNote: "" is removed
    expect(normalized.components[0].positionNote).toBeUndefined();
    // holes note: "" is removed
    expect(normalized.components[0].holes[0].note).toBeUndefined();

    // Tube component keeps axis and innerD
    expect(normalized.components[1].shape).toEqual({ kind: 'tube', axis: 'z', innerD: 4 });

    // Line guide loses rotation
    expect(normalized.guides[0].rotation).toBeUndefined();

    // Joint contracts partA and partB: "" are removed
    expect(normalized.jointContracts[0].partA).toBeUndefined();
    expect(normalized.jointContracts[0].partB).toBeUndefined();

    // Stress point component: "" is removed
    expect(normalized.stressPoints[0].component).toBeUndefined();

    const parsedNormalized = AssemblySpecSchema.parse(normalized);
    expect(parsedNormalized.components?.[0].shape).toEqual({ kind: 'box' });
    expect(parsedNormalized.components?.[1].shape).toEqual({ kind: 'tube', axis: 'z', innerD: 4 });
  });

  it('provider equivalence: Claude sentinels vs OpenAI null form produce identical downstream consumer outputs (L2)', async () => {
    const { normalizeClaudeSentinels } = await import('./llm-schemas');
    const { nullsToUndefined } = await import('./strict-schema');
    const { AssemblySpecSchema } = await import('./assembly-spec');
    const { normalizeSpec } = await import('./spec-normalize');
    const { skeletonSignature } = await import('./spec-variants');
    const { specGeometry } = await import('../spec-sheet/geometry');
    const { blockoutScad } = await import('../spec-sheet/blockout-scad');

    const claudeFixture = {
      sheet: '## Multi-part Assembly\nCovering 5 shapes, 2 guides, blind and through holes.',
      assemblyName: 'multi_part_assembly',
      boundingBox: { width: 120, length: 120, height: 60 },
      jointContracts: [
        { type: 'butt', clearance: 0.2, partA: '', partB: '' },
      ],
      components: [
        {
          name: 'box_part',
          description: 'A box part with through and blind holes',
          position: [0, 0, 0],
          localExtents: [50, 40, 10],
          rotation: [0, 0, 0],
          positionNote: '',
          holes: [
            { d: 4, axis: 'z', at: [10, 10, 0], depth: 5, note: '' },
            { d: 3, axis: 'z', at: [25, 20, 0], note: '' },
          ],
          shape: {
            kind: 'box',
            axis: 'z',
            innerD: 0,
            wall: 0,
            openFace: '+Z',
            plane: 'xy',
            points: [],
            holes: [],
          },
        },
        {
          name: 'cylinder_part',
          description: 'A cylinder part',
          position: [60, 0, 0],
          localExtents: [20, 20, 30],
          rotation: [0, 0, 0],
          positionNote: '',
          holes: [],
          shape: {
            kind: 'cylinder',
            axis: 'z',
            innerD: 0,
            wall: 0,
            openFace: '+Z',
            plane: 'xy',
            points: [],
            holes: [],
          },
        },
        {
          name: 'tube_part',
          description: 'A tube part',
          position: [90, 0, 0],
          localExtents: [20, 20, 30],
          rotation: [0, 0, 0],
          positionNote: '',
          holes: [],
          shape: {
            kind: 'tube',
            axis: 'z',
            innerD: 6,
            wall: 0,
            openFace: '+Z',
            plane: 'xy',
            points: [],
            holes: [],
          },
        },
        {
          name: 'shell_part',
          description: 'A shell part',
          position: [0, 50, 0],
          localExtents: [40, 40, 20],
          rotation: [0, 0, 0],
          positionNote: '',
          holes: [],
          shape: {
            kind: 'shell',
            axis: 'z',
            innerD: 0,
            wall: 2,
            openFace: '+Z',
            plane: 'xy',
            points: [],
            holes: [],
          },
        },
        {
          name: 'profile_part',
          description: 'A profile part with an inner hole',
          position: [50, 50, 0],
          localExtents: [40, 40, 15],
          rotation: [0, 0, 0],
          positionNote: '',
          holes: [],
          shape: {
            kind: 'profile',
            plane: 'xy',
            points: [[0, 0], [40, 0], [40, 40], [0, 40]],
            holes: [[[10, 10], [30, 10], [30, 30], [10, 30]]],
            axis: 'z',
            innerD: 0,
            wall: 0,
            openFace: '+Z',
          },
        },
      ],
      guides: [
        {
          label: 'motor_env',
          kind: 'envelope',
          position: [0, 0, 0],
          localExtents: [30, 30, 40],
          rotation: [0, 0, 0],
          shape: {
            kind: 'cylinder',
            axis: 'z',
            innerD: 0,
            wall: 0,
            openFace: '+Z',
            plane: 'xy',
            points: [],
            holes: [],
          },
          points: [],
        },
        {
          label: 'line_guide',
          kind: 'line',
          points: [[0, 0, 0], [0, 0, 50]],
          rotation: [0, 0, 0],
          position: [0, 0, 0],
          localExtents: [0, 0, 0],
          shape: {
            kind: 'box',
            axis: 'z',
            innerD: 0,
            wall: 0,
            openFace: '+Z',
            plane: 'xy',
            points: [],
            holes: [],
          },
        },
      ],
      stressPoints: [
        {
          component: '',
          location: 'center',
          loadCase: 'tension',
          risk: 'low',
          mitigation: 'rib',
        },
      ],
      assumptions: [],
    };

    const openaiFixture = {
      sheet: '## Multi-part Assembly\nCovering 5 shapes, 2 guides, blind and through holes.',
      assemblyName: 'multi_part_assembly',
      boundingBox: { width: 120, length: 120, height: 60 },
      jointContracts: [
        { type: 'butt', clearance: 0.2, partA: null, partB: null },
      ],
      components: [
        {
          name: 'box_part',
          description: 'A box part with through and blind holes',
          position: [0, 0, 0],
          localExtents: [50, 40, 10],
          rotation: null,
          positionNote: null,
          bedFace: null,
          holes: [
            { d: 4, axis: 'z', at: [10, 10, 0], depth: 5, note: null },
            { d: 3, axis: 'z', at: [25, 20, 0], depth: null, note: null },
          ],
          shape: {
            kind: 'box',
            axis: null,
            innerD: null,
            wall: null,
            openFace: null,
            plane: null,
            points: null,
            holes: null,
          },
        },
        {
          name: 'cylinder_part',
          description: 'A cylinder part',
          position: [60, 0, 0],
          localExtents: [20, 20, 30],
          rotation: null,
          positionNote: null,
          bedFace: null,
          holes: null,
          shape: {
            kind: 'cylinder',
            axis: 'z',
            innerD: null,
            wall: null,
            openFace: null,
            plane: null,
            points: null,
            holes: null,
          },
        },
        {
          name: 'tube_part',
          description: 'A tube part',
          position: [90, 0, 0],
          localExtents: [20, 20, 30],
          rotation: null,
          positionNote: null,
          bedFace: null,
          holes: null,
          shape: {
            kind: 'tube',
            axis: 'z',
            innerD: 6,
            wall: null,
            openFace: null,
            plane: null,
            points: null,
            holes: null,
          },
        },
        {
          name: 'shell_part',
          description: 'A shell part',
          position: [0, 50, 0],
          localExtents: [40, 40, 20],
          rotation: null,
          positionNote: null,
          bedFace: null,
          holes: null,
          shape: {
            kind: 'shell',
            axis: null,
            innerD: null,
            wall: 2,
            openFace: '+Z',
            plane: null,
            points: null,
            holes: null,
          },
        },
        {
          name: 'profile_part',
          description: 'A profile part with an inner hole',
          position: [50, 50, 0],
          localExtents: [40, 40, 15],
          rotation: null,
          positionNote: null,
          bedFace: null,
          holes: null,
          shape: {
            kind: 'profile',
            plane: 'xy',
            points: [[0, 0], [40, 0], [40, 40], [0, 40]],
            holes: [[[10, 10], [30, 10], [30, 30], [10, 30]]],
            axis: null,
            innerD: null,
            wall: null,
            openFace: null,
          },
        },
      ],
      guides: [
        {
          label: 'motor_env',
          kind: 'envelope',
          position: [0, 0, 0],
          localExtents: [30, 30, 40],
          rotation: null,
          shape: {
            kind: 'cylinder',
            axis: 'z',
            innerD: null,
            wall: null,
            openFace: null,
            plane: null,
            points: null,
            holes: null,
          },
          points: null,
        },
        {
          label: 'line_guide',
          kind: 'line',
          points: [[0, 0, 0], [0, 0, 50]],
          rotation: null,
          position: null,
          localExtents: null,
          shape: null,
        },
      ],
      stressPoints: [
        {
          component: null,
          location: 'center',
          loadCase: 'tension',
          risk: 'low',
          mitigation: 'rib',
          gusset: null,
        },
      ],
      assumptions: [],
    };

    const claudeCleaned = nullsToUndefined(normalizeClaudeSentinels(claudeFixture));
    const claudeParsed = AssemblySpecSchema.parse(claudeCleaned);
    const claudeNormalized = normalizeSpec(claudeParsed);

    const openaiCleaned = nullsToUndefined(openaiFixture);
    const openaiParsed = AssemblySpecSchema.parse(openaiCleaned);
    const openaiNormalized = normalizeSpec(openaiParsed);

    // 1. Equal skeletonSignature
    expect(skeletonSignature(claudeNormalized)).toBe(skeletonSignature(openaiNormalized));

    // 2. Equal specGeometry tris length
    const claudeGeo = specGeometry(claudeNormalized);
    const openaiGeo = specGeometry(openaiNormalized);
    expect(claudeGeo.tris.length).toBe(openaiGeo.tris.length);
    expect(claudeGeo.tris.length).toBeGreaterThan(0);

    // 3. Equal blockout SCAD code
    const claudeScad = blockoutScad(claudeNormalized);
    const openaiScad = blockoutScad(openaiNormalized);
    expect(claudeScad.code).toBe(openaiScad.code);
    expect(claudeScad.code).toContain('module box_part()');
    expect(claudeScad.code).toContain('module cylinder_part()');
    expect(claudeScad.code).toContain('module tube_part()');
    expect(claudeScad.code).toContain('module shell_part()');
    expect(claudeScad.code).toContain('module profile_part()');
  });

  it('structuredFor with claude-* pipes through normalizeClaudeSentinels and with non-Claude returns untouched output with byte-identical schema', async () => {
    const { structuredFor } = await import('./llm-schemas');
    const { variantSpecRequestSchema } = await import('./assembly-spec');
    const { RunnableLambda } = await import('@langchain/core/runnables');

    const fixture = {
      sheet: '## Rev\nSheet.',
      assemblyName: 'plate',
      boundingBox: { width: 10, length: 10, height: 10 },
      jointContracts: [{ type: 'butt', clearance: 0.1, partA: '', partB: '' }],
      components: [
        {
          name: 'box',
          description: 'Box',
          position: [0, 0, 0],
          localExtents: [10, 10, 10],
          rotation: [0, 0, 0],
          positionNote: '',
          holes: [],
          shape: { kind: 'box', axis: 'z', innerD: 0, wall: 0, openFace: '+Z', plane: 'xy', points: [], holes: [] },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
    };

    type FakeModel = {
      withStructuredOutput: (schema: unknown, opts?: unknown) => { invoke: (input: unknown) => Promise<unknown> };
    };

    let seenClaudeSchema: unknown;
    let seenClaudeOpts: unknown;
    const claudeFake: FakeModel = {
      withStructuredOutput(schema: unknown, opts: unknown) {
        seenClaudeSchema = schema;
        seenClaudeOpts = opts;
        return RunnableLambda.from(() => fixture);
      },
    };

    const claudeBound = structuredFor(claudeFake, 'claude-opus-5.5', variantSpecRequestSchema(), {
      name: 'AssemblySpec',
      strict: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claudeResult = (await claudeBound.invoke({})) as any;
    expect(claudeResult.components[0].shape).toEqual({ kind: 'box' });
    expect(claudeResult.components[0].positionNote).toBeUndefined();
    expect(claudeResult.jointContracts[0].partA).toBeUndefined();
    expect(seenClaudeSchema).toBeDefined();
    expect(seenClaudeOpts).toMatchObject({ name: 'AssemblySpec', method: 'functionCalling' });
    expect('strict' in (seenClaudeOpts as object)).toBe(false);

    // Non-Claude route (gpt-5.6-luna)
    const variantJson = variantSpecRequestSchema();
    let seenLunaSchema: unknown;
    let seenLunaOpts: unknown;
    const lunaFake: FakeModel = {
      withStructuredOutput(schema: unknown, opts: unknown) {
        seenLunaSchema = schema;
        seenLunaOpts = opts;
        return RunnableLambda.from(() => fixture);
      },
    };

    const lunaBound = structuredFor(lunaFake, 'gpt-5.6-luna', variantJson, {
      name: 'AssemblySpec',
      strict: true,
    });
    expect(seenLunaSchema).toBe(variantJson);
    expect(seenLunaOpts).toEqual({ name: 'AssemblySpec', strict: true });
    expect('method' in (seenLunaOpts as object)).toBe(false);
    const lunaResult = await lunaBound.invoke({});
    expect(lunaResult).toBe(fixture); // completely untouched!

    // Also verify includeRaw
    const rawFixture = { raw: { metadata: true }, parsed: fixture };
    let seenRawOpts: unknown;
    const claudeRawFake: FakeModel = {
      withStructuredOutput(_schema: unknown, opts: unknown) {
        seenRawOpts = opts;
        return RunnableLambda.from(() => rawFixture);
      },
    };
    const claudeRawBound = structuredFor(claudeRawFake, 'claude-opus-5.5', variantSpecRequestSchema(), {
      name: 'AssemblySpec',
      strict: true,
      includeRaw: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawResult = (await claudeRawBound.invoke({})) as any;
    expect(rawResult.raw).toEqual({ metadata: true });
    expect(rawResult.parsed.components[0].shape).toEqual({ kind: 'box' });
    expect(rawResult.parsed.components[0].positionNote).toBeUndefined();
    expect(seenRawOpts).toMatchObject({ name: 'AssemblySpec', method: 'functionCalling', includeRaw: true });
    expect('strict' in (seenRawOpts as object)).toBe(false);
  });

});


