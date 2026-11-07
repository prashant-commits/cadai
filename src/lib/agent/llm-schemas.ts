import { z } from 'zod';
import { RunnableLambda } from '@langchain/core/runnables';
import { JsonOutputKeyToolsParser } from '@langchain/core/output_parsers/openai_tools';
import { assembleStructuredOutputPipeline } from '@langchain/core/language_models/structured_output';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { ChatAnthropic } from '@langchain/anthropic';
import { nullsToUndefined, toAnthropicCompatibleSchema } from './strict-schema';
import { AssemblySpecSchema, omitRequestComponentFields } from './assembly-spec';

// Schemas handed to withStructuredOutput. Anthropic's endpoint enforces strict
// json_schema, which rejects `.optional()` (use `.default()` or a required field).

/** What the Design Inspector is allowed to say about a set of renders. */
export const VisualCritiqueSchema = z.object({
  matchesIntent: z.boolean(),
  findings: z
    .array(
      z.object({
        issue: z.string().describe('What is visibly wrong, in one sentence.'),
        severity: z.enum(['minor', 'major']),
        // NOT optional. Strict json_schema rejects any property missing from
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

/** The 6 properties kept optional in Claude's variant spec schema because they have no safe neutral value. */
const keepSet = new Set([
  'components[].holes[].depth',
  'guides[].shape',
  'guides[].localExtents',
  'guides[].position',
  'guides[].points',
  'stressPoints[].gusset',
]);
(keepSet as unknown as Record<string, unknown>).add = () => {
  throw new Error('CLAUDE_KEEP_OPTIONAL is read-only');
};
(keepSet as unknown as Record<string, unknown>).delete = () => {
  throw new Error('CLAUDE_KEEP_OPTIONAL is read-only');
};
(keepSet as unknown as Record<string, unknown>).clear = () => {
  throw new Error('CLAUDE_KEEP_OPTIONAL is read-only');
};
export const CLAUDE_KEEP_OPTIONAL: ReadonlySet<string> = Object.freeze(keepSet);

/**
 * Walks an object schema and makes every property required, except paths in keepOptional.
 * Path format matches table: e.g. 'components[].holes[].depth'. Pure in logic; mutates json in-place.
 */
export function requireAllExcept(
  node: unknown,
  keepOptional: ReadonlySet<string>,
  parentPath = ''
): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;

  if (isPlainObject(obj.properties)) {
    const allProps = Object.keys(obj.properties);
    const requiredProps = allProps.filter((k) => {
      const propPath = parentPath ? `${parentPath}.${k}` : k;
      return !keepOptional.has(propPath);
    });

    if (parentPath === '' && requiredProps.includes('sheet')) {
      obj.required = [...requiredProps.filter((k) => k !== 'sheet'), 'sheet'];
    } else {
      obj.required = requiredProps;
    }

    for (const [k, v] of Object.entries(obj.properties)) {
      const propPath = parentPath ? `${parentPath}.${k}` : k;
      requireAllExcept(v, keepOptional, propPath);
    }
  }

  if (isPlainObject(obj.items)) {
    requireAllExcept(obj.items, keepOptional, `${parentPath}[]`);
  } else if (Array.isArray(obj.items)) {
    for (const item of obj.items) {
      requireAllExcept(item, keepOptional, `${parentPath}[]`);
    }
  }

  if (Array.isArray(obj.prefixItems)) {
    for (const item of obj.prefixItems) {
      requireAllExcept(item, keepOptional, `${parentPath}[]`);
    }
  }

  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(obj[unionKey])) {
      for (const branch of obj[unionKey] as unknown[]) {
        requireAllExcept(branch, keepOptional, parentPath);
      }
    }
  }

  if (isPlainObject(obj.$defs)) {
    for (const [defName, def] of Object.entries(obj.$defs as Record<string, unknown>)) {
      const defPath = parentPath ? `${parentPath}.$defs.${defName}` : `$defs.${defName}`;
      requireAllExcept(def, keepOptional, defPath);
    }
  }
}

/**
 * Returns all optional property paths across the schema (properties not in their object's `required`).
 */
export function getOptionalProperties(schema: unknown, parentPath = ''): string[] {
  const optional: string[] = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return optional;
  const node = schema as Record<string, unknown>;

  if (isPlainObject(node.properties)) {
    const req = new Set((Array.isArray(node.required) ? node.required : []) as string[]);
    for (const [k, v] of Object.entries(node.properties)) {
      const propPath = parentPath ? `${parentPath}.${k}` : k;
      if (!req.has(k)) {
        optional.push(propPath);
      }
      optional.push(...getOptionalProperties(v, propPath));
    }
  }

  if (isPlainObject(node.items)) {
    optional.push(...getOptionalProperties(node.items, `${parentPath}[]`));
  } else if (Array.isArray(node.items)) {
    for (const item of node.items) {
      optional.push(...getOptionalProperties(item, `${parentPath}[]`));
    }
  }

  if (Array.isArray(node.prefixItems)) {
    for (const item of node.prefixItems) {
      optional.push(...getOptionalProperties(item, `${parentPath}[]`));
    }
  }

  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(node[unionKey])) {
      for (const branch of node[unionKey] as unknown[]) {
        optional.push(...getOptionalProperties(branch, parentPath));
      }
    }
  }

  if (isPlainObject(node.$defs)) {
    for (const [defName, def] of Object.entries(node.$defs as Record<string, unknown>)) {
      const defPath = parentPath ? `${parentPath}.$defs.${defName}` : `$defs.${defName}`;
      optional.push(...getOptionalProperties(def, defPath));
    }
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
 * Variant AssemblySpec JSON Schema tailored for Anthropic/Claude.
 *
 * Strict structured outputs fail on live models with:
 * "400 provider rejected the request: The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."
 * Consequently, the variant spec uses non-strict tool calling (`method: 'functionCalling'`, no `strict` option).
 * The 6-optional schema stays because it also keeps the tool schema small and the descriptions tell the model the neutral values.
 * Every property is required except exactly 6 (under Anthropic's cap of 24), sheet last, neutral value descriptions added,
 * unsupported Anthropic keywords stripped, additionalProperties: false.
 */
export function claudeVariantSpecSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(AssemblySpecSchema) as Record<string, unknown>;
  delete json.$schema;
  const props = isPlainObject(json.properties) ? json.properties : undefined;
  if (props) {
    delete props.specApprovedAt;
    // Stress points and gussets are engineering analysis, not modelling: not requested from the Architect.
    delete props.stressPoints;
    delete props.openQuestions;
    delete props.boundingBox;
    if (Array.isArray(json.required)) {
      json.required = (json.required as string[]).filter((k) => k !== 'stressPoints' && k !== 'boundingBox');
    }

    // Place sheet last in properties
    if ('sheet' in props) {
      const { sheet, ...rest } = props;
      json.properties = { ...rest, sheet };
    }
  }

  omitRequestComponentFields(json, ['bedFace', 'expr']);
  collapseNumberOrString(json);
  annotateClaudeDescriptions(json);
  requireAllExcept(json, CLAUDE_KEEP_OPTIONAL);

  const safe = toAnthropicCompatibleSchema(json);
  delete safe.$schema;
  return safe;
}

/**
 * Number-or-expression fields come out of zod as anyOf [number, string]. Each is
 * a union, and dozens of them would eat Anthropic's union budget, so they are
 * written as the equivalent `type: ['number', 'string']` (one keyword, no union).
 */
function collapseNumberOrString(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(collapseNumberOrString);
    return;
  }
  if (!isPlainObject(node)) return;
  const union = node.anyOf;
  if (
    Array.isArray(union) &&
    union.length === 2 &&
    union.every((b) => isPlainObject(b) && Object.keys(b).length === 1 && (b.type === 'number' || b.type === 'string')) &&
    new Set(union.map((b) => (b as { type: string }).type)).size === 2
  ) {
    delete node.anyOf;
    node.type = ['number', 'string'];
    return;
  }
  for (const v of Object.values(node)) collapseNumberOrString(v);
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

function axisIndex(axis: unknown): 0 | 1 | 2 | undefined {
  if (axis === 'x') return 0;
  if (axis === 'y') return 1;
  if (axis === 'z') return 2;
  return undefined;
}

/**
 * A hole's `at` with exactly two items is the two in-face coordinates with the
 * one along `axis` left out (16 of 72 thinking-off specs, Haiku 5.5): e.g.
 * `{axis: "y", at: ["hole_x1", "hole_z"]}` on a plate with localExtents
 * `["plate_w", "plate_t", "plate_h"]`. The missing coordinate is inserted at the
 * axis index as the component's extent along that axis, i.e. the mouth on the +
 * face, the same convention as a z hole in a 5 mm plate having at[2] = 5
 * (hole-audit.ts probeOrigin). Without a usable axis or extent the hole is left
 * as it is and fails validation.
 */
function completeHoleAt(hole: Record<string, unknown>, localExtents: unknown): Record<string, unknown> {
  if (!Array.isArray(hole.at) || hole.at.length !== 2) return hole;
  const i = axisIndex(hole.axis);
  if (i === undefined || !Array.isArray(localExtents) || localExtents.length !== 3) return hole;
  const extent: unknown = localExtents[i];
  const usable =
    (typeof extent === 'number' && Number.isFinite(extent)) || (typeof extent === 'string' && extent.trim() !== '');
  if (!usable) return hole;
  const at = [...hole.at];
  at.splice(i, 0, extent);
  return { ...hole, at };
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
      const hole = completeHoleAt({ ...(h as Record<string, unknown>) }, c.localExtents);
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

/** Array fields Claude sometimes returns as a string that swallowed the fields after it. */
const BLEED_FIELDS = [
  'parameters', 'derived', 'relations', 'components', 'guides', 'jointContracts', 'stressPoints', 'assumptions', 'openQuestions',
] as const;

/**
 * Claude (Haiku 5.5 most often) sometimes serialises a tool call's array field
 * as a string that runs on past the array: `"[...], \"derived\": [...],
 * \"components\": [...]"`, sometimes closing the outer object (`...]}`) or
 * switching to `</parameter><parameter name="x">` markup half way. The fields
 * after it are then missing from the input. Re-reading the string as the body
 * of `{"<field>": ...}` recovers them; a recovered field fills a missing key
 * and never overwrites one the model sent properly. When nothing parses the
 * input is returned unchanged and the schema reports the string.
 */
export function recoverBledFields(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  for (const field of BLEED_FIELDS) {
    const value = out[field];
    if (typeof value !== 'string') continue;
    const recovered = parseBled(field, value);
    if (!recovered) continue;
    for (const [key, v] of Object.entries(recovered)) {
      if (key === field || isUnset(out[key])) out[key] = v;
    }
  }
  return out;
}

/** Missing, null, or an empty placeholder ([] or "") that a recovered value may fill. */
function isUnset(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0) || (typeof value === 'string' && value.trim() === '');
}

function parseBled(field: string, text: string): Record<string, unknown> | null {
  const body = text.trim();
  const markup = body
    .replace(/<\/parameters?>\s*<parameter name="([A-Za-z_][A-Za-z0-9_]*)">/g, ', "$1": ')
    .replace(/<\/parameters?>\s*$/, '');
  // The string may close the outer object itself, once or twice (`...]}` or `...]}}`).
  const trims = (t: string) => [t, t.replace(/}\s*$/, ''), t.replace(/}\s*}\s*$/, '')];
  const candidates = [...trims(body), ...trims(markup)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(`{"${field}": ${candidate}}`);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed[field])) return parsed;
    } catch { /* next candidate */ }
  }
  return null;
}

