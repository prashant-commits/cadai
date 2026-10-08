import { z } from 'zod';
import { RunnableLambda } from '@langchain/core/runnables';
import { toAnthropicCompatibleSchema } from './strict-schema';
import { AssemblySpecSchema } from './assembly-spec';

// Schemas handed to withStructuredOutput. The gateway enforces OpenAI strict
// json_schema, which rejects `.optional()` (use `.default()` or a required field).

/** What the Design Inspector is allowed to say about a set of renders. */
export const VisualCritiqueSchema = z.object({
  matchesIntent: z.boolean(),
  findings: z
    .array(
      z.object({
        issue: z.string().describe('What is visibly wrong, in one sentence.'),
        severity: z.enum(['minor', 'major']),
        // NOT optional. The vision default (gpt-5.6-luna) enforces OpenAI
        // strict json_schema, which rejects any property missing from
        // `required` with a 400 before the model ever runs.
        view: z.string().describe('front | right | top | iso, or "" if it applies to all views'),
      })
    )
    .default([]),
});

export const SheetReviewSchema = z.object({
  matchesRequest: z.boolean(),
  findings: z.array(
    z.object({
      issue: z.string(),
      severity: z.enum(['minor', 'major']),
    })
  ),
});


export const ArchitectPlanSchema = z.object({
  brief: z.string().default(''),
  assumptions: z
    .array(z.object({ field: z.string(), value: z.string(), rationale: z.string() }))
    .default([]),
  openQuestions: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        // `.default`, not `.optional()`: strict json_schema lists defaulted keys as required, and a reply that omits it still parses.
        options: z.array(z.string()).default([]),
        suggestedAnswer: z.string().default(''),
      })
    )
    .default([]),
  variants: z
    .array(
      z.object({
        id: z.enum(['A', 'B', 'C']),
        name: z.string(),
        idea: z.string(),
      })
    )
    .min(1)
    .max(3),
  recommendedId: z.enum(['A', 'B', 'C']).default('A'),
});


function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireComponentFields(json: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const props = isPlainObject(json.properties) ? json.properties : undefined;
  const components = props?.components as { items?: { properties?: Record<string, unknown>; required?: string[] } } | undefined;
  const items = components?.items;
  if (!items?.properties) return json;
  items.required = [...new Set<string>([...(items.required ?? []), ...fields])];
  return json;
}

/** The 7 properties kept optional in Claude's variant spec schema because they have no safe neutral value. */
export const CLAUDE_KEEP_OPTIONAL = new Set([
  'components[].bedFace',
  'components[].holes[].depth',
  'guides[].shape',
  'guides[].localExtents',
  'guides[].position',
  'guides[].points',
  'stressPoints[].gusset',
]);

/**
 * Walks an object schema and makes every property required, except paths in keepOptional.
 * Path format matches table: e.g. 'components[].holes[].depth'. Pure in logic; mutates json in-place.
 */
export function requireAllExcept(
  node: unknown,
  keepOptional: Set<string>,
  parentPath = ''
): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if (obj.type === 'object' && isPlainObject(obj.properties)) {
    const allProps = Object.keys(obj.properties);
    const requiredProps = allProps.filter((k) => {
      const propPath = parentPath ? `${parentPath}.${k}` : k;
      return !keepOptional.has(propPath);
    });

    if (parentPath === '' && requiredProps.includes('sheet')) {
      obj.required = ['sheet', ...requiredProps.filter((k) => k !== 'sheet')];
    } else {
      obj.required = requiredProps;
    }

    for (const [k, v] of Object.entries(obj.properties)) {
      const propPath = parentPath ? `${parentPath}.${k}` : k;
      if (v && typeof v === 'object') {
        const vObj = v as Record<string, unknown>;
        if (vObj.type === 'array' && isPlainObject(vObj.items)) {
          requireAllExcept(vObj.items, keepOptional, `${propPath}[]`);
        } else if (vObj.type === 'object' || isPlainObject(vObj.properties)) {
          requireAllExcept(vObj, keepOptional, propPath);
        }
      }
    }
  } else if (obj.type === 'array' && isPlainObject(obj.items)) {
    requireAllExcept(obj.items, keepOptional, `${parentPath}[]`);
  }
}

