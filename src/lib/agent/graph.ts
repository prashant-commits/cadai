import { StateGraph, Annotation, END, START, interrupt } from '@langchain/langgraph';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { CAD_AI_SYSTEM_PROMPT, ARCHITECT_PREAMBLE, DRAFTER_PREAMBLE, REPAIR_PREAMBLE, CRITIC_PREAMBLE, DRAFTER_PLACEMENT_CONTRACT } from './system-prompt';
import { extractOpenScadCode } from './code-extractor';
import { validateOpenScadCode } from './code-validator';
import { getFunctionalCadModuleTool } from './engineering-tools';
import { AssemblySpec, AssemblySpecSchema } from './assembly-spec';
import { ValidationResult, ScadDiagnostic } from '../engine/scad-compiler';
import { ModelInfo, GatePayload, GateDecision, DesignContract } from '@/types';
import { SpecViolation, auditSpec } from './spec-audit';
import { analyzeStl } from '../engine/geometry-utils';
import { renderStlViews, RenderedView } from '../engine/stl-renderer';
import { shouldGateSpec, shouldGateAccept } from './gate-policy';
import { getChatModel, getVisionModel } from './model-provider';
import { composeAssembly, stripGeneratedAssembly, instantiationFor } from '../design/compose-assembly';
import { checkInterference } from '../engine/assembly-verifier';
import { getCheckpointer } from './checkpointer';

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

