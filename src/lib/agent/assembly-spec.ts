import { z } from 'zod';
import { toStrictJsonSchema } from './strict-schema';

/**
 * A 3-vector in millimetres (positions) or degrees (rotations).
 *
 * Deliberately a length-constrained array and NOT z.tuple(): a tuple compiles
 * to JSON Schema `prefixItems`, which not every constrained decoder accepts.
 * The Google route rejected it outright with a 400, which killed every
 * structured-output call the Architect made, so the spec came back null and the
 * review gate rendered empty. An array of three costs nothing extra and works
 * everywhere, so it stays the portable choice.
 */
const Vec3 = z.array(z.number()).length(3);

export const Vec2 = z.array(z.number()).length(2);           // NOT z.tuple (prefixItems breaks decoders)
export const AxisSchema = z.enum(['x', 'y', 'z']);
export const PlaneSchema = z.enum(['xy', 'xz', 'yz']);

/**
 * The local face of a component that lies on the build plate when it is
 * printed. Declared by the Architect so the Drafter authors that face planar
 * on z = 0, the Inspector knows which face to expect on the bed, and the audit
 * can warn when the compiled part is not resting on it (isFlatPackable).
 */
export const BedFaceSchema = z.enum(['-Z', '+Z', '-X', '+X', '-Y', '+Y']);
export type BedFace = z.infer<typeof BedFaceSchema>;

export const ShapeKindSchema = z.enum(['box', 'cylinder', 'tube', 'shell', 'profile']);
export const ShapeSchema = z.object({
  kind: ShapeKindSchema,
  axis: AxisSchema.optional(),        // cylinder, tube
  innerD: z.number().optional(),      // tube
  wall: z.number().optional(),        // shell
  openFace: BedFaceSchema.optional(), // shell: the open face, same six-value enum as bedFace
  plane: PlaneSchema.optional(),      // profile
  points: z.array(Vec2).optional(),   // profile outline
  holes: z.array(z.array(Vec2)).optional(), // profile inner outlines
});
export type Shape = z.infer<typeof ShapeSchema>;

export const GuideSchema = z.object({
  label: z.string(),
  kind: z.enum(['envelope', 'line']),
  shape: ShapeSchema.optional(),       // envelope; absent = box
  localExtents: Vec3.optional(),       // envelope
  position: Vec3.optional(),           // envelope: min corner in assembly coordinates
  rotation: Vec3.optional(),           // envelope: degrees about its own min corner, applied first
  points: z.array(Vec3).optional(),    // line: 2..12 points in assembly coordinates
});
export type Guide = z.infer<typeof GuideSchema>;

/*
 * Edge treatments (chamfers, fillets, rounds, elephant-foot, lead-ins) were
 * removed from the spec on purpose: every softened edge was extra CSG the
 * model got wrong (non-manifold hulls, changed bounding boxes), and generated
 * parts ship with sharp edges. Any finishing belongs to the parked print-prep
 * node, not to generation.
 */

export const StressRiskSchema = z.enum(['low', 'medium', 'high']);

/**
 * A gusset the Architect prescribes as numbers, in the component's LOCAL frame,
 * so that code can generate and measure it (see design/gussets.ts). The
 * Drafter never models a gusset: a prose mitigation left it to guess a
 * rotation, and it guessed wrong.
 */
export const GussetSpecSchema = z.object({
  /** The inside corner where the wall meets the floor, local mm. */
  corner: Vec3,
  /** Axis the corner line runs along; the gusset's triangle is perpendicular to it. */
  along: z.enum(['x', 'y']),
  /** Which way the floor extends from the wall, on the other horizontal axis. */
  floorDir: z.enum(['+', '-']),
  /** Leg length along the floor and up the wall, mm. */
  legMm: z.number(),
  /** 60-80 % of the thinner braced wall. */
  thicknessMm: z.number(),
  /** Gusset centres along the corner axis, local mm. */
  at: z.array(z.number()),
});
export type GussetSpec = z.infer<typeof GussetSpecSchema>;

