import { z } from 'zod';

/**
 * A 3-vector in millimetres (positions) or degrees (rotations).
 *
 * Deliberately a length-constrained array and NOT z.tuple(): a tuple compiles
 * to JSON Schema `prefixItems`, which Gemini's response_schema rejects outright
 * with a 400. That killed every structured-output call the Architect made, so
 * the spec came back null and the review gate rendered empty.
 */
const Vec3 = z.array(z.number()).length(3);

/**
 * The local face of a component that lies on the build plate when it is
 * printed. Declared by the Architect so the Drafter authors that face planar
 * on z = 0, the Inspector knows which face to expect on the bed, and the audit
 * can warn when the compiled part is not resting on it (isFlatPackable).
 */
export const BedFaceSchema = z.enum(['-Z', '+Z', '-X', '+X', '-Y', '+Y']);
export type BedFace = z.infer<typeof BedFaceSchema>;

/**
 * Why an edge is softened. The category decides which OpenSCAD idiom the
 * Drafter reaches for and which treatment wins when two meet on one edge
 * (mating flatness > stress_relief > printability > assembly_lead_in >
 * ergonomic_cosmetic), so it is an enum rather than free text.
 */
export const EdgeTreatmentCategorySchema = z.enum([
  'stress_relief',
  'printability',
  'assembly_lead_in',
  'ergonomic_cosmetic',
]);
export type EdgeTreatmentCategory = z.infer<typeof EdgeTreatmentCategorySchema>;

export const EdgeTreatmentSchema = z.object({
  /** Component the edge belongs to; omitted for a single-part spec. */
  component: z.string().optional(),
  /** Where, in the component's own terms: "all vertical outer edges", "inside corner where wall meets floor". */
  location: z.string(),
  category: EdgeTreatmentCategorySchema,
  kind: z.enum(['fillet', 'chamfer', 'round']),
  sizeMm: z.number(),
  rationale: z.string().optional(),
});
export type EdgeTreatment = z.infer<typeof EdgeTreatmentSchema>;

export const StressRiskSchema = z.enum(['low', 'medium', 'high']);

export const StressPointSchema = z.object({
  component: z.string().optional(),
  location: z.string(),
  /** What load, in which direction: "50 N hanging load, bending the arm downward". */
  loadCase: z.string(),
  risk: StressRiskSchema,
  /**
   * A sized prescription, not an adjective: "R1.0 fillet + 1.8 mm gusset every
   * 25 mm", "thicken to 2.2 mm", "bedFace -X so the arm prints flat". The
   * Drafter builds exactly this and the Repair node is forbidden to remove it.
   */
  mitigation: z.string(),
});
export type StressPoint = z.infer<typeof StressPointSchema>;

const DimensionsSchema = z.object({
  length: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  depth: z.number().optional(),
  diameter: z.number().optional(),
  radius: z.number().optional(),
  thickness: z.number().optional(),
});

export const AssemblySpecSchema = z.object({
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
    dimensions: DimensionsSchema.optional()
  })).optional(),
  components: z.array(z.object({
    name: z.string(),
    description: z.string(),
    /**
     * Where this component sits in assembly coordinates, in mm. The component's
     * own module is authored at the ORIGIN in its local frame; this vector is
     * emitted as a translate() by deterministic code rather than written by the
     * model, because misplaced parts are the failure mode a bounding-box check
     * cannot see.
     */
    position: Vec3.optional(),
    /** Rotation about the component's own origin, in degrees [X, Y, Z]. */
    rotation: Vec3.optional(),
    dimensions: DimensionsSchema.optional(),
    bedFace: BedFaceSchema.optional(),
    /**
     * Planar datum/mating faces that must stay flat and free of cosmetic
     * rounding because another part registers against them, e.g.
     * "+Z (lid seat)". Free text: the face plus what it mates with.
     */
    matingFaces: z.array(z.string()).optional(),
  })).optional(),
  /** Every softened edge, categorised. See EdgeTreatmentSchema. */
  edgeTreatments: z.array(EdgeTreatmentSchema).default([]),
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

export function assemblySpecRequestSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(AssemblySpecSchema) as Record<string, unknown>;
  delete json.$schema;
  return boundNumbers(json) as Record<string, unknown>;
}