/**
 * Top-level array fields that sometimes arrive as a JSON string of the array.
 * Their string ELEMENTS are parsed too, which is safe only because every one of
 * these fields has object elements in AssemblySpecSchema (a plain string element
 * fails it anyway); native-api-review.test.ts pins that.
 */
const STRINGIFIED_ARRAY_FIELDS = [
  'components', 'parameters', 'derived', 'relations', 'guides', 'jointContracts', 'assumptions', 'openQuestions',
] as const;
/** Top-level object fields that sometimes arrive as a JSON string of the object. */
const STRINGIFIED_OBJECT_FIELDS = ['boundingBox'] as const;

/** `text` parsed as JSON when it is JSON of the wanted kind; otherwise undefined. */
function parseJsonOfKind(text: string, kind: 'array' | 'object'): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (kind === 'array') return Array.isArray(value) ? value : undefined;
  return isPlainObject(value) ? value : undefined;
}

/**
 * With thinking off, Haiku 5.5 sometimes sends a whole field as a JSON string
 * (`components: "[{\"name\": ...}]"`, 3 of 72 specs) or one array element as
 * a JSON string of an object (`parameters[1]`, 1 of 72). A string that parses
 * as JSON of the right kind is replaced by the parsed value; any other string
 * is left for the schema to reject.
 */