/**
 * A hole the Architect prescribes as numbers, in the component's LOCAL frame,
 * so that code can probe for it after the compile.
 *
 * Holes were the largest measurable blind spot in the pipeline: a bolt hole
 * that was deleted, doubled in diameter or moved to the far end of the plate
 * changes no bounding box, no volume the spec declares, no shell count and no
 * overhang, so every numeric check passed a part with the wrong holes or none
 * at all. Prose in `description` cannot be verified; these numbers can be.
 *
 * Only holes worth verifying belong here - the ones a fastener, shaft or
 * dowel has to pass through. Decorative perforations and lattices do not.
 */
export const HoleSpecSchema = z.object({
  /** Nominal diameter in mm - the drilled size, already including fit allowance. */
  d: z.number(),
  /** Axis the hole runs along in the component's local frame. */
  axis: z.enum(['x', 'y', 'z']),
  /**
   * Centre of the hole's mouth on the face it enters, local mm: the point on
   * the surface, not the centre of the bore.
   */
  at: Vec3,
  /** Depth along `axis` from `at`. Omit for a hole that goes all the way through. */
  depth: z.number().optional(),
  /** What the hole is for, e.g. "M3 pass-through for the lid screw". */
  note: z.string().optional(),
});
export type HoleSpec = z.infer<typeof HoleSpecSchema>;

export const StressPointSchema = z.object({
  component: z.string().optional(),
  location: z.string(),
  /** What load, in which direction: "50 N hanging load, bending the arm downward". */
  loadCase: z.string(),
  risk: StressRiskSchema,
  /**
   * A sized prescription, not an adjective: "thicken to 2.2 mm", "bedFace -X
   * so the arm prints flat", "3 gussets, see gusset". Never a fillet, chamfer
   * or round. The Drafter builds the thickening; code builds the gusset.
   */
  mitigation: z.string(),
  /** Present when the mitigation is a gusset: generated deterministically by code. */
  gusset: GussetSpecSchema.optional(),
});
export type StressPoint = z.infer<typeof StressPointSchema>;

export const AssemblySpecSchema = z.object({
  sheet: z.string().default(''),
  assemblyName: z.string(),
  boundingBox: z.object({ width: z.number(), length: z.number(), height: z.number() }),
  jointContracts: z.array(z.object({
    type: z.string(),
    clearance: z.number(),
    /**
     * Names of the two components this joint holds together. Without these a
     * joint is unattached to the assembly graph, and nothing downstream can
     * verify that the declared clearance was actually achieved.
     */
    partA: z.string().optional(),
    partB: z.string().optional(),
  })).optional(),
  components: z.array(z.object({
    /** snake_case; becomes `module <name>()` verbatim. Normalised after parsing by spec-normalize.ts. */
    name: z.string(),
    description: z.string(),
    /**
     * The module's exact size in its own frame, [x, y, z] mm. Required in the
     * request schema; measured after every compile and audited as `extents`.
     * Replaces the old optional length/width/height/depth object, which never
     * said which axis was which.
     */
    localExtents: Vec3.optional(),
    /**
     * Where this component's local origin (its min corner) lands in assembly
     * coordinates, in mm, ALWAYS in the assembled pose. Required in the request
     * schema; defaults to the origin on validation. Emitted as translate() by
     * deterministic code rather than written by the model, because misplaced
     * parts are the failure mode a bounding-box check cannot see.
     */
    position: Vec3.optional(),
    /** Rotation about the component's own origin, in degrees [X, Y, Z]. */
    rotation: Vec3.optional(),
    /**
     * One line deriving the non-zero coordinates from other components, e.g.
     * "z = top of base_plate (localExtents z = 6.4)". Emitted as the comment on
     * the generated placement parameter so a later parametric rewrite is a
     * one-token edit.
     */
    positionNote: z.string().optional(),
    /**
     * Holes a fastener, shaft or dowel must pass through, as numbers in this
     * component's local frame. Probed after every compile (see hole-audit.ts);
     * a hole described only in `description` is not checked by anything.
     */
    holes: z.array(HoleSpecSchema).optional(),
    bedFace: BedFaceSchema.optional(),
    shape: ShapeSchema.optional(),
  })).optional(),
  guides: z.array(GuideSchema).default([]),
  /** Stress concentrations the Architect identified, graded and prescribed for. */
  stressPoints: z.array(StressPointSchema).default([]),
  assumptions: z.array(z.object({
    field: z.string(),
    value: z.string(),
    rationale: z.string()
  })).default([]),
  openQuestions: z.array(z.object({
    id: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    suggestedAnswer: z.string()
  })).default([]),
  specApprovedAt: z.number().optional()
});