/** What the Design Inspector is allowed to say about a set of renders. */
const VisualCritiqueSchema = z.object({
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
type VisualCritique = z.infer<typeof VisualCritiqueSchema>;

/** True when the Architect gave at least one component real coordinates. */
function specHasPlacements(spec: AssemblySpec | null): boolean {
  return !!spec?.components?.some((c) => c.position !== undefined || c.rotation !== undefined);
}

/**
 * Hands assembly placement to deterministic code where the spec allows it.
 *
 * Every outcome except a clean compose leaves the model's script untouched, so
 * this can only ever add a correctly-placed assembly - never remove or reorder
 * geometry the model wrote.
 */
function applyPlacement(code: string, spec: AssemblySpec | null): string {
  if (!code) return code;
  const result = composeAssembly(code, spec);
  if (result.composed) return result.code;
  if (result.reason === 'missing_modules') {
    console.warn(
      `Assembly placement skipped: the spec names components with no matching module (${result.missing?.join(', ')}).`
    );
  }
  return result.code;
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
  spec: AssemblySpec | null
): Promise<SpecViolation[]> {
  const joints = (spec?.jointContracts ?? []).filter((j) => j.partA && j.partB);
  if (!spec || joints.length === 0) return [];

  const modules = stripGeneratedAssembly(code);
  const violations: SpecViolation[] = [];

  for (const joint of joints.slice(0, MAX_INTERFERENCE_CHECKS)) {
    const callA = instantiationFor(spec, joint.partA!);
    const callB = instantiationFor(spec, joint.partB!);
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

/** The user's own words for this run, for prompts that need the request verbatim. */
function firstHumanText(messages: BaseMessage[]): string {
  for (const msg of messages) {
    if (msg._getType() !== 'human') continue;
    const c = msg.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      const text = c.find((p) => (p as { type?: string }).type === 'text') as
        | { text?: string }
        | undefined;
      if (text?.text) return text.text;
    }
  }
  return '';
}

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
  const minWall = s.minWallMm ?? (s.nozzleMm ? s.nozzleMm * 4 : undefined);
  if (minWall !== undefined) lines.push(`Minimum wall thickness: ${minWall}mm (every parameter named *wall* is audited against it).`);
  if (s.buildVolumeMm) lines.push(`Build volume: ${s.buildVolumeMm.join(' x ')}mm.`);
  if (s.material) lines.push(`Material: ${s.material}.`);
  if (s.maxOverhangDeg !== undefined) lines.push(`Support-free overhang limit: ${s.maxOverhangDeg} degrees from vertical.`);
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
  for (const c of spec.components ?? []) {
    const extras = [];
    if (c.bedFace) extras.push(`expected bed face ${c.bedFace}`);
    if (c.matingFaces?.length) extras.push(`flat mating faces: ${c.matingFaces.join(', ')}`);
    lines.push(`- ${c.name}: ${c.description}${extras.length ? ` (${extras.join('; ')})` : ''}`);
  }
  for (const s of spec.stressPoints ?? []) {
    if (s.risk === 'low') continue;
    lines.push(`- ${s.risk}-risk stress point at ${s.component ? `${s.component} ` : ''}${s.location}; the spec demands: ${s.mitigation}`);
  }
  return lines.length ? `\n\nApproved spec, in outline:\n${lines.join('\n')}` : '';
}

/**
 * Which one violation the repair prompt should lead with. The 'semantic'
 * failure class covers everything from an undeclared identifier to two parts
 * interpenetrating, and "fix the arithmetic" is the wrong instruction for
 * most of them.
 */
const REPAIR_KIND_PRIORITY: SpecViolation['kind'][] = [
  'unknown_symbol', 'dimensionality', 'empty', 'manifold', 'shells', 'interference',
  'clearance', 'bbox', 'standing', 'buildplate', 'compile', 'visual',
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
  buildplate: 'The part does not sit on the build plate as declared, or exceeds the printer. Re-orient it onto its bedFace or resize it.',
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
    if (!c.bedFace && !c.matingFaces?.length) continue;
    const parts = [];
    if (c.bedFace) parts.push(`bed face ${c.bedFace}`);
    if (c.matingFaces?.length) parts.push(`mating faces: ${c.matingFaces.join(', ')}`);
    lines.push(`${c.name} - ${parts.join('; ')}`);
  }
  for (const e of spec.edgeTreatments ?? []) {
    lines.push(
      `Edge treatment [${e.category}] ${e.kind} ${e.sizeMm}mm - ${e.component ? `${e.component}: ` : ''}${e.location}`
    );
  }
  for (const s of spec.stressPoints ?? []) {
    lines.push(
      `Stress point [${s.risk}] ${s.component ? `${s.component}: ` : ''}${s.location} - ${s.loadCase}; mitigation: ${s.mitigation}`
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

/**
 * Renders the user's gate answers as "Q -> A" lines for the architect prompt.
 * Matches answers back to their question text by id; an id with no matching
 * question is still passed through, since a stale id is better surfaced to the
 * architect than silently dropped.
 */
function answeredQuestionLines(
  spec: AssemblySpec | null,
  answers?: Record<string, string>
): string[] {
  if (!answers) return [];
  const byId = new Map((spec?.openQuestions ?? []).map((q) => [q.id, q.question]));
  const lines: string[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    const text = answer?.trim();
    if (!text) continue;
    lines.push(`- ${byId.get(id) ?? id}: ${text}`);
  }
  return lines.length ? ['The user answered your open questions:', ...lines] : [];
}

export interface StreamEventPayload {
  type: 'thinking' | 'generating' | 'validating' | 'fixing' | 'ready' | 'error' | 'token' | 'awaiting_input';
  message: string;
  code?: string;
  stl?: string;
  explanation?: string;
  gate?: GatePayload;
  // Identifies the paused run the client must post back to /api/chat/resume.
  // Set only on 'awaiting_input'.
  runId?: string;
  // The contract as the server last saw it, including any spec the human
  // approved at the gate. Set on 'ready' so the client can persist it.
  designContract?: DesignContract;
  timestamp: number;
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
    default: () => Number(process.env.CADAI_MAX_ATTEMPTS ?? 3),
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
 * Retained as the Gemini-only entry point some callers still import. New code
 * should use getChatModel(), which also serves the gateway models.
 */
export function getGeminiModel(apiKey?: string, modelName?: string) {
  return getChatModel(apiKey, modelName || 'gemini-3.6-flash');
}

/**
 * Creates the CAD AI LangGraph agent graph with tool-calling capabilities.
 */
export function createCadAgent(
  apiKey?: string,
  onProgress?: (event: StreamEventPayload) => void,
  modelName?: string
) {
  const model = getChatModel(apiKey, modelName);
  // Resolved separately: no DeepSeek text route accepts image input, so the
  // critic falls back to a multimodal slug instead of failing the whole run.
  const visionModel = getVisionModel(apiKey, modelName);
  
  // Architect uses structured output
  const architectModel = model.withStructuredOutput(AssemblySpecSchema);
  
  // Drafter uses engineering lookup tools
  const drafterModel = model.bindTools([getFunctionalCadModuleTool]);

  // Node 1: architectNode
  async function architectNode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    onProgress?.({
      type: 'thinking',
      message: 'Mechanical Architect: Analyzing design requirements and defining bounding boxes...',
      timestamp: Date.now(),
    });

    const messages: BaseMessage[] = [
      new SystemMessage(CAD_AI_SYSTEM_PROMPT + "\n\n" + ARCHITECT_PREAMBLE),
      ...state.messages,
    ];

    if (state.designContract) {
      const contractDetails = [];
      if (Object.keys(state.designContract.standing).length > 0) {
        contractDetails.push("Standing Constraints:\n" + JSON.stringify(state.designContract.standing, null, 2));
      }
      if (Object.keys(state.designContract.pinnedParams).length > 0) {
        const pins = Object.fromEntries(
          Object.entries(state.designContract.pinnedParams).map(([k, v]) => [k, (v as any).value])
        );
        contractDetails.push("Pinned Parameters (MUST BE EXACTLY THESE VALUES):\n" + JSON.stringify(pins, null, 2));
      }
      
      if (contractDetails.length > 0) {
        messages.push(new HumanMessage(
          "Design Contract:\nThe user has pinned these values and constraints; treat them as given.\n\n" + contractDetails.join("\n\n")
        ));
      }
    }

    // A prior spec was sent back for revision at the human review gate.
    if (state.gateAction === 'revise' && state.gateFeedback) {
      messages.push(new HumanMessage(
        `The previous Assembly Spec was rejected at human review. Revise it accordingly:\n${state.gateFeedback}`
      ));
    }

    // Bounded retry. The counter must advance on every pass, not only on throw,
    // or a falsy-but-resolved invoke spins forever around a network call.
    let spec: AssemblySpec | null = null;
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2 && !spec; attempt++) {
      const attemptMessages =
        attempt === 0
          ? messages
          : [
              ...messages,
              new HumanMessage(
                'Your previous reply did not yield a valid Assembly Spec. Emit the structured spec now, with every dimension in millimetres.'
              ),
            ];
      try {
        spec = ((await architectModel.invoke(attemptMessages, config)) as AssemblySpec) ?? null;
      } catch (err) {
        // Fall through to the next attempt; a null spec degrades to warn-only.
        // But NEVER silently: a schema the provider rejects fails identically on
        // every attempt and every run, and swallowing it made the review gate
        // render an empty card with no way to tell a refusal from an outage.
        lastError = err instanceof Error ? err.message : String(err);
        console.error(`architectNode: structured output failed (attempt ${attempt + 1}/2):`, lastError);
      }
    }

    if (!spec) {
      onProgress?.({
        type: 'thinking',
        message: `Mechanical Architect: no Assembly Spec was produced${lastError ? ` (${lastError.slice(0, 200)})` : ''}. Drafting without a dimensional contract.`,
        timestamp: Date.now(),
      });
    }

    const explanation = spec
      ? summarizeSpec(spec)
      : lastError
        ? `${NO_SPEC_EXPLANATION} The Architect model errored: ${lastError}`
        : NO_SPEC_EXPLANATION;

    return {
      assemblySpec: spec,
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

  // Node 2: drafterNode
  async function drafterNode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    onProgress?.({
      type: 'generating',
      message: 'Parametric Drafter: Generating Additive OpenSCAD geometry based on the Architect Spec...',
      timestamp: Date.now(),
    });

    // A missing spec degrades to unconstrained drafting rather than skipping the
    // draft entirely - an empty script gives the repair loop nothing to work with.
    const contract = contractLines(state.designContract);
    const drafterPrompt = state.assemblySpec
      ? `Implement the Architect Spec below as one complete OpenSCAD script. Honour every field: bedFace planar (on z = 0 for a single part), matingFaces flat, each edgeTreatment built at its location and size by category, each stressPoint mitigation built exactly as sized, joints at their declared clearance.

Architect Spec:
${JSON.stringify(state.assemblySpec, null, 2)}
${contract}`
      : `Write one complete OpenSCAD script for the user's request above. No Architect Spec is available: derive the dimensions yourself and declare them as parameters, choose a bedFace and lay it on z = 0, and apply the corner-softening categories and stress-point mitigations the part needs, naming them in your rationale.
${contract}`;

    // Only impose the module-at-origin contract when there are real coordinates
    // to honour; otherwise the drafter should assemble the part itself as before.
    const drafterSystem =
      CAD_AI_SYSTEM_PROMPT +
      '\n\n' +
      DRAFTER_PREAMBLE +
      (specHasPlacements(state.assemblySpec) ? '\n\n' + DRAFTER_PLACEMENT_CONTRACT : '');

    const messages: BaseMessage[] = [
      new SystemMessage(drafterSystem),
      ...state.messages,
      new HumanMessage(drafterPrompt)
    ];

    let response = await drafterModel.invoke(messages, config);

    // Handle tool execution loop if the model requests engineering modules
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolCallMessages: BaseMessage[] = [response];

      for (const toolCall of response.tool_calls) {
        if (toolCall.name === 'get_functional_cad_module') {
          const moduleKey = (toolCall.args as any)?.moduleKey || 'fastener_hardware';
          onProgress?.({
            type: 'thinking',
            message: `Parametric Drafter: Retrieving tested engineering module: ${moduleKey}...`,
            timestamp: Date.now(),
          });

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

      onProgress?.({
        type: 'generating',
        message: 'Synthesizing complete parametric OpenSCAD script with retrieved engineering modules...',
        timestamp: Date.now(),
      });

      // Synthesize final code with tool observations
      response = await model.invoke([...messages, ...toolCallMessages], config);
    }

    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const extracted = extractOpenScadCode(content);
    const placed = applyPlacement(extracted.code || '', state.assemblySpec);

    return {
      currentCode: placed,
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
    };
  }

  // Node 3: validateCode
  async function validateCode(state: AgentStateType): Promise<Partial<AgentStateType>> {
    onProgress?.({
      type: 'validating',
      message: 'Physical Validator: Checking watertightness and flat-pack capabilities in WASM...',
      timestamp: Date.now(),
    });

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

    // Assembly fit. Only possible now that jointContracts name the components
    // they join and those components have placements - checkInterference needs
    // real instantiation strings, which is exactly why this could not be wired
    // in before. Runs only on a clean compile: two parts cannot be tested for
    // overlap if the script never produced a solid.
    if (validation.valid) {
      specViolations.push(...(await checkAssemblyFit(state.currentCode, state.assemblySpec)));
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
      attemptHistory: [attempt],
      failureKind: !validation.valid ? 'compile' : !isSemanticValid ? 'semantic' : 'none',
      // Count each class separately so neither can starve the other's budget.
      compileFailures: !validation.valid ? state.compileFailures + 1 : state.compileFailures,
      semanticFailures:
        validation.valid && !isSemanticValid ? state.semanticFailures + 1 : state.semanticFailures,
      // Never accumulate a SystemMessage into `messages`: Gemini's client
      // rejects any request where a system-role message isn't at index 0
      // (@langchain/google-genai/dist/utils/common.cjs), and every node
      // prepends its own fresh SystemMessage ahead of this history. Frame
      // the validation report as environment feedback instead - there's no
      // tool_call_id to hang a ToolMessage off, so HumanMessage is the
      // idiomatic accumulated-history role.
      messages: [new HumanMessage(`[Validation Report]\n${validationMsgStr}`)],
    };
  }

  // Node 4: fixCode
  async function fixCode(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
    const currentAttempt = state.attemptCount + 1;
    const fixModel = model.bindTools([getFunctionalCadModuleTool]);

    onProgress?.({
      type: 'fixing',
      message: `Physical Validator Error. Drafter self-repairing solid model (attempt ${currentAttempt}/${state.maxAttempts})...`,
      timestamp: Date.now(),
    });

    const attemptsContext = state.attemptHistory
      .slice(-2)
      .map((a) => {
        const m = a.measured;
        const flatFace =
          m?.bottomAreaMm2 !== undefined
            ? `, bottom area ${m.bottomAreaMm2}mm2 (${m.isFlatPackable ? 'flat-packable' : 'NOT flat-packable: no flat face on the build plate'})`
            : '';
        const overhang = m?.overhang
          ? `, max overhang ${m.overhang.maxOverhangDeg}deg from vertical (${m.overhang.unsupportedAreaMm2}mm2 unsupported past 45deg)`
          : '';
        const measured = m
          ? `Measured: ${m.dimensions.x} x ${m.dimensions.y} x ${m.dimensions.z} mm, volume ${m.volumeMm3}mm3, manifold=${m.isManifold ?? 'unknown'}, shells=${m.shellCount ?? 'unknown'}${flatFace}${overhang}`
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
${state.assemblySpec ? `Assembly Spec (every edgeTreatment and stressPoint mitigation in it is mandatory):\n${JSON.stringify(state.assemblySpec, null, 2)}\n` : ''}${contractLines(state.designContract)}
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
          const moduleKey = (toolCall.args as any)?.moduleKey || 'fastener_hardware';
          onProgress?.({
            type: 'thinking',
            message: `Parametric Drafter: Retrieving tested engineering module: ${moduleKey}...`,
            timestamp: Date.now(),
          });

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

      onProgress?.({
        type: 'generating',
        message: 'Synthesizing complete parametric OpenSCAD script with retrieved engineering modules...',
        timestamp: Date.now(),
      });

      response = await model.invoke([...fixMessages, ...toolCallMessages], config);
    }
    
    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const extracted = extractOpenScadCode(content);

    // Patch only the attempt being repaired. The merge-by-n reducer applies it
    // in place; returning the whole array would re-append the entire history.
    const last = state.attemptHistory[state.attemptHistory.length - 1];
    const patchedHistory = last ? [{ ...last, diagnosis: content }] : [];

    return {
      // Re-compose: the repair model was shown the modules with the generated
      // block stripped, so placement stays driven by the spec across repairs
      // instead of silently reverting to whatever the repair happened to write.
      currentCode: extracted.code ? applyPlacement(extracted.code, state.assemblySpec) : state.currentCode,
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
    if (process.env.CADAI_VISUAL_CRITIC === 'off') return {};
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

    onProgress?.({
      type: 'validating',
      message: `Design Inspector: Reviewing ${views.length} rendered views for shape correctness...`,
      timestamp: Date.now(),
    });

    const request = firstHumanText(state.messages) || 'the user request above';
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
      critique = (await visionModel
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
  async function respondToUser(state: AgentStateType): Promise<Partial<AgentStateType>> {
    if (state.isValid) {
      onProgress?.({
        type: 'ready',
        message: 'Mechanical model compiled and verified successfully! 3D preview is ready.',
        code: state.currentCode,
        stl: state.stlContent || undefined,
        explanation: state.explanation,
        // specGate stamps the approved spec into designContract, but until now
        // nothing sent it back, so the write had no reader and every later
        // turn re-POSTed a spec-less contract and re-opened the gate.
        designContract: state.designContract ?? undefined,
        timestamp: Date.now(),
      });
    } else {
      let errorMsg = state.validation?.error || 'Unknown compilation error.';
      if (state.specViolations.length > 0) {
        errorMsg = state.specViolations.map(v => `[${v.kind}] ${v.message}`).join(', ');
      }
      onProgress?.({
        type: 'error',
        message: `Unable to automatically resolve compilation error: ${errorMsg}`,
        code: state.currentCode,
        explanation: state.explanation,
        timestamp: Date.now(),
      });
    }

    return {};
  }

  // Node: specGate. Pauses the run and hands the client the Architect's spec
  // to review/edit. `interrupt()` both emits the payload (surfaced by the
  // caller via isInterrupted()/INTERRUPT on the invoke() result) and, on
  // resume, returns exactly the value passed to Command({ resume }) - there is
  // no other channel between the paused graph and the human's decision.
  async function specGate(state: AgentStateType): Promise<Partial<AgentStateType>> {
    const payload: GatePayload = {
      kind: 'spec',
      spec: state.assemblySpec,
      contract: state.designContract,
      revisionCount: state.specRevisionCount,
    };
    const decision = interrupt(payload) as GateDecision;

    if (decision.action === 'cancel') {
      return { gateAction: 'cancel' };
    }

    // Answers to openQuestions are the whole point of asking them, so they
    // count on BOTH branches - a revise that answers two questions must carry
    // those answers, not just the free-text comment.
    const answerLines = answeredQuestionLines(state.assemblySpec, decision.answers);

    if (decision.action === 'revise') {
      const parts = [decision.comment?.trim(), answerLines.length ? answerLines.join('\n') : ''].filter(Boolean);
      return {
        gateAction: 'revise',
        gateFeedback: parts.length
          ? parts.join('\n')
          : 'The user requested changes but did not specify what.',
        specRevisionCount: state.specRevisionCount + 1,
      };
    }

    // Approve. A client-edited spec must be re-validated - it crossed a
    // network boundary as plain JSON and is no longer a trusted AssemblySpec.
    let approvedSpec = state.assemblySpec;
    if (decision.spec) {
      const parsed = AssemblySpecSchema.safeParse(decision.spec);
      if (parsed.success) approvedSpec = parsed.data;
      // On failure, fall back to the last known-good spec rather than reject
      // the whole approval over a malformed edit.
    }

    // An answered question is no longer open: promote it to a recorded
    // assumption so the drafter and the audit both see a settled fact, and
    // drop it from openQuestions so a later gate does not re-ask it.
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
    let prompt = '';
    for (const msg of state.messages) {
      if (msg._getType() === 'human') {
        prompt = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        break;
      }
    }

    if (shouldGateSpec(state, prompt)) return 'specGate';
    return 'drafterNode';
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
    .addNode('specGate', specGate)
    .addNode('drafterNode', drafterNode)
    .addNode('validateCode', validateCode)
    .addNode('fixCode', fixCode)
    .addNode('visualCritic', visualCritic)
    .addNode('acceptGate', acceptGate)
    .addNode('respondToUser', respondToUser)
    .addEdge(START, 'architectNode')
    .addConditionalEdges('architectNode', checkSpecRoute, {
      specGate: 'specGate',
      drafterNode: 'drafterNode'
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