export function parseStringifiedFields(input: Record<string, unknown>): Record<string, unknown> {
  const out = { ...input };
  for (const field of STRINGIFIED_ARRAY_FIELDS) {
    const value = out[field];
    if (typeof value === 'string') {
      const parsed = parseJsonOfKind(value, 'array');
      if (parsed !== undefined) out[field] = parsed;
    }
    const arr = out[field];
    if (Array.isArray(arr) && arr.some((el) => typeof el === 'string')) {
      out[field] = arr.map((el) => (typeof el === 'string' ? (parseJsonOfKind(el, 'object') ?? el) : el));
    }
  }
  for (const field of STRINGIFIED_OBJECT_FIELDS) {
    const value = out[field];
    if (typeof value !== 'string') continue;
    const parsed = parseJsonOfKind(value, 'object');
    if (parsed !== undefined) out[field] = parsed;
  }
  return out;
}

/**
 * Maps neutral values emitted by Claude back to "absent" so lenient zod schemas
 * parse the result identically to the OpenAI path, and repairs two format slips
 * first seen with thinking off: fields sent as JSON strings
 * (parseStringifiedFields) and two-item hole `at` (completeHoleAt). Pure; does
 * not mutate input.
 */
export function normalizeClaudeSentinels(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;

  const out = recoverBledFields(parseStringifiedFields(raw as Record<string, unknown>));

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

/** Stop reasons that leave a reply cut off before it was finished. */
const CUT_OFF_STOPS = new Set(['max_tokens', 'model_context_window_exceeded', 'pause_turn']);
export type UnusableStop = 'max_tokens' | 'model_context_window_exceeded' | 'pause_turn' | 'refusal';

/**
 * The stop reason of a model reply when it makes the reply unusable: cut off
 * (max_tokens, model_context_window_exceeded, or pause_turn, which only server
 * tools cause and none are bound), where a tool call's input is a parseable but
 * partial object the 6-optional variant schema could accept as a complete spec;
 * or a refusal. Non-streamed replies carry it in response_metadata, streamed
 * ones in additional_kwargs (from the message_delta event).
 */
export function unusableStop(msg: unknown): UnusableStop | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { response_metadata?: Record<string, unknown>; additional_kwargs?: Record<string, unknown> };
  const reason = m.response_metadata?.stop_reason ?? m.additional_kwargs?.stop_reason;
  if (reason === 'refusal') return 'refusal';
  return typeof reason === 'string' && CUT_OFF_STOPS.has(reason) ? (reason as UnusableStop) : null;
}

