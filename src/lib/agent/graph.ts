import { StateGraph, Annotation, END, START, interrupt } from '@langchain/langgraph';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { createSpecRenderer } from './spec-markdown';
import { composeRunSummary } from './run-summary';
import type { StreamEvent } from './stream-events';
import { CAD_AI_SYSTEM_PROMPT, ARCHITECT_PLANNER_PREAMBLE, ARCHITECT_VARIANT_PREAMBLE, DRAFTER_PREAMBLE, REPAIR_PREAMBLE, CRITIC_PREAMBLE, DRAFTER_PLACEMENT_CONTRACT, SHEET_REVIEWER_PREAMBLE } from './system-prompt';
import { extractOpenScadCode } from './code-extractor';
import { validateOpenScadCode } from './code-validator';
import { getFunctionalCadModuleTool } from './engineering-tools';
import { AssemblySpec, AssemblySpecSchema, variantSpecRequestSchema } from './assembly-spec';
import { ValidationResult, ScadDiagnostic } from '../engine/scad-compiler';
import { ModelInfo, GatePayload, GateDecision, GateVariant, DesignContract } from '@/types';
import { SpecViolation, auditSpec } from './spec-audit';
import { analyzeStl } from '../engine/geometry-utils';
import { renderStlViews, RenderedView } from '../engine/stl-renderer';
import { shouldGateSpec, shouldGateAccept } from './gate-policy';
import { getChatModel } from './model-provider';
import { isVisionModel, DEFAULT_MODEL } from './models';
import { renderVariantSheet } from '../spec-sheet/sheet-svg';
import { blockoutScad } from '../spec-sheet/blockout-scad';
import { svgToPngDataUrl } from '../spec-sheet/rasterize';
import {
  composeAssembly,
  stripGeneratedAssembly,
  stripTopLevelGeometry,
  analyzeTopLevel,
  instantiationFor,
} from '../design/compose-assembly';
import { measureModuleFrames, type ModuleFrame } from '../engine/module-frames';
import { PlacementReport } from '../design/placement-report';
import { auditPlacement } from './placement-audit';
import { auditSpecCoherence } from './spec-coherence';
import { auditModuleGuards } from '../design/module-guards';
import { auditHoles } from './hole-audit';
import { normalizeSpec } from './spec-normalize';
import { auditSpecShapes } from './spec-shape-audit';
import { checkInterference } from '../engine/assembly-verifier';
import { nullsToUndefined } from './strict-schema';
import { getCheckpointer } from './checkpointer';
import { VisualCritiqueSchema, SheetReviewSchema, ArchitectPlanSchema } from './llm-schemas';
import {
  SpecVariant,
  SpecBrief,
  mergeBriefIntoSpec,
  recommendedVariant,
  processPlannerVariants,
  maxVariantsFromEnv,
  VariantId,
  ReviewFinding,
  VariantReview,
} from './spec-variants';

const MAX_SPEC_REVISIONS = 2;
const MAX_ACCEPT_REVISIONS = 2;

/**
 * Repair passes granted to a semantic (geometry-vs-spec) failure, counted
 * independently of compile failures. Previously the cutoff was
 * `attemptCount >= 2` against the SHARED counter, so a run that burned its
 * early attempts on syntax reached a dimensional error with nothing left and
 * exited without ever trying to fix it. The global `maxAttempts` still caps
 * the run; this only stops one failure class from starving the other.
 */
const MAX_SEMANTIC_REPAIRS = 1;

type VisualCritique = z.infer<typeof VisualCritiqueSchema>;

/** A skipped component's reason means "drawn as a box" for stand-ins; anything else was left out entirely. */
function isStandIn(reason: string): boolean {
  return reason.includes('drawn as a box');
}

/** Sheet notes, at most 3: placeholders and omissions first (they change how to read the sheet), then the variant's own assumptions. */
export function sheetNotes(spec: AssemblySpec): string[] {
  const placeholders = blockoutScad(spec).skipped.map((s) =>
    isStandIn(s.reason)
      ? `${s.name}: drawn as a box (${s.reason.replace(/;?\s*drawn as a box$/, '')})`
      : `${s.name}: not drawn (${s.reason})`
  );
  const assumptions = (spec.assumptions ?? []).map((a) => `${a.field}: ${a.value}`);
  return [...placeholders, ...assumptions].map((n) => n.slice(0, 60)).slice(0, 3); // 60 chars per note and 3 notes: the sheet's notes strip
}

/** Renders a variant's concept sheet. Deterministic and fast, so state keeps only the spec and this is redrawn on demand. */
function drawSheet(v: SpecVariant): { svg: string; skipped: { name: string; reason: string }[] } {
  if (!v.spec) throw new Error(`variant ${v.id} has no spec to draw`);
  return renderVariantSheet({ id: v.id, name: v.name, idea: v.idea, spec: v.spec, notes: sheetNotes(v.spec) });
}

/** The sheet for a variant that has been drawn, or null when it has none or cannot be redrawn. */
function drawnSheetSvg(v: SpecVariant): string | null {
  if (!v.spec || v.drawnVersion === null) return null;
  try {
    return drawSheet(v).svg;
  } catch (e) {
    console.warn(`drawnSheetSvg: could not redraw sheet ${v.id}:`, e);
    return null;
  }
}

/** True when the spec names at least one component: placement is then always code-driven. */
function specHasComponents(spec: AssemblySpec | null): boolean {
  return !!spec?.components?.length;
}

/**
 * Measures each component module, then hands placement to deterministic code.
 * Every outcome except a clean compose leaves the model's script untouched.
 */
async function placeAssembly(
  code: string,
  spec: AssemblySpec | null
): Promise<{ code: string; report: PlacementReport | null; frames: ModuleFrame[] }> {
  if (!code || !spec?.components?.length) return { code, report: null, frames: [] };

  const defined = new Set(analyzeTopLevel(code).moduleNames);
  const names = spec.components.map((c) => c.name).filter((n) => defined.has(n));
  const frames = await measureModuleFrames(code, names);
  const result = composeAssembly(code, spec, frames);

  if (result.reason === 'missing_modules') {

    return { code: result.code, report: null, frames };
  }

  return { code: result.code, report: result.report, frames };
}

/** Frames as the composer measured them, rebuilt from the report for the interference probe. */
function framesFromReport(report: PlacementReport | null): ModuleFrame[] {
  return (report?.components ?? [])
    .filter((c) => c.measured)
    .map((c) => ({ name: c.name, valid: true, min: c.localMin, max: c.localMax, size: c.size }));
}

/**
 * Each joint costs one extra wasm compile, so cap the probe. Assemblies with
 * more joints than this are rare, and the first few are the load-bearing ones.
 */
const MAX_INTERFERENCE_CHECKS = 4;

/**
 * Verifies that parts declared to clear each other actually do.
 *
 * `shellCount` already catches the opposite failure - parts that should be
 * joined but are not touching. This catches parts that interpenetrate: a
 * dowel too fat for its socket, a lid that fouls a boss. Both are invisible to
 * a bounding-box check, since neither changes the overall envelope.
 */
async function checkAssemblyFit(
  code: string,
  spec: AssemblySpec | null,
  frames: ModuleFrame[] = []
): Promise<SpecViolation[]> {
  const joints = (spec?.jointContracts ?? []).filter((j) => j.partA && j.partB);
  if (!spec || joints.length === 0) return [];

  // Module definitions only. OpenSCAD implicitly unions every top-level object,
  // so any model-written placement left in here would be unioned INTO the
  // probe's intersection() and read as a phantom overlap the size of the part.
  const modules = stripTopLevelGeometry(stripGeneratedAssembly(code)).code;
  const violations: SpecViolation[] = [];

  for (const joint of joints.slice(0, MAX_INTERFERENCE_CHECKS)) {
    const callA = instantiationFor(spec, joint.partA!, frames);
    const callB = instantiationFor(spec, joint.partB!, frames);
    if (!callA || !callB) continue;

    try {
      const result = await checkInterference(modules, callA, callB);
      if (result.error || !result.hasInterference) continue;

      violations.push({
        kind: 'interference',
        field: `${joint.partA} / ${joint.partB}`,
        expected: `${joint.clearance}mm clearance`,
        measured: `${result.intersectionVolumeMm3?.toFixed(2) ?? 'unknown'}mm3 of overlap`,
        severity: 'error',
        message:
          `'${joint.partA}' and '${joint.partB}' interpenetrate by ` +
          `${result.intersectionVolumeMm3?.toFixed(2) ?? 'an unknown volume'}mm3, but their ` +
          `${joint.type} joint declares ${joint.clearance}mm of clearance. ` +
          'Shrink the male feature or enlarge the female one until the parts clear.',
      });
    } catch (e) {
      // An indeterminate probe must not fail the run - the part may be fine.
      console.warn(`Interference check failed for ${joint.partA}/${joint.partB}:`, e);
    }
  }

  return violations;
}

/** Marks the machine-written human messages validateCode appends; they are not the user's words. */
const VALIDATION_REPORT_PREFIX = '[Validation Report]';

/** The user's current request: the text of the LATEST human message they wrote (earlier turns are history). */
function latestHumanText(messages: BaseMessage[]): string {
  for (const msg of [...messages].reverse()) {
    if (msg._getType() !== 'human') continue;
    const c = msg.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      const part = c.find((p) => (p as { type?: string }).type === 'text') as { text?: string } | undefined;
      text = part?.text ?? '';
    }
    if (text && !text.startsWith(VALIDATION_REPORT_PREFIX)) return text;
  }
  return '';
}

/** See the retry loop in architectNode for why this is 3 and not 2. */
const MAX_ARCHITECT_ATTEMPTS = 3;

const NO_SPEC_EXPLANATION =
  'No Assembly Spec could be generated; drafting without a dimensional contract.';

/**
 * The Design Contract as the drafter and repair nodes must see it.
 *
 * Only the architect used to receive the contract, yet auditSpec hard-fails a
 * pinned parameter that is missing or changed and any wall parameter below the
 * minimum - so the nodes that actually write the assignments were being graded
 * on rules they had never been shown.
 */