/**
 * Returns all optional property paths across the schema (properties not in their object's `required`).
 */
export function getOptionalProperties(schema: unknown, parentPath = ''): string[] {
  const optional: string[] = [];
  if (!schema || typeof schema !== 'object') return optional;
  const node = schema as Record<string, unknown>;

  if (node.type === 'object' && isPlainObject(node.properties)) {
    const req = new Set((Array.isArray(node.required) ? node.required : []) as string[]);
    for (const [k, v] of Object.entries(node.properties)) {
      const propPath = parentPath ? `${parentPath}.${k}` : k;
      if (!req.has(k)) {
        optional.push(propPath);
      }
      if (v && typeof v === 'object') {
        const vObj = v as Record<string, unknown>;
        if (vObj.type === 'array' && isPlainObject(vObj.items)) {
          optional.push(...getOptionalProperties(vObj.items, `${propPath}[]`));
        } else if (vObj.type === 'object' || isPlainObject(vObj.properties)) {
          optional.push(...getOptionalProperties(vObj, propPath));
        }
      }
    }
  } else if (node.type === 'array' && isPlainObject(node.items)) {
    optional.push(...getOptionalProperties(node.items, `${parentPath}[]`));
  }

  return optional;
}

/**
 * Attaches neutral-value descriptions to properties that became required for Claude.
 */
function annotateClaudeDescriptions(json: Record<string, unknown>): void {
  const props = isPlainObject(json.properties) ? json.properties : undefined;
  if (!props) return;

  // jointContracts
  if (isPlainObject(props.jointContracts)) {
    props.jointContracts.description = '[] when there are no joints.';
    const items =
      isPlainObject(props.jointContracts.items) && isPlainObject(props.jointContracts.items.properties)
        ? props.jointContracts.items.properties
        : undefined;
    if (items) {
      if (isPlainObject(items.partA)) items.partA.description = '"" when the joint is not attached to a component.';
      if (isPlainObject(items.partB)) items.partB.description = '"" when the joint is not attached to a component.';
    }
  }

  const annotateShape = (shapeObj: unknown) => {
    if (!isPlainObject(shapeObj) || !isPlainObject(shapeObj.properties)) return;
    const sp = shapeObj.properties;
    if (isPlainObject(sp.axis)) sp.axis.description = 'cylinder and tube only; any value for other kinds (ignored)';
    if (isPlainObject(sp.innerD)) sp.innerD.description = 'tube only; 0 for other kinds';
    if (isPlainObject(sp.wall)) sp.wall.description = 'shell only; 0 for other kinds';
    if (isPlainObject(sp.openFace)) sp.openFace.description = 'shell only; any value for other kinds (ignored)';
    if (isPlainObject(sp.plane)) sp.plane.description = 'profile only; any value for other kinds';
    if (isPlainObject(sp.points)) sp.points.description = 'profile only; points is [] and plane any value for other kinds';
    if (isPlainObject(sp.holes)) sp.holes.description = 'profile inner outlines; [] when none or for other kinds';
  };

  // components
  if (isPlainObject(props.components) && isPlainObject(props.components.items)) {
    const compProps = isPlainObject(props.components.items.properties) ? props.components.items.properties : undefined;
    if (compProps) {
      if (isPlainObject(compProps.rotation)) compProps.rotation.description = '[0,0,0] for no rotation';
      if (isPlainObject(compProps.positionNote)) compProps.positionNote.description = '"" when the part sits at the origin.';
      if (isPlainObject(compProps.holes)) {
        compProps.holes.description = '[] when there are none.';
        const holeItems =
          isPlainObject(compProps.holes.items) && isPlainObject(compProps.holes.items.properties)
            ? compProps.holes.items.properties
            : undefined;
        if (holeItems && isPlainObject(holeItems.note)) {
          holeItems.note.description = '"" when none.';
        }
      }
      annotateShape(compProps.shape);
    }
  }

  // guides
  if (isPlainObject(props.guides) && isPlainObject(props.guides.items)) {
    const guideProps = isPlainObject(props.guides.items.properties) ? props.guides.items.properties : undefined;
    if (guideProps) {
      if (isPlainObject(guideProps.rotation)) guideProps.rotation.description = '[0,0,0] for no rotation (guides: ignored for line guides).';
      annotateShape(guideProps.shape);
    }
  }

  // stressPoints
  if (isPlainObject(props.stressPoints) && isPlainObject(props.stressPoints.items)) {
    const spProps = isPlainObject(props.stressPoints.items.properties) ? props.stressPoints.items.properties : undefined;
    if (spProps && isPlainObject(spProps.component)) {
      spProps.component.description = '"" when not tied to one component.';
    }
  }
}