/** True for the stop reasons that cut a reply short (as opposed to a refusal). */
export function isCutOff(stop: UnusableStop | null | undefined): boolean {
  return !!stop && CUT_OFF_STOPS.has(stop);
}

/** A structured reply that stopped for an unusable reason; callers retry, and can tell a truncation apart. */
export class UnusableReplyError extends Error {
  constructor(readonly stop: UnusableStop) {
    super(`structured reply unusable: stop_reason ${stop}`);
    this.name = 'UnusableReplyError';
  }
}

/** JsonOutputParser that throws on a reply cut off at max_tokens or refused, so the caller retries. */
class StopCheckedJsonOutputParser extends JsonOutputParser {
  async parseResult(...args: Parameters<JsonOutputParser['parseResult']>): ReturnType<JsonOutputParser['parseResult']> {
    const message = (args[0][0] as { message?: unknown } | undefined)?.message;
    const stop = unusableStop(message);
    if (stop) throw new UnusableReplyError(stop);
    return super.parseResult(...args);
  }
}

/**
 * `model.withStructuredOutput(schema, opts)`, adapted for Claude models on the Anthropic endpoint.
 *
 * For Claude variant spec requests, strict structured output fails because Anthropic
 * compiles the whole schema into a decoding grammar:
 * "400 provider rejected the request: The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."
 * Furthermore, forced tool_choice returns 400 on claude-sonnet-5.5 and claude-opus-5.5.
 * Consequently, the variant spec binds the tool with `tool_choice: 'auto'`, and the request prompt
 * instructs the model to call the tool.
 * The 6-optional schema stays because it also keeps the tool schema small and the descriptions tell the model the neutral values.
 * Outputs from the variant spec are piped through normalizeClaudeSentinels.
 *
 * For other Claude routes (planner, reviewer, critic) the schemas are small and are sent as native
 * structured output (`method: 'jsonSchema'`, i.e. `output_config.format`), which constrains the reply
 * to the schema without a tool call. ChatAnthropic's tool-calling method would force tool_choice
 * whenever thinking is disabled, and strict is only accepted with that method.
 * For non-Claude slugs, schema and opts are passed untouched.
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
    const toolName = opts.name ?? 'AssemblySpec';
    let bound: unknown;

    if (typeof (model as { bindTools?: unknown }).bindTools === 'function') {
      const boundModel = (model as unknown as { bindTools: (tools: unknown[], kwargs?: unknown) => unknown }).bindTools(
        [
          {
            type: 'function',
            function: {
              name: toolName,
              description: 'Emit the Assembly Spec for this variant.',
              parameters: safe,
            },
          },
        ],
        { tool_choice: 'auto' }
      );
      if (typeof (boundModel as { pipe?: unknown })?.pipe === 'function') {
        const toolsParser = new JsonOutputKeyToolsParser({
          keyName: toolName,
          returnSingle: true,
        });
        // Handle real AIMessage tool calls, plain objects from mocks, and stringified JSON from test harnesses
        const parser = RunnableLambda.from(async (msg: unknown) => {
          if (msg && typeof msg === 'object' && !('content' in msg) && !('_getType' in msg)) {
            return msg;
          }
          // Truncated or refused: a failed attempt, which the caller retries (and, for a
          // truncation, retries asking for a shorter spec).
          const stop = unusableStop(msg);
          if (stop) throw new UnusableReplyError(stop);
          const parsedTool = await toolsParser.invoke(msg as never);
          if (parsedTool !== undefined) return parsedTool;
          if (msg && typeof msg === 'object' && 'content' in msg) {
            const content = (msg as { content: unknown }).content;
            if (typeof content === 'string') {
              try {
                const parsed = JSON.parse(content);
                if (parsed && typeof parsed === 'object') return parsed;
              } catch {
                // ignore
              }
            }
          }
          return undefined;
        });
        bound = assembleStructuredOutputPipeline(boundModel as never, parser as never, opts.includeRaw);
      } else {
        bound = boundModel;
      }
    } else {
      const variantOpts: { name: string; method: 'functionCalling'; includeRaw?: boolean } = {
        name: toolName,
        method: 'functionCalling',
      };
      if (opts.includeRaw !== undefined) {
        variantOpts.includeRaw = opts.includeRaw;
      }
      bound = call.call(model, safe, variantOpts);
    }

    const normalizer = opts.includeRaw
      ? RunnableLambda.from((res: unknown) => {
          if (res && typeof res === 'object' && 'parsed' in res) {
            const rawObj = res as { parsed: unknown; raw?: unknown };
            return {
              ...rawObj,
              parsed: rawObj.parsed ? normalizeClaudeSentinels(rawObj.parsed) : rawObj.parsed,
            };
          }
          return res ? normalizeClaudeSentinels(res) : res;
        })
      : RunnableLambda.from((res: unknown) => (res ? normalizeClaudeSentinels(res) : res));

    if (bound && typeof (bound as { pipe?: unknown }).pipe === 'function') {
      return (bound as unknown as { pipe: (n: unknown) => ReturnType<M['withStructuredOutput']> }).pipe(normalizer);
    }
    return bound as ReturnType<M['withStructuredOutput']>;
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
        json.properties = { ...rest, sheet };
        if (Array.isArray(json.required) && json.required.includes('sheet')) {
          json.required = [...(json.required as string[]).filter((k) => k !== 'sheet'), 'sheet'];
        }
      }
    }
  } else {
    json = schema;
  }

  const safe = toAnthropicCompatibleSchema(json);
  delete safe.$schema;
  if (model instanceof ChatAnthropic) {
    // Sent as output_config.format directly. withStructuredOutput({method: 'jsonSchema'})
    // would run the schema through the SDK's transformJSONSchema, which moves `enum`
    // (severity, variant ids) into the description as text, so the decoder no longer
    // enforces it. `safe` is already Anthropic-compatible.
    const llm = model.withConfig({
      outputVersion: 'v0',
      outputConfig: { format: { type: 'json_schema', schema: safe } },
      ls_structured_output_format: { kwargs: { method: 'json_schema' }, schema: safe },
    } as never);
    return assembleStructuredOutputPipeline(
      llm as never,
      new StopCheckedJsonOutputParser() as never,
      opts.includeRaw
    ) as unknown as ReturnType<M['withStructuredOutput']>;
  }
  const jsonOpts: { name: string; method: 'jsonSchema'; includeRaw?: boolean } = {
    name: opts.name ?? 'Reply',
    method: 'jsonSchema',
  };
  if (opts.includeRaw !== undefined) jsonOpts.includeRaw = opts.includeRaw;
  return call.call(model, safe, jsonOpts);
}

/**
 * Severity words outside the enum, read by meaning. The decoder enforces
 * `minor | major`, but a reply can still arrive another way (a mock, a model
 * that ignores the schema), and a lost major finding marks a wrong design as
 * validated. So anything not clearly minor counts as major: fail closed.
 */