export type AssemblySpec = z.infer<typeof AssemblySpecSchema>;

/**
 * The JSON Schema actually sent to the model, as opposed to the zod schema used
 * to validate what comes back.
 *
 * Constrained decoders degenerate on an unbounded `{"type": "number"}`: the
 * grammar permits digits forever, so a model that emits a float artefact like
 * 6.000000000000001 can fall into a zero-repetition loop and pad until it
 * exhausts the output budget, truncating the document mid-value. It is not
 * provider-specific - it was first seen on Gemini and later reproduced on
 * DeepSeek. Measured over 10 laptop-stand-class prompts on deepseek-v4-flash:
 * 6/10 valid and 114s average unbounded, against 8/10 and 78s bounded.
 *
 * The grid and range live ONLY here, never on the zod schema. Adding
 * .multipleOf(0.01) to zod would make it validate the constraint too, and
 * binary floating point makes that check reject legitimate values (0.4 % 0.01
 * is 0.0099999..., not 0). We want to constrain generation, not narrow what we
 * are willing to accept.
 */
export function boundNumbers(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(boundNumbers);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = boundNumbers(v);
    if (out.type === 'number') {
      // 0.01 mm is finer than any FDM printer resolves, so this constrains the
      // decoder without constraining the design. Signed: positions are vectors.
      out.multipleOf = 0.01;
      out.minimum = -100000;
      out.maximum = 100000;
    }
    return out;
  }
  return node;
}

/** Removes fields from a component's properties and `required` list in the REQUEST schema only. */
export function omitRequestComponentFields(json: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const props = json.properties as Record<string, unknown> | undefined;
  const components = props?.components as { items?: { properties?: Record<string, unknown>; required?: string[] } } | undefined;
  const items = components?.items;
  if (!items?.properties) return json;
  for (const field of fields) {
    delete items.properties[field];
  }
  if (Array.isArray(items.required)) {
    items.required = items.required.filter((r) => !fields.includes(r));
  }
  return json;
}

/** Adds fields to a component's `required` list in the REQUEST schema only. */
function requireComponentFields(json: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const props = json.properties as Record<string, unknown> | undefined;
  const components = props?.components as { items?: { properties?: Record<string, unknown>; required?: string[] } } | undefined;
  const items = components?.items;
  if (!items?.properties) return json;
  items.required = [...new Set<string>([...(items.required ?? []), ...fields])];
  return json;
}

export function assemblySpecRequestSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(AssemblySpecSchema) as Record<string, unknown>;
  delete json.$schema;
  if (json.properties) {
    delete (json.properties as Record<string, unknown>).specApprovedAt;
    
    // Ensure top-level `components` is required before strict transform
    json.required = [...new Set<string>([...((json.required as string[]) ?? []), 'components'])];
  }

  // bedFace is print orientation, which belongs to a future slicer node.
  // We omit it from generation requests while keeping it in the zod schema.
  omitRequestComponentFields(json, ['bedFace']);
  
  // The decoder must emit a placement and extents for every component; the
  // zod schema stays lenient so a model that still omits them degrades to
  // [0,0,0] / unmeasured instead of failing the whole spec.
  const withReqFields = requireComponentFields(json, ['position', 'localExtents', 'shape']);
  
  return boundNumbers(toStrictJsonSchema(withReqFields)) as Record<string, unknown>;
}

export function variantSpecRequestSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(AssemblySpecSchema) as Record<string, unknown>;
  delete json.$schema;
  if (json.properties) {
    delete (json.properties as Record<string, unknown>).specApprovedAt;
    delete (json.properties as Record<string, unknown>).openQuestions;
    
    // Ensure top-level components is required before strict transform
    json.required = [...new Set<string>([...((json.required as string[]) ?? []), 'components'])];
  }

  // bedFace is print orientation, which belongs to a future slicer node.
  // We omit it from generation requests while keeping it in the zod schema.
  omitRequestComponentFields(json, ['bedFace']);
  
  const withReqFields = requireComponentFields(json, ['position', 'localExtents', 'shape']);
  
  return boundNumbers(toStrictJsonSchema(withReqFields)) as Record<string, unknown>;
}