/**
 * Variant AssemblySpec JSON Schema tailored for Anthropic/Claude:
 * built from AssemblySpecSchema without OpenAI strict transforms (no nullable unions),
 * every property required except exactly 7 (under Anthropic's cap of 24),
 * sheet first, neutral value descriptions added, unsupported Anthropic keywords stripped,
 * additionalProperties: false.
 */
export function claudeVariantSpecSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(AssemblySpecSchema) as Record<string, unknown>;
  delete json.$schema;
  const props = isPlainObject(json.properties) ? json.properties : undefined;
  if (props) {
    delete props.specApprovedAt;
    delete props.openQuestions;

    // Place sheet first in properties
    if ('sheet' in props) {
      const { sheet, ...rest } = props;
      json.properties = { sheet, ...rest };
    }
  }

  annotateClaudeDescriptions(json);
  requireAllExcept(json, CLAUDE_KEEP_OPTIONAL);

  const safe = toAnthropicCompatibleSchema(json);
  delete safe.$schema;
  return safe;
}

function normalizeShape(shape: unknown): unknown {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return shape;
  const s = shape as Record<string, unknown>;
  switch (s.kind) {
    case 'box':
      return { kind: 'box' };
    case 'cylinder': {
      const out: Record<string, unknown> = { kind: 'cylinder' };
      if (s.axis !== undefined) out.axis = s.axis;
      return out;
    }
    case 'tube': {
      const out: Record<string, unknown> = { kind: 'tube' };
      if (s.axis !== undefined) out.axis = s.axis;
      if (s.innerD !== undefined) out.innerD = s.innerD;
      return out;
    }
    case 'shell': {
      const out: Record<string, unknown> = { kind: 'shell' };
      if (s.wall !== undefined) out.wall = s.wall;
      if (s.openFace !== undefined) out.openFace = s.openFace;
      return out;
    }
    case 'profile': {
      const out: Record<string, unknown> = { kind: 'profile' };
      if (s.plane !== undefined) out.plane = s.plane;
      if (s.points !== undefined) out.points = s.points;
      if (s.holes !== undefined) out.holes = s.holes;
      return out;
    }
    default:
      return { ...s };
  }
}

function normalizeComponent(comp: unknown): unknown {
  if (!comp || typeof comp !== 'object' || Array.isArray(comp)) return comp;
  const c = { ...(comp as Record<string, unknown>) };
  if (c.positionNote === '') {
    delete c.positionNote;
  }
  if (Array.isArray(c.holes)) {
    c.holes = c.holes.map((h) => {
      if (!h || typeof h !== 'object' || Array.isArray(h)) return h;
      const hole = { ...(h as Record<string, unknown>) };
      if (hole.note === '') {
        delete hole.note;
      }
      return hole;
    });
  }
  if (c.shape !== undefined) {
    c.shape = normalizeShape(c.shape);
  }
  return c;
}

function normalizeGuide(guide: unknown): unknown {
  if (!guide || typeof guide !== 'object' || Array.isArray(guide)) return guide;
  const g = { ...(guide as Record<string, unknown>) };
  if (g.shape !== undefined) {
    g.shape = normalizeShape(g.shape);
  }
  if (g.kind === 'line') {
    delete g.shape;
    delete g.localExtents;
    delete g.position;
    delete g.rotation;
  } else if (g.kind === 'envelope') {
    delete g.points;
  }
  return g;
}

function normalizeJointContract(joint: unknown): unknown {
  if (!joint || typeof joint !== 'object' || Array.isArray(joint)) return joint;
  const j = { ...(joint as Record<string, unknown>) };
  if (j.partA === '') {
    delete j.partA;
  }
  if (j.partB === '') {
    delete j.partB;
  }
  return j;
}