const MINOR_SEVERITIES = new Set(['minor', 'low', 'trivial', 'cosmetic', 'nit', 'info', 'informational', 'suggestion']);

export function normalizeSeverity(value: unknown): 'minor' | 'major' {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return MINOR_SEVERITIES.has(word) ? 'minor' : 'major';
}

function withNormalizedSeverities(raw: unknown): unknown {
  if (!isPlainObject(raw) || !Array.isArray(raw.findings)) return raw;
  return {
    ...raw,
    findings: raw.findings.map((f) => (isPlainObject(f) ? { ...f, severity: normalizeSeverity(f.severity) } : f)),
  };
}

/** A Sheet Reviewer reply validated against SheetReviewSchema, or null when it is unusable. */
export function parseSheetReview(raw: unknown): z.infer<typeof SheetReviewSchema> | null {
  const parsed = SheetReviewSchema.safeParse(withNormalizedSeverities(nullsToUndefined(raw)));
  return parsed.success ? parsed.data : null;
}

/**
 * A Design Inspector reply validated against VisualCritiqueSchema, or null when it is unusable.
 * A finding without `view` is kept with view "" (all views), as the graph read it before validation.
 */
export function parseVisualCritique(raw: unknown): z.infer<typeof VisualCritiqueSchema> | null {
  let value = withNormalizedSeverities(nullsToUndefined(raw));
  if (isPlainObject(value) && Array.isArray(value.findings)) {
    value = {
      ...value,
      findings: value.findings.map((f) => (isPlainObject(f) && typeof f.view !== 'string' ? { ...f, view: '' } : f)),
    };
  }
  const parsed = VisualCritiqueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A variant id in any case ("a", " B ") as the schema's "A" | "B" | "C"; anything else unchanged. */
function upperVariantId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const id = value.trim().toUpperCase();
  return id === 'A' || id === 'B' || id === 'C' ? id : value;
}

/** A planner reply validated against ArchitectPlanSchema, variant ids read case-insensitively. */
export function parseArchitectPlan(raw: unknown): ReturnType<typeof ArchitectPlanSchema.safeParse> {
  let value = nullsToUndefined(raw);
  if (isPlainObject(value)) {
    value = {
      ...value,
      recommendedId: upperVariantId(value.recommendedId),
      variants: Array.isArray(value.variants)
        ? value.variants.map((v) => (isPlainObject(v) ? { ...v, id: upperVariantId(v.id) } : v))
        : value.variants,
    };
  }
  return ArchitectPlanSchema.safeParse(value);
}