function contractLines(contract: DesignContract | null): string {
  if (!contract) return '';
  const lines: string[] = [];
  const pins = Object.entries(contract.pinnedParams ?? {});
  if (pins.length) {
    lines.push('REQUIRED top-level assignments (pinned by the user; emit each verbatim):');
    for (const [name, pin] of pins) lines.push(`  ${name} = ${JSON.stringify(pin.value)};`);
  }
  const s = contract.standing ?? {};
  if (s.minWallMm !== undefined) lines.push(`Minimum wall thickness: ${s.minWallMm}mm (every parameter named *wall* is audited against it).`);
  if (s.maxSizeMm) lines.push(`Maximum overall size: ${s.maxSizeMm.join(' x ')}mm.`);
  return lines.length ? `\nDesign Contract:\n${lines.join('\n')}\n` : '';
}

/**
 * What the Design Inspector may know about the spec: the shape it should see,
 * not the numbers it is told not to re-litigate. Handing it the full JSON put
 * every dimension in front of a node whose one job is to look.
 */
function criticSpecSummary(spec: AssemblySpec | null): string {
  if (!spec) return '';
  const lines: string[] = [];
  if (spec.sheet) {
    lines.push(`Design sheet:\n${spec.sheet}`);
  }
  for (const c of spec.components ?? []) {
    const extras = [];
    if (c.bedFace) extras.push(`expected bed face ${c.bedFace}`);
    lines.push(`- ${c.name}: ${c.description}${extras.length ? ` (${extras.join('; ')})` : ''}`);
  }
  for (const s of spec.stressPoints ?? []) {
    if (s.risk === 'low') continue;
    lines.push(`- ${s.risk}-risk stress point at ${s.component ? `${s.component} ` : ''}${s.location}; the spec demands: ${s.mitigation}`);
  }
  return lines.length ? `\n\nApproved spec, in outline:\n${lines.join('\n')}` : '';
}

function skeletonSummary(spec: AssemblySpec | null): string {
  if (!spec) return '';
  const lines: string[] = [];
  if (spec.components?.length) {
    lines.push('Parts:');
    for (const c of spec.components) {
      const kind = c.shape?.kind ?? 'box';
      const ext = c.localExtents ? `[${c.localExtents.join(', ')}]` : 'unknown';
      const pos = c.position ? `[${c.position.join(', ')}]` : '[0, 0, 0]';
      const rot = c.rotation ? `[${c.rotation.join(', ')}]` : '[0, 0, 0]';
      lines.push(`- ${c.name} (${kind}): extents ${ext}, position ${pos}, rotation ${rot}`);
    }
  }
  if (spec.guides?.length) {
    lines.push('Guides:');
    for (const g of spec.guides) {
      lines.push(`- [${g.kind}] ${g.label}`);
    }
  }
  return lines.join('\n');
}

/**
 * Which one violation the repair prompt should lead with. The 'semantic'
 * failure class covers everything from an undeclared identifier to two parts
 * interpenetrating, and "fix the arithmetic" is the wrong instruction for
 * most of them.
 */
const REPAIR_KIND_PRIORITY: SpecViolation['kind'][] = [
  'unknown_symbol', 'dimensionality', 'empty', 'manifold', 'shells', 'interference',
  'clearance', 'floating', 'floor', 'extents', 'bbox', 'standing', 'buildplate', 'compile', 'visual',
];
function dominantViolationKind(violations: SpecViolation[]): SpecViolation['kind'] | null {
  const errors = violations.filter((v) => v.severity === 'error');
  for (const kind of REPAIR_KIND_PRIORITY) {
    if (errors.some((v) => v.kind === kind)) return kind;
  }
  return null;
}

const REPAIR_HINTS: Partial<Record<SpecViolation['kind'], string>> = {
  unknown_symbol: 'An identifier was undefined, so OpenSCAD substituted undef and rendered the wrong solid. Declare it or remove the reference.',
  dimensionality: 'The top-level object is 2D. Extrude every profile with linear_extrude() or rotate_extrude().',
  empty: 'The script produced no solid. Check for zero dimensions and for a difference() that removed everything.',
  manifold: 'The solid is not a valid 2-manifold: coincident faces or a zero-thickness membrane. Extend every cutter at least 0.02mm past each face it exits and sink fused parts 0.01mm into each other.',
  shells: 'The result split into more shells than the spec has components: parts that should be joined are not touching. Overlap them by at least 0.01mm.',
  interference: 'Two parts that must clear each other interpenetrate. Shrink the male feature or enlarge the female one until they clear by the declared joint clearance.',
  clearance: 'A declared clearance was not achieved. Adjust the mating dimensions, not the placement.',
  bbox: 'The measured extents disagree with the spec. Fix the arithmetic behind the offending axis (stacked heights, wall x 2 + cavity, position + size); do not delete features to shrink the box.',
  standing: 'A Design Contract rule was broken: restore the pinned assignment exactly, or raise the wall parameter to the minimum.',
  buildplate: 'The part does not rest on its declared bedFace, or exceeds the allowed overall size. Resize it or correct which face sits on z = 0.',
  floating: 'A component does not rest on the floor or on any other component. Fix its spec position or its module\'s local origin; do not change its shape.',
  floor: 'The lowest point of the model is not at z = 0. Every part must sit on the ground plane or on another part; nothing may ever be below z = 0.',
  extents: 'A module\'s measured size differs from the spec\'s localExtents. Resize the module; do not move it.',
};

/**
 * Compact, human-readable rendering of the Architect's spec.
 *
 * This string becomes the user-facing explanation, which the client stores as
 * the assistant chat message and re-sends as history on the next turn. A raw
 * JSON.stringify(spec, null, 2) dump there meant every later turn carried a
 * full spec blob it had no use for. The gate UI still receives the complete
 * spec object via GatePayload.
 */
function summarizeSpec(spec: AssemblySpec): string {
  const bb = spec.boundingBox;
  const lines = [
    `Assembly Spec: ${spec.assemblyName}`,
    `Bounding box: ${bb.width} x ${bb.length} x ${bb.height} mm`,
  ];

  if (spec.components?.length) {
    lines.push(
      `Components (${spec.components.length}): ${spec.components.map((c) => c.name).join(', ')}`
    );
  }
  if (spec.jointContracts?.length) {
    lines.push(
      `Joints (${spec.jointContracts.length}): ` +
        spec.jointContracts.map((j) => `${j.type} @ ${j.clearance}mm`).join(', ')
    );
  }
  for (const c of spec.components ?? []) {
    if (!c.bedFace) continue;
    const parts = [];
    if (c.bedFace) parts.push(`bed face ${c.bedFace}`);
    lines.push(`${c.name} - ${parts.join('; ')}`);
  }
  for (const s of spec.stressPoints ?? []) {
    lines.push(
      `Stress point [${s.risk}] ${s.component ? `${s.component}: ` : ''}${s.location} - ${s.loadCase}; mitigation: ${s.mitigation}` +
        (s.gusset
          ? ` (${s.gusset.at.length} gusset(s) ${s.gusset.thicknessMm} mm thick, legs ${s.gusset.legMm} mm, corner [${s.gusset.corner.join(', ')}] along ${s.gusset.along}, generated by code)`
          : '')
    );
  }
  for (const a of spec.assumptions ?? []) {
    lines.push(`Assumption - ${a.field}: ${a.value} (${a.rationale})`);
  }
  for (const q of spec.openQuestions ?? []) {
    lines.push(`Open question - ${q.question} (suggested: ${q.suggestedAnswer})`);
  }

  return lines.join('\n');
}

export interface AttemptRecord {
  n: number; phase: 'draft' | 'repair'; code: string;
  exitCode: number;
  errors: ScadDiagnostic[]; warnings: ScadDiagnostic[];
  // Flat-face and overhang numbers ride along so the repair node can reason
  // about print orientation from measurements instead of guessing.
  measured?: Pick<
    ModelInfo,
    'dimensions' | 'volumeMm3' | 'isManifold' | 'shellCount' | 'bottomAreaMm2' | 'isFlatPackable' | 'overhang'
  >;
  violations: SpecViolation[];
  diagnosis: string;
}

export const AgentState = Annotation.Root({
  specBrief: Annotation<SpecBrief | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  specVariants: Annotation<SpecVariant[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  humanSpecNotes: Annotation<string[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  reviewDeadline: Annotation<number | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  /** When the current architect revision round began (null outside a revision round). */
  roundStartedAt: Annotation<number | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  /** Measured duration of the last revision round (architect + illustrator + reviewer), for the budget check. */
  lastRoundMs: Annotation<number | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  /** The variant the human approved; the drafter finds its sheet and findings by this id ONLY. */
  chosenVariantId: Annotation<VariantId | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  assemblySpec: Annotation<AssemblySpec | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  designContract: Annotation<DesignContract | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  currentCode: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  explanation: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  modelInfo: Annotation<ModelInfo | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  validation: Annotation<ValidationResult | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  specViolations: Annotation<SpecViolation[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  placementReport: Annotation<PlacementReport | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  attemptHistory: Annotation<AttemptRecord[]>({
    // Merge by attempt number so a node can either append a new attempt or
    // patch an existing one (fixCode back-fills its diagnosis) without
    // duplicating the whole history on every repair.
    reducer: (x, y) => {
      const merged = [...x];
      for (const rec of y) {
        const i = merged.findIndex((m) => m.n === rec.n);
        if (i >= 0) merged[i] = rec;
        else merged.push(rec);
      }
      return merged;
    },
    default: () => [],
  }),
  attemptCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  maxAttempts: Annotation<number>({
    reducer: (_, y) => y,
    // Parked: automatic repair is off by default while generation quality is
    // the focus. A human can still ask for a revision at the accept gate.
    default: () => Number(process.env.CADAI_MAX_ATTEMPTS ?? 1),
  }),
  failureKind: Annotation<'none'|'no_code'|'truncated'|'compile'|'semantic'|'interference'>({
    reducer: (_, y) => y,
    default: () => 'none',
  }),
  isValid: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => false,
  }),
  stlContent: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  gateAction: Annotation<'approve' | 'revise' | 'cancel' | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  gateFeedback: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  specRevisionCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  acceptRevisionCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  // Per-class failure counters. The two classes used to share `attemptCount`,
  // so two syntax failures could exhaust the budget before the geometry was
  // ever re-examined: compile-fail, then compile-clean-but-wrong-size, and the
  // run ended with the dimensional error unrepaired.
  compileFailures: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  semanticFailures: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),

});