function normalizeStressPoint(sp: unknown): unknown {
  if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return sp;
  const s = { ...(sp as Record<string, unknown>) };
  if (s.component === '') {
    delete s.component;
  }
  return s;
}

/**
 * Maps neutral values emitted by Claude back to "absent" so lenient zod schemas
 * parse the result identically to the OpenAI path. Pure; does not mutate input.
 */
export function normalizeClaudeSentinels(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;

  const out = { ...(raw as Record<string, unknown>) };

  if (Array.isArray(out.jointContracts)) {
    out.jointContracts = out.jointContracts.map(normalizeJointContract);
  }

  if (Array.isArray(out.components)) {
    out.components = out.components.map(normalizeComponent);
  }

  if (Array.isArray(out.guides)) {
    out.guides = out.guides.map(normalizeGuide);
  }

  if (Array.isArray(out.stressPoints)) {
    out.stressPoints = out.stressPoints.map(normalizeStressPoint);
  }

  return out;
}

/**
 * `model.withStructuredOutput(schema, opts)`, except for Claude slugs: those go
 * through the gateway to Anthropic's structured outputs, which reject several
 * JSON Schema keywords (maxItems, numeric bounds ...) and cap optional parameters.
 * For Claude routes, the schema is built without OpenAI strict nullable unions:
 * optional parameters are capped to exactly 7 with neutral descriptions, additionalProperties: false
 * is kept, unsupported keywords and default keywords are stripped.
 * Outputs from the variant spec are piped through normalizeClaudeSentinels.
 * The reply is still validated by the caller against the zod schema.
 */
export function structuredFor<M extends { withStructuredOutput: (...args: never[]) => unknown }>(
  model: M,
  slug: string,
  schema: z.ZodType | Record<string, unknown>,
  opts: { name?: string; strict?: boolean; includeRaw?: boolean } = {}
): ReturnType<M['withStructuredOutput']> {
  const call = model.withStructuredOutput as unknown as (s: unknown, o?: unknown) => ReturnType<M['withStructuredOutput']>;
  if (!slug.startsWith('claude-')) return call.call(model, schema, opts);

  const schemaProps =
    isPlainObject(schema) && isPlainObject(schema.properties) ? schema.properties : undefined;
  const isVariantSpec =
    opts.name === 'AssemblySpec' ||
    schema === AssemblySpecSchema ||
    (schemaProps !== undefined && 'assemblyName' in schemaProps);

  if (isVariantSpec) {
    const safe = claudeVariantSpecSchema();
    const bound = call.call(model, safe, { ...opts, name: opts.name ?? 'AssemblySpec', strict: true });
    const normalizer = opts.includeRaw
      ? RunnableLambda.from((res: unknown) => {
          if (res && typeof res === 'object' && 'parsed' in res) {
            const rawObj = res as { parsed: unknown; raw?: unknown };
            return { ...rawObj, parsed: normalizeClaudeSentinels(rawObj.parsed) };
          }
          return normalizeClaudeSentinels(res);
        })
      : RunnableLambda.from(normalizeClaudeSentinels);

    if (bound && typeof (bound as { pipe?: unknown }).pipe === 'function') {
      return (bound as unknown as { pipe: (n: unknown) => ReturnType<M['withStructuredOutput']> }).pipe(normalizer);
    }
    return bound;

  }

  let json: Record<string, unknown>;
  if (schema instanceof z.ZodType) {
    json = z.toJSONSchema(schema) as Record<string, unknown>;
    delete json.$schema;

    const props = isPlainObject(json.properties) ? json.properties : undefined;
    if (props) {
      if ('components' in props) {
        json.required = [...new Set<string>([...((json.required as string[]) ?? []), 'components'])];
        requireComponentFields(json, ['position', 'localExtents', 'shape']);
      }
      if ('sheet' in props) {
        const { sheet, ...rest } = props;
        json.properties = { sheet, ...rest };
        if (Array.isArray(json.required) && json.required.includes('sheet')) {
          json.required = ['sheet', ...(json.required as string[]).filter((k) => k !== 'sheet')];
        }
      }
    }
  } else {
    json = schema;
  }

  const safe = toAnthropicCompatibleSchema(json);
  delete safe.$schema;
  return call.call(model, safe, { ...opts, name: opts.name ?? 'Reply', strict: true });
}