export type AgentStateType = typeof AgentState.State;

/**
 * Writes one stream event on the graph's `custom` channel.
 *
 * langgraph's custom mode yields the bare payload with no node metadata, so the
 * node id travels inside the payload - the client needs it to know which
 * section a delta belongs to.
 */
function write(
  config: LangGraphRunnableConfig | undefined,
  node: string,
  event: StreamEvent
): void {
  config?.writer?.({ ...event, node });
}

/**
 * Creates the CAD AI LangGraph agent graph with tool-calling capabilities.
 */
export function createCadAgent(
  modelName?: string
) {
  const selectedModel = modelName || process.env.CADAI_MODEL || DEFAULT_MODEL;
  const model = getChatModel(selectedModel);
  const criticModel = process.env.CADAI_CRITIC_MODEL ? getChatModel(process.env.CADAI_CRITIC_MODEL) : model;
  
  // Architect operates in two steps: a planner call that streams a brief and
  // 1-3 candidate variant outlines, followed by parallel variant specifier calls
  // producing structured Assembly Specs. Variant calls use structured output
  // handed the BOUNDED JSON Schema, not the zod object: an unbounded
  // {"type":"number"} lets a constrained decoder emit digits forever and truncate
  // the document. What comes back is validated against the zod schema and normalized.

  // Drafter uses engineering lookup tools
  const drafterModel = model.bindTools([getFunctionalCadModuleTool]);

  // Node 1: architectNode

  async function generateVariantSpec(
    variant: { id: VariantId; name: string; idea: string },
    allVariants: { id: VariantId; name: string; idea: string }[],
    brief: SpecBrief,
    baseMessages: BaseMessage[],
    version: number,
    retries: number,
    previousSpec?: { sheet: string; skeleton: unknown },
    findings?: ReviewFinding[],
    notes?: string[],
    previousSheetSvg?: string | null,
    config?: RunnableConfig
  ): Promise<SpecVariant> {
    const variantMessages = [...baseMessages];

    const planContextParts: string[] = [];
    if (brief.markdown) {
      planContextParts.push(`Planner Brief:\n${brief.markdown}`);
    }
    if (brief.assumptions && brief.assumptions.length > 0) {
      const assumptionsText = brief.assumptions
        .map((a) => `- ${a.field}: ${a.value} (${a.rationale})`)
        .join('\n');
      planContextParts.push(`Shared Assumptions:\n${assumptionsText}`);
    }
    if (brief.openQuestions && brief.openQuestions.length > 0) {
      const questionsText = brief.openQuestions
        .map((q) => `- ${q.question}${q.suggestedAnswer ? ` (suggested: ${q.suggestedAnswer})` : ''}`)
        .join('\n');
      planContextParts.push(`The user will be asked:\n${questionsText}`);
    }
    const otherVariants = allVariants.filter((v) => v.id !== variant.id);
    if (otherVariants.length > 0) {
      const othersText = otherVariants
        .map((o) => `- Variant ${o.id}: ${o.name} - ${o.idea}`)
        .join('\n');
      planContextParts.push(
        `Other variants planned (this variant must stay structurally distinct):\n${othersText}`
      );
    }

    if (previousSpec && findings) {
      const promptParts = [
        ...planContextParts,
        `Revise this variant (${variant.id}): ${variant.name} - ${variant.idea}.`,
        `Previous skeleton:\n${JSON.stringify(previousSpec.skeleton, null, 2)}`,
        `Previous sheet:\n${previousSpec.sheet}`,
        findings.length ? `Review findings:\n${findings.map((f) => `[${f.severity.toUpperCase()}] ${f.issue}`).join('\n')}` : '',
        notes?.length ? `Human notes:\n${notes.join('\n')}` : '',
      ].filter(Boolean);

      let prevSheetPngUrl: string | null = null;
      if (previousSheetSvg) {
        try {
          prevSheetPngUrl = await svgToPngDataUrl(previousSheetSvg);
        } catch (e) {
          console.warn('generateVariantSpec: failed to rasterize previous sheet for revision', e);
        }
      }

      if (prevSheetPngUrl) {
        variantMessages.push(
          new HumanMessage({
            content: [
              { type: 'text', text: promptParts.join('\n\n') },
              { type: 'text', text: 'Previous concept sheet render:' },
              { type: 'image_url', image_url: { url: prevSheetPngUrl } },
            ],
          })
        );
      } else {
        variantMessages.push(new HumanMessage(promptParts.join('\n\n')));
      }
    } else {
      const promptParts = [
        ...planContextParts,
        `Generate the Assembly Spec for Variant ${variant.id}: ${variant.name} - ${variant.idea}`,
        notes?.length ? `Human notes:\n${notes.join('\n')}` : '',
      ].filter(Boolean);
      variantMessages.push(new HumanMessage(promptParts.join('\n\n')));
    }

    const variantModel = model.withStructuredOutput(variantSpecRequestSchema(), {
      name: 'AssemblySpec',
      strict: true,
      includeRaw: false,
    });

    let spec: AssemblySpec | null = null;
    let hadProviderError = false;
    let rawLastError: string | null = null;
    let coherenceFeedback: SpecViolation[] | null = null;

    // THREE attempts, not two. Decoder degeneration is per-attempt and
    // independent, so retries compound: at the ~0.8 per-attempt success rate
    // measured on the bounded schema, two attempts leave a 4% chance of
    // reaching the review gate with no spec at all and three leave under 1%.
    // Two attempts is what let a real run surface an empty approval card.
    for (let attempt = 0; attempt < MAX_ARCHITECT_ATTEMPTS && !spec; attempt++) {
      const retryPrompt = coherenceFeedback
        ? 'Your previous Assembly Spec was internally inconsistent:\n' +
          coherenceFeedback.map((v) => `- ${v.message}`).join('\n') +
          '\nRecompute the placement arithmetic and emit a spec whose boundingBox equals the extent of its ' +
          'own components once each is rotated about its origin and moved to its position.'
        : 'Your previous reply did not yield a valid Assembly Spec. Emit the structured spec now, with every dimension in millimetres and at most two decimal places.';

      const attemptMessages =
        attempt === 0 ? variantMessages : [...variantMessages, new HumanMessage(retryPrompt)];

      try {
        const raw = await variantModel.withConfig({ tags: ['nostream'] }).invoke(attemptMessages, config);

        // The model was given a JSON Schema, so what comes back is an untyped
        // object; zod is what turns it into an AssemblySpec, and a reply that
        // violates the schema fails to parse.
        const parsed = AssemblySpecSchema.safeParse(nullsToUndefined(raw));
        if (parsed.success) {
          const candidate = normalizeSpec(parsed.data);
          // Coherence is pure arithmetic (do the components fit the bounding box?),
          // so there is no point drafting geometry from a spec that already contradicts
          // itself. Handing the contradiction back is strictly cheaper than discovering
          // it after a draft and a compile, and the Architect is the only node that can
          // say which number was wrong. On the last attempt it is accepted anyway: a spec
          // that is merely inconsistent still beats no spec, and validateCode repeats
          // the check so the violation is never lost.
          const incoherent = [
            ...auditSpecCoherence(candidate).filter((v) => v.severity === 'error'),
            ...auditSpecShapes(candidate).filter((v) => v.severity === 'error'),
          ];
          if (incoherent.length > 0 && attempt < MAX_ARCHITECT_ATTEMPTS - 1) {
            rawLastError = incoherent.map((v) => v.message).join(' ');
            console.warn(
              `architectNode: spec is self-inconsistent (attempt ${attempt + 1}/${MAX_ARCHITECT_ATTEMPTS}):`,
              rawLastError
            );
            coherenceFeedback = incoherent;
            continue;
          }
          spec = candidate;
        } else {
          rawLastError = `Spec failed validation: ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')}`;
          console.error(
            `architectNode: variant ${variant.id} spec rejected (attempt ${attempt + 1}/${MAX_ARCHITECT_ATTEMPTS}):`,
            rawLastError
          );
        }
      } catch (e: unknown) {
        hadProviderError = true;
        rawLastError = e instanceof Error ? e.message : String(e);
        // The raw provider error goes to the log ONLY. It was being sliced into
        // the UI, which is how a provider's 400 payload ended up rendered as the
        // agent's own output.
        console.error(
          `architectNode: variant ${variant.id} structured output failed (attempt ${attempt + 1}/${MAX_ARCHITECT_ATTEMPTS}):`,
          rawLastError
        );
      }
    }

    const shortErrorLabel = hadProviderError
      ? 'No valid spec after 3 attempts (provider error).'
      : 'No valid spec after 3 attempts.';

    if (spec) {
      const renderer = createSpecRenderer();
      const tail = renderer.push({ ...(spec as object), __done: true });
      write(config, 'architectNode', {
        t: 'delta',
        text: `\n\n### Variant ${variant.id} - ${variant.name}\n*${variant.idea}*\n\n${spec.sheet}\n\n${tail}`,
      });
    } else {
      write(config, 'architectNode', {
        t: 'delta',
        text: `\n\n### Variant ${variant.id} - ${variant.name}\n*${variant.idea}*\n\n${shortErrorLabel}\n`,
      });
    }

    return {
      id: variant.id,
      name: variant.name,
      idea: variant.idea,
      spec,
      version: version + 1,
      drawnVersion: null,
      review: null,
      retries,
      needsRevision: false,
      error: spec ? undefined : shortErrorLabel,
    };
  }

  async function architectNode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    const conversationMessages: BaseMessage[] = [...state.messages];

    if (state.designContract) {
      const contractDetails = [];
      if (Object.keys(state.designContract.standing).length > 0) {
        contractDetails.push("Standing Constraints:\n" + JSON.stringify(state.designContract.standing, null, 2));
      }
      if (Object.keys(state.designContract.pinnedParams).length > 0) {
        const pins = Object.fromEntries(
          Object.entries(state.designContract.pinnedParams).map(([k, v]) => [k, (v as { value: unknown }).value])
        );
        contractDetails.push("Pinned Parameters (MUST BE EXACTLY THESE VALUES):\n" + JSON.stringify(pins, null, 2));
      }

      if (contractDetails.length > 0) {
        conversationMessages.push(new HumanMessage(
          "Design Contract:\nThe user has pinned these values and constraints; treat them as given.\n\n" + contractDetails.join("\n\n")
        ));
      }
    }

    // The Vercel budget runs from the FIRST entry for a request, before the
    // planner: the planner and the first variant calls are most of the time.
    const enteredAt = Date.now();
    const reviewDeadline = state.reviewDeadline ?? (process.env.VERCEL
      ? enteredAt + Number(process.env.CADAI_SPEC_REVIEW_BUDGET_MS ?? 240000) // 240 s: Vercel maxDuration 300 s minus the drafter's head start
      : null);

    let brief = state.specBrief;
    let variants = [...state.specVariants];
    // A gate revise arrives WITH the chosen variant in state, so it revises that
    // variant (previous sheet, skeleton, image, notes) instead of re-planning.
    const isFresh = variants.length === 0;

    if (isFresh) {
      const plannerSystemMessage = new SystemMessage(CAD_AI_SYSTEM_PROMPT + "\n\n" + ARCHITECT_PLANNER_PREAMBLE);
      const plannerMessages: BaseMessage[] = [plannerSystemMessage, ...conversationMessages];

      if (state.gateAction === 'revise' && state.gateFeedback) {
        plannerMessages.push(new HumanMessage(`The previous Assembly Spec was rejected at human review. Revise it accordingly:\n${state.gateFeedback}`));
      }

      write(config, 'architectNode', {
        t: 'delta',
        text: `Planning up to ${maxVariantsFromEnv(process.env.CADAI_MAX_VARIANTS)} variants...
`,
      });

      const plannerModel = model.withStructuredOutput(ArchitectPlanSchema, {
        name: 'ArchitectPlan',
        strict: true,
        includeRaw: false,
      });

      let plan: z.infer<typeof ArchitectPlanSchema> | null = null;
      let lastPlannerError: string | null = null;

      // THREE attempts, not two. Decoder degeneration is per-attempt and
      // independent, so retries compound: at the ~0.8 per-attempt success rate
      // measured on the bounded schema, two attempts leave a 4% chance of
      // reaching the review gate with no spec at all and three leave under 1%.
      // Two attempts is what let a real run surface an empty approval card.
      for (let attempt = 0; attempt < MAX_ARCHITECT_ATTEMPTS && !plan; attempt++) {
        const attemptMessages = attempt === 0
          ? plannerMessages
          : [
              ...plannerMessages,
              new HumanMessage('Your previous reply did not yield a valid plan. Plan 1-3 structural variants now.'),
            ];

        try {
          // Not streamed: LangChain buffers a zod-parsed structured reply and yields
          // it once, so the brief is written when the planner returns.
          const chunkObj = await plannerModel.withConfig({ tags: ['nostream'] }).invoke(attemptMessages, config);
          const parsedPlan = ArchitectPlanSchema.safeParse(nullsToUndefined(chunkObj));
          if (parsedPlan.success && parsedPlan.data.variants.length > 0) {
            plan = parsedPlan.data;
            if (plan.brief) write(config, 'architectNode', { t: 'delta', text: `${plan.brief}
` });
          } else {
            lastPlannerError = parsedPlan.success
              ? 'Planner response missing variants.'
              : parsedPlan.error.message;
          }
        } catch (e: unknown) {
          lastPlannerError = e instanceof Error ? e.message : String(e);
          // The raw provider error goes to the log ONLY. It was being sliced into
          // the UI, which is how a provider's 400 payload ended up rendered as the
          // agent's own output.
          console.error(`architectNode: planner attempt ${attempt + 1}/${MAX_ARCHITECT_ATTEMPTS} failed:`, lastPlannerError);
        }
      }

      let deduped: { id: VariantId; name: string; idea: string }[];
      if (!plan || !plan.variants || plan.variants.length === 0) {
        write(config, 'architectNode', {
          t: 'delta',
          text: '\nPlanning failed after 3 attempts; speccing a single variant as requested.\n',
        });
        brief = {
          markdown: '',
          assumptions: [],
          openQuestions: [],
          recommendedId: 'A' as VariantId,
        };
        deduped = [
          { id: 'A' as VariantId, name: 'As requested', idea: 'the design the request describes' },
        ];
      } else {
        const { variants: processedVariants, recommendedId } = processPlannerVariants(
          plan.variants,
          plan.recommendedId,
          maxVariantsFromEnv(process.env.CADAI_MAX_VARIANTS)
        );
        deduped = processedVariants;
        brief = {
          markdown: plan.brief || '',
          assumptions: plan.assumptions || [],
          openQuestions: plan.openQuestions || [],
          recommendedId: recommendedId as VariantId,
        };
      }

      const variantSystemMessage = new SystemMessage(CAD_AI_SYSTEM_PROMPT + "\n\n" + ARCHITECT_VARIANT_PREAMBLE);
      const variantBaseMessages: BaseMessage[] = [variantSystemMessage, ...conversationMessages];
      if (state.gateAction === 'revise' && state.gateFeedback) {
        variantBaseMessages.push(new HumanMessage(`The previous Assembly Spec was rejected at human review. Revise it accordingly:\n${state.gateFeedback}`));
      }

      const promises = deduped.map((v) =>
        generateVariantSpec(
          v,
          deduped,
          brief!,
          variantBaseMessages,
          0,
          0,
          undefined,
          undefined,
          state.humanSpecNotes,
          null,
          config
        )
      );
      variants = await Promise.all(promises);

    } else {
      // Revision mode
      const variantSystemMessage = new SystemMessage(CAD_AI_SYSTEM_PROMPT + "\n\n" + ARCHITECT_VARIANT_PREAMBLE);
      const variantBaseMessages: BaseMessage[] = [variantSystemMessage, ...conversationMessages];

      const currentBrief = brief ?? {
        markdown: '',
        assumptions: [],
        openQuestions: [],
        recommendedId: 'A' as VariantId,
      };

      const plannedList = variants.map((v) => ({ id: v.id, name: v.name, idea: v.idea }));

      const promises = variants.map(async (v) => {
        if (!v.needsRevision) return v;

        const findings = [...(v.review?.findings || [])].sort((a, b) =>
          a.severity === 'major' && b.severity !== 'major' ? -1 : 1
        );
        const prevSkeleton = v.spec ? { ...v.spec, sheet: undefined } : undefined;
        const revised = await generateVariantSpec(
          v,
          plannedList,
          currentBrief,
          variantBaseMessages,
          v.version,
          v.retries,
          v.spec ? { sheet: v.spec.sheet, skeleton: prevSkeleton } : undefined,
          findings,
          state.humanSpecNotes,
          drawnSheetSvg(v),
          config
        );
        if (revised.spec === null && v.spec) {
          // Label, don't drop: the last good spec stays and the card says so.
          return {
            ...v,
            needsRevision: false,
            error: undefined,
            review: {
              validated: false,
              findings: [],
              attempts: v.retries + 1,
              ...v.review,
              note: `revision failed; showing version ${v.version}`,
            },
          };
        }
        return revised;
      });
      variants = await Promise.all(promises);
    }

    if (process.env.CADAI_SPEC_SHEETS !== 'off' && !isVisionModel(selectedModel)) {
      write(config, 'architectNode', {
        t: 'delta',
        text: '\nConcept sheets skipped: model does not support vision.\n',
      });
    }

    const recommended = recommendedVariant(variants, brief);
    const assemblySpec = recommended?.spec ? mergeBriefIntoSpec(recommended.spec, brief) : null;
    const explanation = assemblySpec ? summarizeSpec(assemblySpec) : NO_SPEC_EXPLANATION;

    return {
      specBrief: brief,
      specVariants: variants,
      reviewDeadline,
      roundStartedAt: isFresh ? null : enteredAt,
      assemblySpec,
      explanation,
      // Deliberately contributes NOTHING to `messages`. The spec already
      // reaches both consumers through their own prompts (drafterPrompt and
      // fixPrompt), and `messages` is a concat reducer, so appending here made
      // a revise loop stack two or three contradictory specs into the drafter's
      // context with nothing marking which one was live. `assemblySpec` is the
      // single source of truth; `explanation` carries the human-readable copy.
      //
      // Consumed above, so cleared: leaving these set let one gate's feedback
      // reappear at a later node as if the human had just said it.
      gateAction: null,
      gateFeedback: null,
    };
  }

  // Node: specIllustrator
  async function specIllustrator(
    state: AgentStateType,
    config?: RunnableConfig
  ): Promise<Partial<AgentStateType>> {
    const variants = [...(state.specVariants || [])];
    const updatedVariants = await Promise.all(
      variants.map(async (v) => {
        if (v.spec === null || v.drawnVersion === v.version) {
          return v;
        }
        try {
          // Drawn here to prove it can be (and for the transcript); state keeps
          // only the version, and every consumer redraws the identical sheet.
          const result = drawSheet(v);
          const compCount = v.spec.components?.length ?? 0;
          const guideCount = v.spec.guides?.length ?? 0;
          let text = `Sheet ${v.id} drawn: ${compCount} part${compCount === 1 ? '' : 's'}, ${guideCount} guide${guideCount === 1 ? '' : 's'}`;
          if (result.skipped && result.skipped.length > 0) {
            text += `, ${result.skipped
              .map((s) =>
                isStandIn(s.reason)
                  ? `${s.name} drawn as a box: ${s.reason.replace(/;?\s*drawn as a box$/, '')}`
                  : `${s.name} not drawn: ${s.reason}`
              )
              .join(', ')}`;
          }
          write(config, 'specIllustrator', { t: 'delta', text: text + '\n' });
          return {
            ...v,
            drawnVersion: v.version,
          };
        } catch (e) {
          console.error(`specIllustrator: failed to draw sheet for variant ${v.id}:`, e);
          write(config, 'specIllustrator', {
            t: 'delta',
            text: `Sheet ${v.id}: drawing failed\n`,
          });
          return {
            ...v,
            drawnVersion: null,
            review: {
              validated: false,
              findings: [],
              attempts: 0,
              note: 'sheet could not be drawn',
            },
          };
        }
      })
    );

    return {
      specVariants: updatedVariants,
    };
  }

  // Node: specReviewer
  async function specReviewer(
    state: AgentStateType,
    config?: RunnableConfig
  ): Promise<Partial<AgentStateType>> {
    const maxRetries = Number(process.env.CADAI_SPEC_REVIEW_RETRIES ?? 5);
    const deadline = state.reviewDeadline;
    const now = Date.now();
    // Another round is allowed only if it can finish inside the budget, judged by
    // the last round's measured duration (90 s until one has been measured).
    const estimatedRoundMs = state.lastRoundMs ?? 90000; // 90 s: typical architect revision + sheet + review
    const deadlineExpired = deadline !== null && now + estimatedRoundMs >= deadline;
    const lastRoundMs = state.roundStartedAt !== null ? now - state.roundStartedAt : state.lastRoundMs;

    const request = latestHumanText(state.messages) || 'the user request above';
    const contract = contractLines(state.designContract);
    const reviewerModel = model
      .withStructuredOutput(SheetReviewSchema)
      .withConfig({ tags: ['nostream'] });

    const reviewerSystem = new SystemMessage(SHEET_REVIEWER_PREAMBLE);

    const updatedVariants = await Promise.all(
      (state.specVariants || []).map(async (v) => {
        if (!v.spec || v.drawnVersion === null || v.drawnVersion !== v.version || v.review !== null) {
          return v;
        }

        const attempts = v.retries + 1;
        let pngDataUrl: string;
        try {
          pngDataUrl = await svgToPngDataUrl(drawSheet(v).svg);
        } catch (e) {
          console.error(`specReviewer: failed to rasterize sheet for variant ${v.id}:`, e);
          const reviewObj: VariantReview = {
            validated: false,
            findings: [],
            attempts,
            note: 'review unavailable',
          };
          write(config, 'specReviewer', {
            t: 'delta',
            text: `Sheet ${v.id}: not validated after ${reviewObj.attempts} attempt${reviewObj.attempts === 1 ? '' : 's'}\n`,
          });
          return {
            ...v,
            review: reviewObj,
          };
        }

        const skel = skeletonSummary(v.spec);
        const humanNotes = (state.humanSpecNotes ?? []).length
          ? `Human notes:\n${(state.humanSpecNotes ?? []).join('\n')}\n\n`
          : '';

        const promptText =
          `The user asked for:\n"${request}"\n\n` +
          humanNotes +
          (contract ? `${contract}\n\n` : '') +
          `Variant ${v.id}: ${v.name}\nIdea: ${v.idea}\n\n` +
          (v.spec?.sheet ? `Design Sheet:\n${v.spec.sheet}\n\n` : '') +
          (skel ? `Skeleton:\n${skel}\n\n` : '') +
          `Evaluate whether this concept sheet matches the request.`;

        const content: Array<Record<string, unknown>> = [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: pngDataUrl } },
        ];

        let reviewResult: z.infer<typeof SheetReviewSchema> | null = null;
        try {
          reviewResult = (await reviewerModel.invoke(
            [reviewerSystem, new HumanMessage({ content: content as never })],
            config
          )) as z.infer<typeof SheetReviewSchema>;
        } catch (e) {
          console.error(`specReviewer: model review call failed for variant ${v.id}:`, e);
          const reviewObj: VariantReview = {
            validated: false,
            findings: [],
            attempts,
            note: 'review unavailable',
          };
          write(config, 'specReviewer', {
            t: 'delta',
            text: `Sheet ${v.id}: not validated after ${reviewObj.attempts} attempt${reviewObj.attempts === 1 ? '' : 's'}\n`,
          });
          return {
            ...v,
            review: reviewObj,
          };
        }

        const hasMajor = reviewResult.findings.some((f) => f.severity === 'major');
        const validated = Boolean(reviewResult.matchesRequest && !hasMajor);
        const reviewObj: VariantReview = {
          validated,
          findings: reviewResult.findings,
          attempts,
        };

        const canRetry = hasMajor && v.retries < maxRetries && !deadlineExpired;
        const nextRetries = canRetry ? v.retries + 1 : v.retries;

        if (validated) {
          write(config, 'specReviewer', { t: 'delta', text: `Sheet ${v.id}: validated\n` });
          for (const f of reviewObj.findings) {
            write(config, 'specReviewer', { t: 'delta', text: `  - [${f.severity}] ${f.issue}\n` });
          }
        } else if (canRetry) {
          const majorCount = reviewObj.findings.filter((f) => f.severity === 'major').length;
          write(config, 'specReviewer', {
            t: 'delta',
            text: `Sheet ${v.id}: ${majorCount} major finding${majorCount === 1 ? '' : 's'} -> revising (retry ${nextRetries}/${maxRetries})\n`,
          });
          for (const f of reviewObj.findings) {
            write(config, 'specReviewer', { t: 'delta', text: `  - [${f.severity}] ${f.issue}\n` });
          }
        } else {
          write(config, 'specReviewer', {
            t: 'delta',
            text: `Sheet ${v.id}: not validated after ${attempts} attempt${attempts === 1 ? '' : 's'}\n`,
          });
          for (const f of reviewObj.findings) {
            write(config, 'specReviewer', { t: 'delta', text: `  - [${f.severity}] ${f.issue}\n` });
          }
        }

        return {
          ...v,
          review: reviewObj,
          retries: nextRetries,
          needsRevision: canRetry,
        };
      })
    );

    return {
      specVariants: updatedVariants,
      roundStartedAt: null,
      lastRoundMs,
    };
  }

  async function drafterNode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    // A missing spec degrades to unconstrained drafting rather than skipping the
    // draft entirely - an empty script gives the repair loop nothing to work with.
    const contract = contractLines(state.designContract);

    const drafterSystem =
      CAD_AI_SYSTEM_PROMPT +
      '\n\n' +
      DRAFTER_PREAMBLE +
      (specHasComponents(state.assemblySpec) ? '\n\n' + DRAFTER_PLACEMENT_CONTRACT : '');

    // The approved variant, found by the id the gate recorded and by nothing
    // else: matching on name or on the recommendation picked the wrong sheet.
    const chosenVariant = state.chosenVariantId
      ? state.specVariants?.find((v) => v.id === state.chosenVariantId)
      : undefined;

    let drafterHumanMessage: HumanMessage;
    if (state.assemblySpec) {
      const { sheet, ...skeleton } = state.assemblySpec;
      const guidesText = state.assemblySpec.guides?.length
        ? `\n\nGuides (context only - never model these):\n${state.assemblySpec.guides.map((g) => `- [${g.kind}] ${g.label}`).join('\n')}`
        : '';

      const reviewFindingsText =
        chosenVariant?.review && !chosenVariant.review.validated && chosenVariant.review.findings.length > 0
          ? `\n\nOpen review findings:\n${chosenVariant.review.findings.map((f) => `- [${f.severity}] ${f.issue}`).join('\n')}`
          : '';

      const blockout = blockoutScad(state.assemblySpec);
      const placeholdersText = blockout.skipped.length
        ? `\n\nPlaceholders - build these from the skeleton, not from the starting script:\n${blockout.skipped
            .map((p) => `- ${p.name}: ${isStandIn(p.reason) ? `a plain box stands in (${p.reason.replace(/;?\s*drawn as a box$/, '')})` : `not in the starting script (${p.reason})`}`)
            .join('\n')}`
        : '';
      const startingScriptText =
        process.env.CADAI_DRAFTER_START !== 'scratch'
          ? `\n\nStarting script:\nThis starting script has a module for each component that could be drawn, with its base shape and declared holes (except the placeholders listed above). Keep each module's base dimensions; add the features the sheet names; do not add top-level placement.\n\`\`\`openscad\n${blockout.code}\n\`\`\``
          : '';

      const promptText = `Implement the Architect Spec below as one complete OpenSCAD script. Honour every field: each stressPoint mitigation built exactly as sized, joints at their declared clearance, every edge sharp.

Architect Spec Sheet:
${sheet}

Architect Skeleton (JSON):
${JSON.stringify(skeleton, null, 2)}
${contract}${guidesText}${reviewFindingsText}${placeholdersText}${startingScriptText}`;

      let pngDataUrl: string | null = null;
      const chosenSheetSvg = chosenVariant ? drawnSheetSvg(chosenVariant) : null;
      if (chosenSheetSvg && isVisionModel(selectedModel)) {
        try {
          pngDataUrl = await svgToPngDataUrl(chosenSheetSvg);
        } catch (e) {
          console.warn('drafterNode: failed to rasterize concept sheet for drafter', e);
        }
      }

      if (pngDataUrl) {
        const content: Array<Record<string, unknown>> = [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: pngDataUrl } },
        ];
        drafterHumanMessage = new HumanMessage({ content: content as never });
      } else {
        drafterHumanMessage = new HumanMessage(promptText);
      }
    } else {
      const promptText = `Write one complete OpenSCAD script for the user's request above. No Architect Spec is available: derive the sizes yourself and declare them as parameters, choose a bedFace and lay it on z = 0, and the stress-point mitigations the part needs, naming them in your rationale; every edge stays sharp.
${contract}`;
      drafterHumanMessage = new HumanMessage(promptText);
    }

    const messages: BaseMessage[] = [
      new SystemMessage(drafterSystem),
      ...state.messages,
      drafterHumanMessage,
    ];

    let response = await drafterModel.invoke(messages, config);

    // Handle tool execution loop if the model requests engineering modules
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolCallMessages: BaseMessage[] = [response];

      for (const toolCall of response.tool_calls) {
        if (toolCall.name === 'get_functional_cad_module') {



          // Pass `config` so the tool run is parented to this node's span.
          // Without it the retrieval is invisible to tracing (or shows up as a
          // detached root trace), which is exactly the step you need to see
          // when a draft comes back with the wrong hardware module.
          const toolResult = await getFunctionalCadModuleTool.invoke(toolCall.args as any, config);
          toolCallMessages.push(
            new ToolMessage({
              tool_call_id: toolCall.id || `tool-${Date.now()}`,
              name: toolCall.name,
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            })
          );
        }
      }


      // Synthesize final code with tool observations
      response = await model.invoke([...messages, ...toolCallMessages], config);
    }

    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const extracted = extractOpenScadCode(content);
    const placed = await placeAssembly(extracted.code || '', state.assemblySpec);

    return {
      currentCode: placed.code,
      placementReport: placed.report,
      explanation: state.explanation + "\n\n" + content,
      attemptCount: 1,
      messages: [new AIMessage(content)],
      failureKind: extracted.error === 'truncated' ? 'truncated' : extracted.error === 'no_code' ? 'no_code' : 'none',
      // Reached here either straight from an approved gate, or from a revise
      // whose budget ran out. Either way the decision is spent: carrying it
      // further would resurface spec feedback inside fixCode's repair prompt,
      // mislabelled as a comment about the compiled geometry.
      gateAction: null,
      gateFeedback: null,
      specVariants: [],
      specBrief: null,
      chosenVariantId: null,
    };
  }

  // Node 3: validateCode
  async function validateCode(state: AgentStateType): Promise<Partial<AgentStateType>> {


    if (state.failureKind === 'truncated' || state.failureKind === 'no_code') {
       return { 
         isValid: false, 
         attemptHistory: [{n: state.attemptCount, phase: state.attemptCount === 1 ? 'draft' : 'repair', code: state.currentCode, exitCode: 1, errors: [], warnings: [], violations: [], diagnosis: state.failureKind}] 
       };
    }

    if (!state.currentCode) {
      return {
        isValid: false,
        failureKind: 'no_code',
      };
    }

    const validation = await validateOpenScadCode(state.currentCode);
    
    // Measure whenever OpenSCAD emitted a mesh at all - including the silent
    // corruption case, where the compile "succeeds" but the solid is wrong.
    // The audit needs those numbers to spot the discrepancy.
    let modelInfo: ModelInfo | null = null;
    if (validation.stl && validation.stl.includes('facet normal')) {
      modelInfo = analyzeStl(validation.stl);
      modelInfo.isManifold = validation.isManifold;
      modelInfo.shellCount = validation.shellCount;
      modelInfo.compileTimeMs = validation.compileTimeMs;

      // Prefer OpenSCAD's own bounding box over the mesh-derived one. analyzeStl
      // measures the tessellated STL and rounds to 2dp, so a curved surface
      // reads slightly under its true extent - and that error lands directly in
      // the bbox audit, which tightens to a 1.0mm tolerance once a human
      // approves the spec. The kernel box was already parsed and then only ever
      // read by tests.
      const kb = validation.summary?.boundingBox;
      if (kb && kb.size.every((n) => Number.isFinite(n))) {
        modelInfo.dimensions = { x: kb.size[0], y: kb.size[1], z: kb.size[2] };
        modelInfo.boundingBox = { min: [...kb.min], max: [...kb.max] };
      }
    }

    const specViolations = auditSpec(state.assemblySpec, modelInfo, validation, state.currentCode, state.designContract ?? undefined);

    // Spec-internal coherence. Already reported at the gate, but a revised spec
    // or a spec that skipped the gate has never been through it, and a repair
    // prompt that never sees the contradiction cannot resolve it.
    specViolations.push(...auditSpecCoherence(state.assemblySpec));
    specViolations.push(...auditSpecShapes(state.assemblySpec));

    // Handedness: static, because a mirrored part measures identically to the
    // one the spec asked for and no geometric check can separate them.
    specViolations.push(...auditModuleGuards(state.currentCode, state.assemblySpec));

    // Placement was measured and composed before this compile (placeAssembly);
    // here it is only audited against the compiled model's bounding box.
    const placementReport = state.placementReport ?? null;
    const modelMin = validation.summary?.boundingBox?.min ?? modelInfo?.boundingBox.min ?? null;
    specViolations.push(...auditPlacement(placementReport, modelMin, state.assemblySpec));
    if (modelMin) {

    }

    // Assembly fit. Only possible now that jointContracts name the components
    // they join and those components have placements - checkInterference needs
    // real instantiation strings, which is exactly why this could not be wired
    // in before. Runs only on a clean compile: two parts cannot be tested for
    // overlap if the script never produced a solid.
    if (validation.valid) {
      specViolations.push(
        ...(await checkAssemblyFit(state.currentCode, state.assemblySpec, framesFromReport(placementReport)))
      );
      // Declared holes, probed in each module's own local frame. Like the
      // interference probe this needs a solid to ask questions of, so it only
      // runs on a clean compile.
      specViolations.push(
        ...(await auditHoles(stripGeneratedAssembly(state.currentCode), state.assemblySpec, framesFromReport(placementReport)))
      );
    }

    const isSemanticValid = specViolations.filter(v => v.severity === 'error').length === 0;
    const isValid = validation.valid && isSemanticValid;

    const attempt: AttemptRecord = {
      n: state.attemptCount,
      phase: state.attemptCount === 1 ? 'draft' : 'repair',
      code: state.currentCode,
      exitCode: validation.exitCode,
      errors: validation.errors,
      warnings: validation.warnings,
      measured: modelInfo ? {
         dimensions: modelInfo.dimensions,
         volumeMm3: modelInfo.volumeMm3,
         isManifold: modelInfo.isManifold,
         shellCount: modelInfo.shellCount,
         bottomAreaMm2: modelInfo.bottomAreaMm2,
         isFlatPackable: modelInfo.isFlatPackable,
         overhang: modelInfo.overhang,
      } : undefined,
      violations: specViolations,
      diagnosis: 'TBD',
    };

    let validationMsgStr = `Validation Result: ${isValid ? 'Success' : 'Failed'}\n`;
    if (!validation.valid) {
      validationMsgStr += `Compiler Exit Code: ${validation.exitCode}\n`;
      if (validation.errors.length > 0) {
        validationMsgStr += `Errors:\n${validation.errors.map(e => `- Line ${e.line}: ${e.message}`).join('\n')}\n`;
      }
    }
    if (specViolations.length > 0) {
      validationMsgStr += `Violations:\n${specViolations.map(v => `- ${v.severity.toUpperCase()} [${v.kind}]: ${v.message}`).join('\n')}\n`;
    }

    return {
      isValid,
      // Keep the mesh even when the audit rejects it, so the user still sees
      // what was built while the agent repairs it.
      stlContent: validation.stl ?? null,
      validation,
      modelInfo: modelInfo ?? state.modelInfo,
      specViolations,
      placementReport,
      attemptHistory: [attempt],
      failureKind: !validation.valid ? 'compile' : !isSemanticValid ? 'semantic' : 'none',
      // Count each class separately so neither can starve the other's budget.
      compileFailures: !validation.valid ? state.compileFailures + 1 : state.compileFailures,
      semanticFailures:
        validation.valid && !isSemanticValid ? state.semanticFailures + 1 : state.semanticFailures,
      // Never accumulate a SystemMessage into `messages`: every node prepends
      // its own fresh SystemMessage ahead of this history, so a second
      // system-role message mid-history is at best redundant and at worst
      // rejected outright - the Google client used to 400 on any system role
      // past index 0. Frame the validation report as environment feedback
      // instead - there's no tool_call_id to hang a ToolMessage off, so
      // HumanMessage is the idiomatic accumulated-history role.
      messages: [new HumanMessage(`[Validation Report]\n${validationMsgStr}`)],
    };
  }

  // Node 4: fixCode
  async function fixCode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    const currentAttempt = state.attemptCount + 1;
    const fixModel = model.bindTools([getFunctionalCadModuleTool]);


    const attemptsContext = state.attemptHistory
      .slice(-2)
      .map((a) => {
        const m = a.measured;
        // Only the geometry the repair node can act on. Overhang and
        // unsupported area used to ride along here and were pure noise: they
        // describe a fabrication process this pipeline does not model, and
        // handing them to a repair prompt invited the model to reshape a part
        // that was merely mis-dimensioned. Bottom area stays because a solid
        // that barely touches z = 0 is a placement fault, stated as geometry.
        const resting =
          m?.bottomAreaMm2 !== undefined
            ? `, bottom area ${m.bottomAreaMm2}mm2 (${m.isFlatPackable ? 'rests on a flat face at z = 0' : 'NO flat face on z = 0'})`
            : '';
        const measured = m
          ? `Measured: ${m.dimensions.x} x ${m.dimensions.y} x ${m.dimensions.z} mm, volume ${m.volumeMm3}mm3, manifold=${m.isManifold ?? 'unknown'}, shells=${m.shellCount ?? 'unknown'}${resting}`
          : 'Measured: no geometry produced';
        const errs = a.errors
          .slice(0, 5)
          .map((e) => `  - ${e.line !== undefined ? `line ${e.line}: ` : ''}${e.message}`)
          .join('\n');
        const warns = a.warnings
          .slice(0, 5)
          .map((w) => `  - ${w.line !== undefined ? `line ${w.line}: ` : ''}${w.message}`)
          .join('\n');
        const viols = a.violations
          .map(
            (v) =>
              `  - [${v.kind}] ${v.message}${v.deltaMm !== undefined ? ` (delta ${v.deltaMm}mm)` : ''}`
          )
          .join('\n');
        return [
          `Attempt ${a.n} (${a.phase}), exit code ${a.exitCode}`,
          measured,
          errs ? `Compiler errors:\n${errs}` : '',
          warns ? `Compiler warnings:\n${warns}` : '',
          viols ? `Spec violations:\n${viols}` : '',
          a.diagnosis && a.diagnosis !== 'TBD'
            ? `Already tried: ${a.diagnosis.slice(0, 400)}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');

    // A human explicitly asked for another pass at the accept gate; that
    // feedback is the most important thing in this prompt when present.
    const humanRevision =
      state.gateAction === 'revise' && state.gateFeedback
        ? `\nThe user reviewed this model and asked for changes:\n${state.gateFeedback}\n`
        : '';

    // One prompt for both failure classes made the model infer its own mode
    // from whichever sections happened to be populated. Name the mode instead:
    // a compile failure and a compiles-but-wrong-shape failure call for
    // completely different work.
    // The semantic class is broad, so lead with the one violation that matters
    // most: "fix the arithmetic" is right for a bbox miss and wrong for an
    // undeclared identifier or two parts interpenetrating.
    const dominant = dominantViolationKind(state.specViolations);
    const hint = dominant ? REPAIR_HINTS[dominant] : undefined;
    const failureHeader =
      state.failureKind === 'semantic'
        ? `The OpenSCAD code COMPILED SUCCESSFULLY but the resulting solid does not match the Assembly Spec. This is a GEOMETRY error, not a syntax error - the script is valid, so do not "fix" syntax. Work from the measured numbers below.${hint ? ` Lead with the [${dominant}] violation: ${hint}` : ''}`
        : state.failureKind === 'truncated' || state.failureKind === 'no_code'
          ? `The previous reply did not contain a complete OpenSCAD script. Emit the entire script this time, in one closed block, code before commentary.`
          : `The OpenSCAD code FAILED TO COMPILE. Fix the compilation error first; the diagnostics below name the line. Do not restructure geometry that already worked.`;

    const fixPrompt = `${failureHeader}
Previous Attempts:
${attemptsContext}

Current Broken Code:
\`\`\`openscad
${stripGeneratedAssembly(state.currentCode)}
\`\`\`
${humanRevision}
${state.assemblySpec ? `Assembly Spec (every stressPoint mitigation in it is mandatory; edges stay sharp):\n${state.assemblySpec.sheet ? `Design Sheet:\n${state.assemblySpec.sheet}\n\n` : ''}${JSON.stringify(state.assemblySpec, null, 2)}\n` : ''}${contractLines(state.designContract)}
Reply with the FIX: line, then the COMPLETE fixed script in a single \`\`\`openscad ... \`\`\` block.`;

    const fixMessages = [
      new SystemMessage(CAD_AI_SYSTEM_PROMPT + "\n\n" + REPAIR_PREAMBLE),
      ...state.messages,
      new HumanMessage(fixPrompt),
    ];

    let response = await fixModel.invoke(fixMessages, config);
    
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolCallMessages: BaseMessage[] = [response];

      for (const toolCall of response.tool_calls) {
        if (toolCall.name === 'get_functional_cad_module') {



          // Pass `config` so the tool run is parented to this node's span.
          // Without it the retrieval is invisible to tracing (or shows up as a
          // detached root trace), which is exactly the step you need to see
          // when a draft comes back with the wrong hardware module.
          const toolResult = await getFunctionalCadModuleTool.invoke(toolCall.args as any, config);
          toolCallMessages.push(
            new ToolMessage({
              tool_call_id: toolCall.id || `tool-${Date.now()}`,
              name: toolCall.name,
              content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            })
          );
        }
      }


      response = await model.invoke([...fixMessages, ...toolCallMessages], config);
    }
    
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const extracted = extractOpenScadCode(content);

    // Patch only the attempt being repaired. The merge-by-n reducer applies it
    // in place; returning the whole array would re-append the entire history.
    const last = state.attemptHistory[state.attemptHistory.length - 1];
    const patchedHistory = last ? [{ ...last, diagnosis: content }] : [];

    // Re-measure and re-compose: the repair model was shown the modules with
    // the generated block stripped, so placement stays driven by the spec.
    const repaired = extracted.code ? await placeAssembly(extracted.code, state.assemblySpec) : null;

    return {
      // Re-compose: the repair model was shown the modules with the generated
      // block stripped, so placement stays driven by the spec across repairs
      // instead of silently reverting to whatever the repair happened to write.
      currentCode: repaired ? repaired.code : state.currentCode,
      placementReport: repaired ? repaired.report : state.placementReport,
      explanation: state.explanation + "\n\n" + content,
      attemptCount: currentAttempt,
      messages: [new AIMessage(content)],
      attemptHistory: patchedHistory,
      failureKind: extracted.error === 'truncated' ? 'truncated' : extracted.error === 'no_code' ? 'no_code' : 'none',
      // The human's revise note has now been folded into fixPrompt above; it
      // must not survive into the next repair round, where the model would
      // read it as fresh feedback on code the human never saw.
      gateAction: null,
      gateFeedback: null,
    };
  }

  /**
   * Node: visualCritic. The only step in the pipeline that LOOKS at the part.
   *
   * Runs once per run, and only on geometry that already compiled and passed
   * every deterministic check - there is nothing to see in a part that failed
   * to compile, and the compiler diagnostic is a better signal than a picture.
   *
   * Findings are always WARNINGS. `isSemanticValid` counts only errors, so a
   * critique can never invalidate a model or trigger an automatic repair: it
   * opens the accept gate (shouldGateAccept fires on any violation), where the
   * human sees the rendered part alongside the concern and decides whether to
   * send it back. Handing an automatic repair loop to a model's opinion of a
   * low-detail render is how you get a good part spiralled into a bad one.
   */
  async function visualCritic(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    if (process.env.CADAI_VISUAL_CRITIC !== 'on') return {};
    if (!state.stlContent) return {};

    let views: RenderedView[];
    try {
      views = renderStlViews(state.stlContent);
    } catch (e) {
      // A rasterizer failure must never take down a run whose geometry is
      // otherwise fine - this whole node is advisory.
      console.warn('Visual critic: render failed', e);
      return {};
    }
    if (views.length === 0) return {};


    const request = latestHumanText(state.messages) || 'the user request above';
    const specText = criticSpecSummary(state.assemblySpec);
    const bedFaces = (state.assemblySpec?.components ?? [])
      .filter((c) => c.bedFace)
      .map((c) => `${c.name} on ${c.bedFace}`);
    const postureText = bedFaces.length
      ? ` The part should rest on its declared bed face (${bedFaces.join(', ')}); check the print posture against that.`
      : '';

    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text:
          `The user asked for:\n"${request}"${specText}\n\n` +
          `Here are ${views.length} renders of the compiled part (${views
            .map((v) => v.name)
            .join(', ')}). Does the geometry match the request?${postureText}`,
      },
    ];
    for (const view of views) {
      content.push({ type: 'text', text: `View: ${view.name}` });
      content.push({ type: 'image_url', image_url: { url: view.dataUrl } });
    }

    let critique: VisualCritique | null = null;
    try {
      critique = (await criticModel
        .withStructuredOutput(VisualCritiqueSchema)
        .invoke(
          [
            new SystemMessage(CAD_AI_SYSTEM_PROMPT + '\n\n' + CRITIC_PREAMBLE),
            new HumanMessage({ content: content as never }),
          ],
          config
        )) as VisualCritique;
    } catch (e) {
      console.warn('Visual critic: model call failed', e);
      return {};
    }

    const findings = critique?.findings ?? [];
    if (findings.length === 0) return {};

    const criticViolations: SpecViolation[] = findings.map((f) => ({
      kind: 'visual',
      field: f.view ?? 'geometry',
      expected: 'geometry matching the request',
      measured: f.issue,
      severity: 'warning',
      message: `${f.issue}${f.view ? ` (seen in the ${f.view} view)` : ''}`,
    }));

    return { specViolations: [...state.specViolations, ...criticViolations] };
  }

  // Node 5: respondToUser
  async function respondToUser(state: AgentStateType, config?: LangGraphRunnableConfig): Promise<Partial<AgentStateType>> {
    const summary = composeRunSummary({
      spec: state.assemblySpec,
      modelInfo: state.modelInfo,
      violations: state.specViolations,
      attempts: state.attemptCount,
      isValid: state.isValid,
    });

    write(config, 'respondToUser', {
      t: 'result',
      summary,
      code: state.currentCode || undefined,
      stl: state.stlContent || undefined,
      designContract: state.designContract ?? undefined,
    });

    return {};
  }

  // Node: specGate. Pauses the run and hands the client the Architect's spec
  // to review/edit. `interrupt()` both emits the payload (surfaced by the
  // caller via isInterrupted()/INTERRUPT on the invoke() result) and, on
  // resume, returns exactly the value passed to Command({ resume }) - there is
  // no other channel between the paused graph and the human's decision.
  async function specGate(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    let variants: GateVariant[] = (state.specVariants || []).map((v) => ({
      id: v.id,
      name: v.name,
      idea: v.idea,
      spec: v.spec,
      sheetSvg: drawnSheetSvg(v),
      review: v.review,
      ...(v.error ? { error: v.error } : {}),
    }));
    if (variants.length === 0 && state.assemblySpec) {
      variants = [
        {
          id: 'A',
          name: state.assemblySpec.assemblyName,
          idea: '',
          spec: state.assemblySpec,
          sheetSvg: null,
          review: null,
        },
      ];
    }
    const payload: GatePayload = {
      kind: 'spec',
      brief: state.specBrief?.markdown ?? '',
      variants,
      recommendedId: state.specBrief?.recommendedId ?? 'A',
      openQuestions: state.specBrief?.openQuestions ?? state.assemblySpec?.openQuestions ?? [],
      contract: state.designContract,
      revisionCount: state.specRevisionCount,
      spec: state.assemblySpec,
    };
    const decision = interrupt(payload) as GateDecision;

    if (decision.action === 'cancel') {
      return { gateAction: 'cancel' };
    }

    // A revise beyond the cap is spent: the chosen variant is built as it stands
    // (checkReviseRoute would otherwise send the drafter a mismatched spec).
    const overCap = decision.action === 'revise' && state.specRevisionCount + 1 > MAX_SPEC_REVISIONS;
    if (overCap) {
      write(config, 'specGate', {
        t: 'delta',
        text: 'Revision limit reached; building the chosen variant as it stands (your last comment was not applied).\n',
      });
    }

    if (decision.action === 'revise' && !overCap) {
      const recId = state.specBrief?.recommendedId ?? 'A';
      const chosenId = decision.chosenVariantId ?? recId;
      let chosenVariant = (state.specVariants || []).find((v) => v.id === chosenId);
      if (!chosenVariant && (state.specVariants || []).length > 0) {
        chosenVariant = (state.specVariants || []).find((v) => v.id === recId) ?? state.specVariants[0];
      }
      if (!chosenVariant && state.assemblySpec) {
        chosenVariant = {
          id: 'A',
          name: state.assemblySpec.assemblyName,
          idea: '',
          spec: state.assemblySpec,
          version: 1,
          drawnVersion: null,
          review: null,
          retries: 0,
          needsRevision: true,
        };
      }
      const updatedVariants: SpecVariant[] = chosenVariant
        ? [{ ...chosenVariant, needsRevision: true, retries: 0, review: null }]
        : [];

      const allQuestions = [
        ...(state.specBrief?.openQuestions ?? []),
        ...(state.assemblySpec?.openQuestions ?? []),
        ...(state.specVariants ?? []).flatMap((v) => v.spec?.openQuestions ?? []),
      ];
      const byId = new Map(allQuestions.map((q) => [q.id, q.question]));
      const answerNoteLines: string[] = [];
      if (decision.answers) {
        for (const [id, answer] of Object.entries(decision.answers)) {
          const text = answer?.trim();
          if (text) {
            const qText = byId.get(id);
            answerNoteLines.push(qText ? `${qText}: ${text}` : `${id}: ${text}`);
          }
        }
      }

      const newNotes = [...(state.humanSpecNotes ?? [])];
      if (decision.comment?.trim()) {
        newNotes.push(decision.comment.trim());
      }
      newNotes.push(...answerNoteLines);

      const feedbackParts = [decision.comment?.trim(), ...answerNoteLines].filter(Boolean);
      const gateFeedback = feedbackParts.join('\n') || 'The user requested changes.';

      return {
        gateAction: 'revise',
        gateFeedback,
        specVariants: updatedVariants,
        // Only the chosen variant remains, so it is the recommendation now.
        specBrief: state.specBrief && updatedVariants[0]
          ? { ...state.specBrief, recommendedId: updatedVariants[0].id }
          : state.specBrief,
        humanSpecNotes: newNotes,
        reviewDeadline: null,
        specRevisionCount: state.specRevisionCount + 1,
      };
    }

    // Approve.
    const recId = state.specBrief?.recommendedId ?? 'A';
    const chosenId = decision.chosenVariantId ?? recId;
    let chosenVariant = (state.specVariants || []).find((v) => v.id === chosenId);
    if (!chosenVariant) {
      chosenVariant = (state.specVariants || []).find((v) => v.id === recId);
    }
    const recVariant = (state.specVariants || []).find((v) => v.id === recId);

    let chosenSpec = chosenVariant?.spec ?? null;
    let approvedVariant = chosenVariant;
    if (!chosenSpec && recVariant?.spec) {
      write(config, 'specGate', {
        t: 'delta',
        text: `Chosen variant ${chosenId} has no spec; falling back to recommended variant ${recId}.\n`,
      });
      chosenSpec = recVariant.spec;
      approvedVariant = recVariant;
    }

    // Only RAW variant specs get the brief merged in. state.assemblySpec already
    // carries it, so merging that one again duplicated assumptions and questions.
    let baseApproved = chosenSpec;
    let alreadyMerged = false;
    if (!baseApproved && state.assemblySpec) {
      write(config, 'specGate', {
        t: 'delta',
        text: 'No variant spec to approve; using the spec the architect last produced.\n',
      });
      baseApproved = state.assemblySpec;
      alreadyMerged = true;
    }
    if (decision.spec) {
      const parsed = AssemblySpecSchema.safeParse(decision.spec);
      if (parsed.success) {
        baseApproved = normalizeSpec(parsed.data);
        alreadyMerged = false;
      }
    }
    let approvedSpec = baseApproved
      ? alreadyMerged
        ? baseApproved
        : mergeBriefIntoSpec(baseApproved, state.specBrief)
      : null;

    if (approvedSpec && decision.answers) {
      const answered = new Set(
        (approvedSpec.openQuestions ?? [])
          .filter((q) => decision.answers?.[q.id]?.trim())
          .map((q) => q.id)
      );
      if (answered.size > 0) {
        approvedSpec = {
          ...approvedSpec,
          assumptions: [
            ...(approvedSpec.assumptions ?? []),
            ...(approvedSpec.openQuestions ?? [])
              .filter((q) => answered.has(q.id))
              .map((q) => ({
                field: q.question,
                value: decision.answers![q.id].trim(),
                rationale: 'Answered by the user at the spec gate.',
              })),
          ],
          openQuestions: (approvedSpec.openQuestions ?? []).filter((q) => !answered.has(q.id)),
        };
      }
    }

    const stampedSpec = approvedSpec ? { ...approvedSpec, specApprovedAt: Date.now() } : approvedSpec;
    const baseContract: DesignContract = state.designContract ?? { standing: {}, pinnedParams: {} };
    const updatedContract: DesignContract = {
      ...baseContract,
      spec: stampedSpec ?? undefined,
      specApprovedAt: Date.now(),
    };

    return {
      gateAction: 'approve',
      chosenVariantId: approvedVariant?.id ?? null,
      assemblySpec: stampedSpec,
      designContract: updatedContract,
    };
  }

  // Node: acceptGate. Pauses after a compile that needed a repair, or that
  // still carries surviving spec violations, so the human signs off before
  // the model is declared final.
  async function acceptGate(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const payload: GatePayload = {
      kind: 'accept',
      modelInfo: state.modelInfo,
      violations: state.specViolations,
      code: state.currentCode,
      stl: state.stlContent ?? undefined,
      revisionCount: state.acceptRevisionCount,
    };
    const decision = interrupt(payload) as GateDecision;

    if (decision.action === 'cancel') {
      return { gateAction: 'cancel' };
    }

    if (decision.action === 'revise') {
      return {
        gateAction: 'revise',
        gateFeedback: decision.comment || 'The user requested another repair attempt but did not specify what to change.',
        acceptRevisionCount: state.acceptRevisionCount + 1,
        // A human-requested revision should get a real attempt, not bounce
        // straight back here because the automatic budget was already spent.
        maxAttempts: state.maxAttempts + 1,
      };
    }

    return { gateAction: 'approve' };
  }

  // Conditional Edge: route from architectNode
  function checkSpecRoute(state: AgentStateType) {
    const prompt = latestHumanText(state.messages);

    if (shouldGateSpec(state, prompt)) return 'specGate';
    return 'drafterNode';
  }

  function routeAfterArchitect(state: AgentStateType) {
    const sheetsEnabled = process.env.CADAI_SPEC_SHEETS !== 'off';
    const hasSpec = (state.specVariants || []).some((v) => v.spec !== null);
    if (sheetsEnabled && isVisionModel(selectedModel) && hasSpec) {
      return 'specIllustrator';
    }
    return checkSpecRoute(state);
  }

  function routeAfterReviewer(state: AgentStateType) {
    const needsRevision = (state.specVariants || []).some((v) => v.needsRevision);
    if (needsRevision) {
      return 'architectNode';
    }
    return checkSpecRoute(state);
  }

  // Conditional Edge: route from specGate
  function checkReviseRoute(state: AgentStateType) {
    if (state.gateAction === 'cancel') return 'respondToUser';
    if (state.gateAction === 'revise' && state.specRevisionCount <= MAX_SPEC_REVISIONS) {
      return 'architectNode';
    }
    return 'drafterNode';
  }

  // Conditional Edge: route from validateCode
  function checkValidationRoute(state: AgentStateType) {
    const isDone = (state.failureKind === 'none' && state.isValid) ||
                   // Global ceiling on total LLM passes, unchanged.
                   (state.attemptCount >= state.maxAttempts) ||
                   // Per-class cutoff. Was `attemptCount >= 2` against the
                   // shared counter, which meant compile retries could consume
                   // the geometric budget before it was ever used.
                   (state.failureKind === 'semantic' && state.semanticFailures > MAX_SEMANTIC_REPAIRS);

    if (isDone) {
      // Only geometry that survived every deterministic check is worth looking
      // at: a compile failure has a better signal than a picture, and the
      // critic costs a multimodal call, so it runs once at the end of a run
      // rather than on every repair attempt.
      if (state.isValid && state.stlContent) return 'visualCritic';
      if (shouldGateAccept(state)) return 'acceptGate';
      return 'respondToUser';
    }
    return 'fixCode';
  }

  // Conditional Edge: route from visualCritic. Any finding it added is a
  // warning, so it cannot invalidate the model - but shouldGateAccept fires on
  // ANY violation, which is exactly how a critique reaches a human.
  function checkCriticRoute(state: AgentStateType) {
    if (shouldGateAccept(state)) return 'acceptGate';
    return 'respondToUser';
  }

  // Conditional Edge: route from acceptGate
  function checkAcceptRoute(state: AgentStateType) {
    if (state.gateAction === 'revise' && state.acceptRevisionCount <= MAX_ACCEPT_REVISIONS) {
      return 'fixCode';
    }
    return 'respondToUser';
  }

  // Build the graph
  const workflow = new StateGraph(AgentState)
    .addNode('architectNode', architectNode)
    .addNode('specIllustrator', specIllustrator)
    .addNode('specReviewer', specReviewer)
    .addNode('specGate', specGate)
    .addNode('drafterNode', drafterNode)
    .addNode('validateCode', validateCode)
    .addNode('fixCode', fixCode)
    .addNode('visualCritic', visualCritic)
    .addNode('acceptGate', acceptGate)
    .addNode('respondToUser', respondToUser)
    .addEdge(START, 'architectNode')
    .addConditionalEdges('architectNode', routeAfterArchitect, {
      specIllustrator: 'specIllustrator',
      specGate: 'specGate',
      drafterNode: 'drafterNode',
    })
    .addEdge('specIllustrator', 'specReviewer')
    .addConditionalEdges('specReviewer', routeAfterReviewer, {
      architectNode: 'architectNode',
      specGate: 'specGate',
      drafterNode: 'drafterNode',
    })
    .addConditionalEdges('specGate', checkReviseRoute, {
      architectNode: 'architectNode',
      drafterNode: 'drafterNode',
      respondToUser: 'respondToUser'
    })
    .addEdge('drafterNode', 'validateCode')
    .addConditionalEdges('validateCode', checkValidationRoute, {
      fixCode: 'fixCode',
      visualCritic: 'visualCritic',
      acceptGate: 'acceptGate',
      respondToUser: 'respondToUser'
    })
    .addConditionalEdges('visualCritic', checkCriticRoute, {
      acceptGate: 'acceptGate',
      respondToUser: 'respondToUser'
    })
    .addEdge('fixCode', 'validateCode')
    .addConditionalEdges('acceptGate', checkAcceptRoute, {
      fixCode: 'fixCode',
      respondToUser: 'respondToUser'
    })
    .addEdge('respondToUser', END);

  // interrupt() calls inside specGate/acceptGate are what actually pause the
  // graph and carry data across the boundary; a checkpointer is required for
  // that pause to survive past this single invoke() call, which is exactly
  // what durably holding a run open across an HTTP request needs.
  return workflow.compile({ checkpointer: getCheckpointer() });
}
