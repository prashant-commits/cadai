import { createHash } from 'crypto';
import { HumanMessage, ToolMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { AssemblySpec } from '../assembly-spec';
import type { AgentStateType } from '../graph';
import { isCutOff, unusableStop } from '../llm-schemas';
import { cachedSystemMessage } from '../system-prompt';
import { emitBrepScript } from '../../brep/emit-script';
import { runBrep } from '../../engine/brep-runner';
import { renderStlViews, type ViewName } from '../../engine/stl-renderer';
import { stlToAscii, toModuleFrames, toPlacementReport } from '../../brep/measurements';
import { auditPlacement } from '../placement-audit';
import { componentAtLine } from './validate-brep';
import { contentText } from '../message-text';
import { BREP_CHEATSHEET } from '../../brep/cheatsheet';
import { getBuildRequirements } from '../requirements';
import { auditNesting } from '../nesting-audit';
import { checkPythonScript } from '../../brep/body-check';
import { DEFAULT_MODEL } from '../models';

export interface ToolBindableModel {
  invoke(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage>;
  bindTools?(
    tools: unknown[],
    kwargs?: { tool_choice?: 'auto' | 'none' }
  ): { invoke(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage> };
}

export function renderCompactSpec(spec: AssemblySpec): string {
  const parts: string[] = [];
  if (spec.assemblyName) {
    parts.push(`Assembly: ${spec.assemblyName}`);
  }
  if (spec.designLanguage) {
    const dl = spec.designLanguage;
    const radii: string[] = [];
    if (dl.edgeRadius !== undefined) radii.push(`edgeRadius: ${dl.edgeRadius} mm`);
    if (dl.minorRadius !== undefined) radii.push(`minorRadius: ${dl.minorRadius} mm`);
    const radiiStr = radii.length > 0 ? ` (${radii.join(', ')})` : '';
    const principlesStr = dl.principles && dl.principles.length > 0
      ? '\n' + dl.principles.map((p) => `  - ${p}`).join('\n')
      : '';
    parts.push(`Design Language: ${dl.name}${radiiStr}${principlesStr}`);
  }
  if (spec.boundingBox) {
    parts.push(`Bounding Box: ${spec.boundingBox.width} x ${spec.boundingBox.length} x ${spec.boundingBox.height} mm`);
  }
  if (spec.parameters && spec.parameters.length > 0) {
    parts.push('Parameters:\n' + spec.parameters.map((p) => {
      const range = (p.min !== undefined && p.max !== undefined) ? ` [${p.min}:${p.step ?? 1}:${p.max}]` : '';
      return `- ${p.name} = ${p.value}${range}: ${p.description ?? ''}`;
    }).join('\n'));
  }
  if (spec.components && spec.components.length > 0) {
    parts.push('Components:\n' + spec.components.map((c) => {
      const ext = c.localExtents ? ` size [${c.localExtents.join(', ')}]` : '';
      const pos = c.position ? ` at [${c.position.join(', ')}]` : '';
      const rot = c.rotation && c.rotation.some((r) => r !== 0) ? ` rot [${c.rotation.join(', ')}]` : '';
      const kind = c.shape?.kind ? ` (${c.shape.kind})` : '';
      return `- ${c.name}${kind}:${ext}${pos}${rot} - ${c.description ?? ''}`;
    }).join('\n'));
  }
  if (spec.jointContracts && spec.jointContracts.length > 0) {
    parts.push('Joint Contracts:\n' + spec.jointContracts.map((j) => {
      return `- ${j.type} between ${j.partA} and ${j.partB} (clearance: ${j.clearance} mm)`;
    }).join('\n'));
  }
  return parts.join('\n\n');
}

export function applyParameterOverrides(
  script: string,
  overrides?: Record<string, number | string | boolean>
): string {
  if (!overrides || Object.keys(overrides).length === 0) return script;
  const lines = script.split('\n');
  const validOverrides = new Map<string, number | boolean>();
  for (const [k, v] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      validOverrides.set(k, v);
    } else if (typeof v === 'boolean') {
      validOverrides.set(k, v);
    }
  }
  if (validOverrides.size === 0) return script;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^#\n]+?)(\s*(?:#.*)?)$/.exec(line);
    if (match) {
      const name = match[1];
      if (validOverrides.has(name)) {
        lines[i] = `${name} = ${validOverrides.get(name)}${match[3]}`;
      }
    }
  }

  return lines.join('\n');
}

export function checkScriptGuardrails(script: string): { ok: boolean; reason?: string } {
  return checkPythonScript(script);
}

function componentInTraceback(error: string, names: string[]): string {
  let found = '';
  let at = -1;
  for (const name of names) {
    const re = new RegExp(`(?:\\bin ${name}(?:_part\\d*)?\\b|\\bdef ${name}(?:_part\\d*)?\\b)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(error)) !== null) {
      if (m.index > at) {
        at = m.index;
        found = name;
      }
    }
  }
  return found;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function hasMovingPart(request: string, spec?: AssemblySpec | null): boolean {
  if (spec?.jointContracts?.some((j) => /lid|hinge|slide|revolute|prismatic/i.test(j.type))) {
    return true;
  }
  return /\b(lid|door|hinge|drawer|slide|rotate|open|fold)\b/i.test(request);
}

export interface PoseParameter {
  name: string;
  value: number;
  min: number;
  max: number;
  step?: number;
}

export function parsePoseParameters(script: string): PoseParameter[] {
  const params: PoseParameter[] = [];
  const lines = script.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*(?:_deg|_travel))\s*=\s*([0-9.-]+)\s*#\s*\[\s*([0-9.-]+)(?::([0-9.-]+))?:([0-9.-]+)\s*\]/.exec(trimmed);
    if (m) {
      const name = m[1];
      const value = parseFloat(m[2]);
      const min = parseFloat(m[3]);
      const step = m[4] ? parseFloat(m[4]) : undefined;
      const max = parseFloat(m[5]);
      params.push({ name, value, min, max, step });
    }
  }
  return params;
}

export const BREP_AGENT_SYSTEM_PROMPT = `You are the Mechanical Architect Builder, developing a complete parametric build123d Python model through an iterative inspect-and-fix workflow.

# PRODUCT ENGINEERING BRIEF
- No unintended interferences: parts must not collide or occupy the same space unless intentionally fused.
- Moving parts must clear their full range of motion without collision. Use the render tool with parameter overrides (e.g., hinge angles) to verify clearances.
- Fasteners and holes stay accessible: keep screw paths, screwdriver access, and fastener heads clear of other features.
- Keep features off each other's footprint and leave usable clearance between functional zones.
- Consolidate permanently joined parts: parts that are static and permanently joined should be fused into a single solid.
- Sized sensibly: walls and ribs must have appropriate thickness for structural rigidity.
- Stable on its base: ensure the object does not tip over in use.
- Design language: apply the variant's designLanguage. Prefer one shaped body over stacked plates where the design allows. Round outer edges with the radius family (via _round/_bevel or fillet/chamfer). Keep functional faces (mating faces, hinge axes, slots, holes) sharp and exact. Never let rounding change a stated dimension. Explain notable form choices in notes.
- Nothing below z = 0: the entire model rests on or above the ground plane (z = 0).
- Coordinate orientation: the side the user faces/uses faces -Y (front view looks along +Y into -Y face).

# SCRIPT CONTRACT
The final gate and the UI sliders depend on this contract:
1. Top-level parameter lines: keep the format \`name = value  # [min:step:max] description\`. Add parameters for moving-part poses with sensible ranges (e.g. lid_open_deg = 0  # [0:5:120] lid opening angle in degrees), and narrow a range when a clash makes part of it unusable, explaining why in finish notes. A pose parameter changes the part's position, never its size. Pose parameters default to the closed/home pose (their range min); the model the user sees first is closed.
2. Labelled parts in \`_cadai_parts\`: \`_cadai_parts\` must contain one labelled shape per spec component (label = component name), measured BEFORE any fusing; consolidation happens only in \`result\`. Every spec component must exist in \`_cadai_parts\` unless deliberately removed/replaced and declared in \`finish(omitted=[{component, reason}])\`.
3. Exported shape: assign the final fused Compound / Part to \`result\`.
4. Imports: no imports beyond the existing prelude.
5. Guardrail rules: use algebra mode only (never \`with BuildPart\`, \`with BuildSketch\`, \`with BuildLine\`). No \`open\`, \`eval\`, \`exec\`, \`os\`, \`sys\`, dunder methods (\`__\`), or file keywords.

# VERIFICATION BEFORE FINISH
- Before finish, you must verify motion: if the model has a moving part, the script must expose a pose parameter (_deg or _travel with range). You must test the script at its range max (and min if not 0) using render or run_script and see zero unintended collisions.
- A pose parameter changes the part's position, never its size.
- Pose parameters default to the closed/home pose (their range min); the model the user sees first is closed.
- Before finish, you must verify the atomic requirements checklist and report each requirement as met, partly, or unmet (with evidence).
- All parts must touch or be within 0.5 mm of another part in the closed pose (pin in bore clearance <= 1 mm). Disconnected parts are rejected.
- Inserted or stacking features must fit within their host opening without collision.

# BUILD123D CHEAT SHEET
${BREP_CHEATSHEET}`.trim();

export function scriptBaseKey(script: string): string {
  const normalized = script.replace(
    /^([A-Za-z_][A-Za-z0-9_]*\s*=\s*)([0-9.-]+)(\s*(?:#\s*\[[0-9.-]+:[0-9.-]+:[0-9.-]+\].*)?)$/gm,
    '$1__POSE_VAL__$3'
  ).trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

interface ScriptPartBounds {
  min: [number, number, number];
  max: [number, number, number];
  volume: number;
}

interface TestedPoint {
  value: number;
  interferences: number;
  partBounds: Map<string, ScriptPartBounds>;
}

interface ScriptEvidence {
  defaultParts?: Map<string, ScriptPartBounds>;
  testedPoints: Map<string, TestedPoint[]>;
}

function parsePositiveInt(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultVal;
}

function parsePositiveFloat(val: string | undefined, defaultVal: number): number {
  if (!val) return defaultVal;
  const n = parseFloat(val);
  return Number.isFinite(n) && n >= 0 ? n : defaultVal;
}

export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-5.5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5.5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5.5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5.1': { input: 10, output: 50 },
};

export function extractReplyUsage(reply: AIMessage): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
} {
  const meta = reply.usage_metadata;
  const respUsage = (reply.response_metadata as { usage?: Record<string, unknown> } | undefined)?.usage;
  const input = typeof meta?.input_tokens === 'number'
    ? meta.input_tokens
    : typeof respUsage?.input_tokens === 'number'
      ? (respUsage.input_tokens as number)
      : 0;
  const output = typeof meta?.output_tokens === 'number'
    ? meta.output_tokens
    : typeof respUsage?.output_tokens === 'number'
      ? (respUsage.output_tokens as number)
      : 0;
  const cacheCreation = typeof (meta as unknown as { input_token_details?: { cache_creation?: number } })?.input_token_details?.cache_creation === 'number'
    ? (meta as unknown as { input_token_details?: { cache_creation?: number } }).input_token_details!.cache_creation!
    : typeof respUsage?.cache_creation_input_tokens === 'number'
      ? (respUsage.cache_creation_input_tokens as number)
      : 0;
  const cacheRead = typeof (meta as unknown as { input_token_details?: { cache_read?: number } })?.input_token_details?.cache_read === 'number'
    ? (meta as unknown as { input_token_details?: { cache_read?: number } }).input_token_details!.cache_read!
    : typeof respUsage?.cache_read_input_tokens === 'number'
      ? (respUsage.cache_read_input_tokens as number)
      : 0;

  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

export function estimateCostUsd(
  modelSlug: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  }
): number {
  const norm = modelSlug.toLowerCase().replace(/\./g, '-');
  const price = MODEL_PRICES[norm] ?? MODEL_PRICES[modelSlug] ?? MODEL_PRICES['claude-sonnet-5-5'];
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1;
  const output = usage.output_tokens ?? 0;
  return (input * price.input + output * price.output) / 1_000_000;
}

export function makeBrepAgentBuild(model: ToolBindableModel): (
  state: AgentStateType,
  config?: LangGraphRunnableConfig
) => Promise<Partial<AgentStateType>> {
  return async (state, config) => {
    const spec = state.assemblySpec;
    if (!spec) {
      return {
        currentCode: state.currentCode,
        attemptCount: state.attemptCount + 1,
        buildFallbacks: 0,
        buildNotes: [],
        gateAction: null,
        gateFeedback: null,
        failureKind: 'none',
      };
    }

    const maxTurns = parsePositiveInt(process.env.CADAI_AGENT_MAX_TURNS, 6);
    const maxRenders = parsePositiveInt(process.env.CADAI_AGENT_MAX_RENDERS, 3);
    const maxWallSec = parsePositiveFloat(process.env.CADAI_AGENT_MAX_WALL_S, 180);
    const maxUsd = parsePositiveFloat(process.env.CADAI_AGENT_MAX_USD, 0.60);

    const initialWallMs = typeof state.buildWallMs === 'number' ? state.buildWallMs : 0;
    let accumulatedCostUsd = typeof state.buildCostUsd === 'number' ? state.buildCostUsd : 0;
    const visitStartMs = Date.now();
    const modelSlug = process.env.CADAI_MODEL ?? DEFAULT_MODEL;

    const specComponentNames = (spec.components ?? []).map((c) => c.name);
    const startingScript = state.currentCode || emitBrepScript(spec).script;

    const startingGuard = checkScriptGuardrails(startingScript);
    let lastScript = startingGuard.ok ? startingScript : '';
    let lastOkScript = '';
    let renderCount = 0;
    let geoRuns = 0;
    const MAX_GEO_RUNS = 15;
    let finished = false;
    let finishNotes: string[] = [];
    let finishOmitted: Array<{ component: string; reason: string }> = [];

    const evidenceStore = new Map<string, ScriptEvidence>();
    function getEvidence(script: string): ScriptEvidence {
      const key = scriptBaseKey(script);
      let ev = evidenceStore.get(key);
      if (!ev) {
        ev = { testedPoints: new Map() };
        evidenceStore.set(key, ev);
      }
      return ev;
    }

    const runScriptTool = new DynamicStructuredTool({
      name: 'run_script',
      description: 'Run a complete build123d Python script and return geometric measurements, validity, interferences, and floor/floating notes.',
      schema: z.object({
        script: z.string().describe('The complete build123d Python script to execute.'),
      }),
      func: async () => 'handled in loop',
    });

    const renderTool = new DynamicStructuredTool({
      name: 'render',
      description: 'Re-run the last script with optional parameter overrides and render views (front, right, top, iso) as PNG images to visually inspect clearances and motion.',
      schema: z.object({
        views: z.array(z.enum(['front', 'right', 'top', 'iso'])).optional().describe('Views to render (default: front, right, top, iso).'),
        overrides: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional().describe('Top-level parameter overrides, e.g. {"lid_open_deg": 100}.'),
      }),
      func: async () => 'handled in loop',
    });

    const finishTool = new DynamicStructuredTool({
      name: 'finish',
      description: 'End the agent build loop with the final script and design notes/interpretations. Call this only after verifying geometry with run_script and visually inspecting motion and clearances with render.',
      schema: z.object({
        script: z.string().optional().describe('The final complete build123d Python script.'),
        notes: z.union([z.array(z.string()), z.string()]).optional().describe('Short interpretations shown to the user (e.g. clearance choices, consolidation reasons).'),
        omitted: z.array(z.object({
          component: z.string().describe('Name of the spec component deliberately omitted or replaced'),
          reason: z.string().describe('Reason for omitting or replacing the spec component'),
        })).optional().describe('Components from the spec deliberately omitted or replaced.'),
        requirements: z.array(z.object({
          id: z.string().describe('Requirement id from the checklist'),
          status: z.enum(['met', 'partly', 'unmet']).describe('Status of the requirement'),
          evidence: z.string().optional().describe('Evidence or reason explaining the status, required if unmet or partly'),
        })).optional().describe('Self-check against the atomic requirements checklist.'),
      }),
      func: async () => 'handled in loop',
    });

    const tools = [runScriptTool, renderTool, finishTool];
    const boundModel = typeof model.bindTools === 'function'
      ? model.bindTools(tools, { tool_choice: 'auto' })
      : model;

    // Build the initial conversation
    const humanMessages = state.messages.filter((m) => m._getType() === 'human');
    const userPrompt = humanMessages.length > 0 ? contentText(humanMessages[0]) : 'Design the dock.';
    const compactSpec = renderCompactSpec(spec);
    const movingNeeded = hasMovingPart(userPrompt, spec);

    const checklist = await getBuildRequirements(userPrompt, {
      customModel: model,
      signal: config?.signal,
      callbacks: config?.callbacks,
      buildId: (config as unknown as { configurable?: { thread_id?: string }; runId?: string })?.configurable?.thread_id ?? (config as unknown as { runId?: string })?.runId,
    });

    let promptText = `User Request:\n${userPrompt}\n\nApproved Spec:\n${compactSpec}\n\nStarting Script:\n\`\`\`python\n${startingScript}\n\`\`\``;
    if (state.failureKind !== 'none' && state.failureKind !== 'no_code') {
      const lastMsg = state.messages[state.messages.length - 1];
      const rep = lastMsg ? contentText(lastMsg) : '';
      if (rep.includes('[Validation Report]')) {
        promptText += `\n\nPrevious attempt failed validation:\n${rep}`;
      }
    }
    promptText += '\n\nAtomic Requirements Checklist:\n' +
      checklist.requirements.map((r) => `- [${r.id}] (${r.kind}): ${r.text}`).join('\n');
    promptText += '\n\nRefine the starting script into the complete parametric design. Keep the script contract and product engineering guidelines. Use `run_script` to check geometry and interferences, use `render` with parameter overrides to visually inspect clearances and motion (e.g. testing lid_open_deg at its range max), and call `finish` with the final script, design notes, requirements self-check, and any omitted components when done.';

    const conversation: BaseMessage[] = [
      cachedSystemMessage(BREP_AGENT_SYSTEM_PROMPT),
      new HumanMessage(promptText),
    ];

    let budgetExceededReason: string | null = null;
    const initialElapsedWallSec = initialWallMs / 1000;
    if (initialElapsedWallSec >= maxWallSec) {
      budgetExceededReason = `wall time limit of ${maxWallSec}s exceeded (${initialElapsedWallSec.toFixed(1)}s elapsed across build)`;
    } else if (accumulatedCostUsd >= maxUsd) {
      budgetExceededReason = `cost budget of $${maxUsd.toFixed(2)} exceeded ($${accumulatedCostUsd.toFixed(4)} spent across build)`;
    }

    let turns = 0;
    while (turns < maxTurns && !finished) {
      if (budgetExceededReason) break;

      const elapsedWallSec = (initialWallMs + (Date.now() - visitStartMs)) / 1000;
      if (elapsedWallSec >= maxWallSec) {
        budgetExceededReason = `wall time limit of ${maxWallSec}s exceeded (${elapsedWallSec.toFixed(1)}s elapsed across build)`;
        console.warn(`brepAgentBuild: ${budgetExceededReason}`);
        break;
      }
      if (accumulatedCostUsd >= maxUsd) {
        budgetExceededReason = `cost budget of $${maxUsd.toFixed(2)} exceeded ($${accumulatedCostUsd.toFixed(4)} spent across build)`;
        console.warn(`brepAgentBuild: ${budgetExceededReason}`);
        break;
      }
      turns++;

      // Prune earlier render image blocks to stubs to conserve context window
      let renderImageCount = 0;
      for (let m = conversation.length - 1; m >= 0; m--) {
        const msg = conversation[m];
        if (msg instanceof ToolMessage && Array.isArray(msg.content)) {
          const hasImage = (msg.content as Array<{ type?: string }>).some((b) => b?.type === 'image_url');
          if (hasImage) {
            renderImageCount++;
            if (renderImageCount > 1) {
              msg.content = (msg.content as Array<{ type?: string; text?: string }>).map((b) => {
                if (b.type === 'image_url') {
                  return { type: 'text', text: '[Earlier render image omitted to conserve context]' };
                }
                return b;
              }) as never;
            }
          }
        }
      }

      let reply: AIMessage;
      try {
        reply = await boundModel.invoke(conversation, config);
      } catch (err) {
        if (config?.signal?.aborted) throw err;
        console.warn('brepAgentBuild model invocation failed:', err);
        config?.writer?.({ t: 'delta', text: 'model error encountered during agent build\n', node: 'brepAgentBuild' });
        break;
      }

      if (!reply) break;

      const usage = extractReplyUsage(reply);
      accumulatedCostUsd += estimateCostUsd(modelSlug, usage);

      const elapsedAfterModelSec = (initialWallMs + (Date.now() - visitStartMs)) / 1000;
      if (elapsedAfterModelSec >= maxWallSec) {
        budgetExceededReason = `wall time limit of ${maxWallSec}s exceeded (${elapsedAfterModelSec.toFixed(1)}s elapsed across build)`;
        console.warn(`brepAgentBuild: ${budgetExceededReason}`);
      } else if (accumulatedCostUsd >= maxUsd) {
        budgetExceededReason = `cost budget of $${maxUsd.toFixed(2)} exceeded ($${accumulatedCostUsd.toFixed(4)} spent across build)`;
        console.warn(`brepAgentBuild: ${budgetExceededReason}`);
      }
      if (budgetExceededReason) {
        break;
      }

      const stop = unusableStop(reply);
      if (stop) {
        console.warn(`brepAgentBuild: reply unusable (stop_reason ${stop})`);
        if (turns === 1 && !lastOkScript) {
          return {
            currentCode: state.currentCode,
            attemptCount: state.attemptCount + 1,
            buildFallbacks: 0,
            buildNotes: [],
            gateAction: null,
            gateFeedback: null,
            failureKind: isCutOff(stop) ? 'truncated' : 'no_code',
          };
        }
        break;
      }

      const invalidCalls = (reply as unknown as { invalid_tool_calls?: Array<{ id?: string; name?: string; error?: string }> }).invalid_tool_calls ?? [];
      for (const inv of invalidCalls) {
        conversation.push(new ToolMessage({
          tool_call_id: inv.id ?? `invalid_${Date.now()}`,
          name: inv.name ?? 'unknown',
          content: JSON.stringify({ ok: false, error: `Invalid tool call: ${inv.error ?? 'malformed arguments'}` }),
        }));
      }

      const rawToolCalls = reply.tool_calls ?? [];
      const toolCalls = rawToolCalls.slice(0, 5);
      const extraToolCalls = rawToolCalls.slice(5);
      conversation.push(reply);

      for (const extra of extraToolCalls) {
        conversation.push(new ToolMessage({
          tool_call_id: extra.id ?? `call_extra_${Date.now()}`,
          name: extra.name,
          content: JSON.stringify({ error: 'Tool call skipped: max 5 tool calls per reply.' }),
        }));
      }

      if (toolCalls.length === 0 && invalidCalls.length === 0) {
        // Model replied with text only without calling a tool; prompt it to continue.
        conversation.push(new HumanMessage('Please continue your design using run_script, render, or finish.'));
        continue;
      }

      for (const call of toolCalls) {
        const callId = call.id ?? `call_${Date.now()}`;

        if (finished) {
          conversation.push(new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: JSON.stringify({ error: 'Ignored: finish already accepted in this reply.' }),
          }));
          continue;
        }

        if (call.name === 'run_script') {
          const script = typeof call.args?.script === 'string' ? call.args.script : (lastScript || startingScript);

          const guard = checkScriptGuardrails(script);
          if (!guard.ok) {
            const errPayload = { ok: false, error: `Script guardrail rejection: ${guard.reason}` };
            config?.writer?.({ t: 'delta', text: 'run failed: guardrail rejection\n', node: 'brepAgentBuild' });
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify(errPayload),
            }));
            continue;
          }
          lastScript = script;

          if (geoRuns >= MAX_GEO_RUNS) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Geometry run budget exhausted (max ${MAX_GEO_RUNS} runs per visit). Call finish with your current design.` }),
            }));
            continue;
          }
          geoRuns++;

          const r = await runBrep(script, { interferences: true, connectivity: true, signal: config?.signal });
          if (config?.signal?.aborted) {
            throw Object.assign(new Error('The run was stopped during the geometry run.'), { name: 'AbortError' });
          }

          if (r.ok) {
            lastOkScript = script;
            const ev = getEvidence(script);
            const partBounds = new Map<string, ScriptPartBounds>();
            for (const part of r.parts) {
              partBounds.set(part.label, {
                min: [part.min[0], part.min[1], part.min[2]],
                max: [part.max[0], part.max[1], part.max[2]],
                volume: part.volume,
              });
            }
            ev.defaultParts = partBounds;

            const interferences = (r.interferences ?? [])
              .filter((i) => i.volume > 1.0)
              .map((i) => ({ a: i.a, b: i.b, volume: round2(i.volume) }));

            const poseParams = parsePoseParameters(script);
            for (const pp of poseParams) {
              if (!ev.testedPoints.has(pp.name)) ev.testedPoints.set(pp.name, []);
              ev.testedPoints.get(pp.name)!.push({
                value: pp.value,
                interferences: interferences.length,
                partBounds,
              });
            }

            const frames = toModuleFrames(r);
            const localFrames = r.local ? toModuleFrames({ ...r, parts: r.local }) : undefined;
            const placementReport = toPlacementReport(spec, frames, localFrames);
            const placementViolations = auditPlacement(placementReport, r.bbox?.min ?? null, spec);
            const jointedNames = new Set(
              (spec?.jointContracts ?? []).flatMap((j) => [j.partA, j.partB]).filter((n): n is string => Boolean(n))
            );

            const placementNotes = placementViolations
              .filter((v) => v.kind === 'floor' || (v.kind === 'floating' && !jointedNames.has(v.field)))
              .map((v) => v.message);
            const notes = [...(r.notes ?? []), ...placementNotes];

            if (r.disconnected && r.disconnected.length > 0) {
              for (const disc of r.disconnected) {
                notes.push(`'${disc}' is a disconnected part: it does not touch and is not within 0.5 mm of any other part in the closed pose.`);
              }
            }

            const nestingViolations = auditNesting(spec, r.parts, userPrompt);
            for (const nv of nestingViolations) {
              notes.push(nv.message);
            }

            const payload = {
              ok: true,
              solids: r.solids,
              bbox: r.bbox,
              parts: r.parts.map((p) => ({
                name: p.label,
                size: [
                  round2(p.max[0] - p.min[0]),
                  round2(p.max[1] - p.min[1]),
                  round2(p.max[2] - p.min[2]),
                ],
                min: p.min.map(round2),
                max: p.max.map(round2),
                volume: round2(p.volume),
                valid: p.valid,
              })),
              interferences,
              notes,
            };

            const deltaText = `run ok${interferences.length > 0 ? `, ${interferences.length} interference${interferences.length > 1 ? 's' : ''}` : ''}\n`;
            config?.writer?.({ t: 'delta', text: deltaText, node: 'brepAgentBuild' });

            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify(payload),
            }));
          } else {
            config?.writer?.({ t: 'delta', text: 'run failed: script error\n', node: 'brepAgentBuild' });

            const comp = componentAtLine(script, r.line, specComponentNames) || componentInTraceback(r.error ?? '', specComponentNames);
            const payload = {
              ok: false,
              error: r.error,
              line: r.line,
              component: comp || undefined,
              invalid: r.invalid,
            };

            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify(payload),
            }));
          }
        } else if (call.name === 'render') {
          if (renderCount >= maxRenders) {
            config?.writer?.({ t: 'delta', text: 'render skipped: budget exhausted\n', node: 'brepAgentBuild' });
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ error: `Render budget exhausted (max ${maxRenders} renders). Call run_script or finish.` }),
            }));
            continue;
          }

          renderCount++;
          const overrides = (call.args?.overrides as Record<string, number | string | boolean> | undefined);
          const views = (call.args?.views as ViewName[] | undefined) ?? ['front', 'right', 'top', 'iso'];

          const baseScript = lastScript || startingScript;
          const overriddenScript = applyParameterOverrides(baseScript, overrides);
          const guard = checkScriptGuardrails(overriddenScript);
          if (!guard.ok) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Render script guardrail failure: ${guard.reason}` }),
            }));
            continue;
          }

          const safeOverridePairs = overrides
            ? Object.entries(overrides)
                .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (typeof v === 'number' || typeof v === 'boolean'))
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')
            : '';
          config?.writer?.({ t: 'delta', text: `render${safeOverridePairs ? ` ${safeOverridePairs}` : ''}\n`, node: 'brepAgentBuild' });

          if (geoRuns >= MAX_GEO_RUNS) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Geometry run budget exhausted (max ${MAX_GEO_RUNS} runs per visit). Call finish with your current design.` }),
            }));
            continue;
          }
          geoRuns++;

          const r = await runBrep(overriddenScript, { interferences: true, connectivity: true, signal: config?.signal });
          if (config?.signal?.aborted) {
            throw Object.assign(new Error('The run was stopped during the geometry run.'), { name: 'AbortError' });
          }

          if (!r.ok || !r.stl) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Render geometry run failed: ${r.error ?? 'no stl'}` }),
            }));
            continue;
          }

          const renderInterferences = (r.interferences ?? [])
            .filter((i) => i.volume > 1.0)
            .map((i) => ({ a: i.a, b: i.b, volume: round2(i.volume) }));

          const ev = getEvidence(baseScript);
          const renderPartBounds = new Map<string, ScriptPartBounds>();
          for (const part of r.parts) {
            renderPartBounds.set(part.label, {
              min: [part.min[0], part.min[1], part.min[2]],
              max: [part.max[0], part.max[1], part.max[2]],
              volume: part.volume,
            });
          }

          if (overrides) {
            for (const [k, v] of Object.entries(overrides)) {
              if (typeof v === 'number' && Number.isFinite(v)) {
                if (!ev.testedPoints.has(k)) ev.testedPoints.set(k, []);
                ev.testedPoints.get(k)!.push({
                  value: v,
                  interferences: renderInterferences.length,
                  partBounds: renderPartBounds,
                });
              }
            }
          }

          const ascii = stlToAscii(r.stl);
          const renderedViews = renderStlViews(ascii, { views, size: 512 });

          const clashDesc = renderInterferences.length > 0
            ? ` (${renderInterferences.length} interference(s) detected: ${renderInterferences.map((i) => `${i.a} with ${i.b} [${i.volume} mm3]`).join(', ')})`
            : '';

          const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
            { type: 'text', text: `Rendered ${renderedViews.length} views${clashDesc}:` },
          ];
          for (const view of renderedViews) {
            contentBlocks.push({ type: 'text', text: `View: ${view.name}` });
            contentBlocks.push({ type: 'image_url', image_url: { url: view.dataUrl } });
          }

          conversation.push(new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: contentBlocks as never,
          }));
        } else if (call.name === 'finish') {
          const finalCandidateScript = (typeof call.args?.script === 'string' && call.args.script.trim())
            ? call.args.script
            : (lastOkScript || lastScript || startingScript);

          const guard = checkScriptGuardrails(finalCandidateScript);
          if (!guard.ok) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Finish rejected: Script guardrail failure (${guard.reason})` }),
            }));
            continue;
          }

          if (geoRuns >= MAX_GEO_RUNS) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Geometry run budget exhausted (max ${MAX_GEO_RUNS} runs per visit).` }),
            }));
            continue;
          }
          geoRuns++;

          const r = await runBrep(finalCandidateScript, { interferences: true, connectivity: true, signal: config?.signal });
          if (config?.signal?.aborted) {
            throw Object.assign(new Error('The run was stopped during the geometry run.'), { name: 'AbortError' });
          }

          if (!r.ok) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Finish rejected: Script execution failed (${r.error})` }),
            }));
            continue;
          }

          // Rule 1: Labels survive consolidation
          const omitted = (call.args?.omitted as Array<{ component: string; reason: string }> | undefined) ?? [];
          const emptyReason = omitted.find((o) => !o.reason || o.reason.trim().length < 5);
          if (emptyReason) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: `Finish rejected: Omitted component '${emptyReason.component}' has an empty or insufficient reason (must be at least 5 characters).`,
              }),
            }));
            continue;
          }

          if (specComponentNames.length > 0 && omitted.length >= specComponentNames.length) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: 'Finish rejected: Cannot omit all spec components.',
              }),
            }));
            continue;
          }
          if (specComponentNames.length > 2 && omitted.length > Math.ceil(specComponentNames.length * 0.5)) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: `Finish rejected: Too many components omitted (${omitted.length}/${specComponentNames.length}). At most 50% of components may be omitted.`,
              }),
            }));
            continue;
          }

          const omittedNames = new Set(omitted.map((o) => o.component));
          let omittedJointError: string | null = null;
          for (const j of spec?.jointContracts ?? []) {
            if (j.partA && j.partB && omittedNames.has(j.partA) && omittedNames.has(j.partB)) {
              omittedJointError = `Joint between '${j.partA}' and '${j.partB}' has both partners omitted. At least one partner must be present.`;
              break;
            }
          }
          if (omittedJointError) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Finish rejected: ${omittedJointError}` }),
            }));
            continue;
          }

          const omittedMap = new Map(omitted.map((o) => [o.component, o.reason]));
          const partLabels = new Set(r.parts.map((p) => p.label));
          const missingSpecComps = specComponentNames.filter((name) => !partLabels.has(name) && !omittedMap.has(name));
          if (missingSpecComps.length > 0) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: `Finish rejected: Spec component(s) [${missingSpecComps.join(', ')}] missing from _cadai_parts and not listed in omitted. Every spec component must have a labelled shape in _cadai_parts before fusing, or be declared in finish(omitted=[{component, reason}]).`,
              }),
            }));
            continue;
          }

          // Rule 2: Requirements check before finish
          const reqs = (call.args?.requirements as Array<{ id: string; status: 'met' | 'partly' | 'unmet'; evidence?: string }> | undefined) ?? [];
          const reqsMap = new Map(reqs.map((r) => [r.id, r]));
          const missingReqIds = checklist.requirements.map((r) => r.id).filter((id) => !reqsMap.has(id));
          if (missingReqIds.length > 0) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: `Finish rejected: Requirement(s) [${missingReqIds.join(', ')}] missing from finish requirements checklist. Every atomic requirement must be accounted for.`,
              }),
            }));
            continue;
          }

          const lackingEvidence = reqs.find((r) => (r.status === 'unmet' || r.status === 'partly') && (!r.evidence || r.evidence.trim().length < 5));
          if (lackingEvidence) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: `Finish rejected: Requirement '${lackingEvidence.id}' is marked ${lackingEvidence.status} without an explanation in evidence.`,
              }),
            }));
            continue;
          }

          // Rule 3: Moving parts must move and pose parameters default to home pose
          const candidatePoseParams = parsePoseParameters(finalCandidateScript);
          let poseError: string | null = null;
          for (const pp of candidatePoseParams) {
            if (Math.abs(pp.value - pp.min) > 1e-4) {
              poseError = `Pose parameter '${pp.name}' defaults to ${pp.value}, but must default to its closed/home pose (their range min ${pp.min}); the model the user sees first is closed. Set ${pp.name} = ${pp.min} in the script before finish.`;
              break;
            }
          }

          if (poseError) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Finish rejected: ${poseError}` }),
            }));
            continue;
          }

          if (movingNeeded) {
            if (candidatePoseParams.length === 0) {
              conversation.push(new ToolMessage({
                tool_call_id: callId,
                name: call.name,
                content: JSON.stringify({
                  ok: false,
                  error: 'Finish rejected: Moving parts requested/specified, but script does not expose a pose parameter ending in _deg or _travel with a range (e.g. lid_open_deg = 0  # [0:5:120] lid opening angle in degrees).',
                }),
              }));
              continue;
            }

            const ev = getEvidence(finalCandidateScript);
            if (!ev.defaultParts) {
              const partBounds = new Map<string, ScriptPartBounds>();
              for (const part of r.parts) {
                partBounds.set(part.label, {
                  min: [part.min[0], part.min[1], part.min[2]],
                  max: [part.max[0], part.max[1], part.max[2]],
                  volume: part.volume,
                });
              }
              ev.defaultParts = partBounds;
            }

            for (const pp of candidatePoseParams) {
              const points = ev.testedPoints.get(pp.name) ?? [];
              const maxPoint = points.find((pt) => Math.abs(pt.value - pp.max) <= 1e-2);
              if (!maxPoint) {
                poseError = `Pose parameter '${pp.name}' was not run at its range max (${pp.max}) on this script version. Run render or run_script with ${pp.name}=${pp.max} before finish.`;
                break;
              }
              if (pp.min !== 0) {
                const minPoint = points.find((pt) => Math.abs(pt.value - pp.min) <= 1e-2);
                if (!minPoint) {
                  poseError = `Pose parameter '${pp.name}' was not run at its range min (${pp.min}) on this script version. Run render or run_script with ${pp.name}=${pp.min} before finish.`;
                  break;
                }
                if (minPoint.interferences > 0) {
                  poseError = `Pose parameter '${pp.name}' has unintended collision(s) at range min (${pp.min}). Clear clearances before finish.`;
                  break;
                }
              }

              if (maxPoint.interferences > 0) {
                poseError = `Pose parameter '${pp.name}' has unintended collision(s) at range max (${pp.max}). Clear clearances before finish.`;
                break;
              }

              // Volume check: pose parameter must not change part volume compared to this script's default run
              for (const [pName, maxBounds] of maxPoint.partBounds.entries()) {
                const baseBounds = ev.defaultParts?.get(pName);
                if (baseBounds && baseBounds.volume > 1.0) {
                  const delta = Math.abs(maxBounds.volume - baseBounds.volume);
                  if (delta > 1.0 && delta / baseBounds.volume > 0.02) {
                    poseError = `Pose parameter '${pp.name}' changes the size/volume of part '${pName}' (from ${round2(baseBounds.volume)} to ${round2(maxBounds.volume)} mm3). A pose parameter must change position/rotation, never size.`;
                    break;
                  }
                }
              }
              if (poseError) break;

              // Motion check: at least one part's bbox must change between default and max
              let anyPartMoved = false;
              for (const [pName, maxBounds] of maxPoint.partBounds.entries()) {
                const baseBounds = ev.defaultParts?.get(pName);
                if (baseBounds) {
                  const diff = Math.max(
                    Math.abs(maxBounds.min[0] - baseBounds.min[0]),
                    Math.abs(maxBounds.min[1] - baseBounds.min[1]),
                    Math.abs(maxBounds.min[2] - baseBounds.min[2]),
                    Math.abs(maxBounds.max[0] - baseBounds.max[0]),
                    Math.abs(maxBounds.max[1] - baseBounds.max[1]),
                    Math.abs(maxBounds.max[2] - baseBounds.max[2]),
                  );
                  if (diff > 0.1) {
                    anyPartMoved = true;
                    break;
                  }
                }
              }
              if (!anyPartMoved) {
                poseError = `Pose parameter '${pp.name}' does not move any part in the geometry (all parts have identical bounding boxes between default and max).`;
                break;
              }
            }

            if (poseError) {
              conversation.push(new ToolMessage({
                tool_call_id: callId,
                name: call.name,
                content: JSON.stringify({ ok: false, error: `Finish rejected: ${poseError}` }),
              }));
              continue;
            }
          }

          // Rule 4: Connectivity check
          if (r.disconnected && r.disconnected.length > 0) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: `Finish rejected: Disconnected part(s) detected: ${r.disconnected.join(', ')}. All parts in the closed pose must touch or be within 0.5 mm of another part (or pin in bore with <= 1 mm clearance).`,
              }),
            }));
            continue;
          }

          // Rule 5: Nesting check
          const nestingViolations = auditNesting(spec, r.parts, userPrompt);
          const nestingErrors = nestingViolations.filter((v) => v.severity === 'error');
          if (nestingErrors.length > 0) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: `Finish rejected: ${nestingErrors[0].message}`,
              }),
            }));
            continue;
          }

          // Everything passed!
          finished = true;
          lastScript = finalCandidateScript;
          lastOkScript = finalCandidateScript;

          if (call.args?.notes) {
            finishNotes = Array.isArray(call.args.notes)
              ? call.args.notes.filter((n): n is string => typeof n === 'string')
              : [String(call.args.notes)];
          }

          finishOmitted = omitted;
          for (const req of reqs) {
            if (req.status !== 'met') {
              finishNotes.push(`Requirement [${req.id}] ${req.status}: ${req.evidence ?? ''}`);
            }
          }

          config?.writer?.({ t: 'delta', text: 'finished\n', node: 'brepAgentBuild' });

          conversation.push(new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: JSON.stringify({ status: 'finished' }),
          }));
        } else {
          conversation.push(new ToolMessage({
            tool_call_id: callId,
            name: call.name,
            content: JSON.stringify({ error: `Unknown tool "${call.name}".` }),
          }));
        }
      }
    }

    if (budgetExceededReason) {
      const budgetNote = `Agent build ended: ${budgetExceededReason}.`;
      finishNotes.push(budgetNote);
      config?.writer?.({ t: 'delta', text: `${budgetNote}\n`, node: 'brepAgentBuild' });
    }

    let finalScript = '';
    if (lastOkScript && checkScriptGuardrails(lastOkScript).ok) {
      finalScript = lastOkScript;
    } else if (lastScript && checkScriptGuardrails(lastScript).ok) {
      finalScript = lastScript;
    } else if (startingScript && checkScriptGuardrails(startingScript).ok) {
      finalScript = startingScript;
    }

    const seenNotes = new Set<string>();
    const allBuildNotes: Array<{ name: string; reason: string }> = [];
    for (const note of [
      ...(state.buildNotes ?? []).filter((n) => !n.reason.startsWith('Agent build ended:')),
      ...finishOmitted.map((o) => ({ name: o.component, reason: o.reason })),
      ...finishNotes.map((reason) => ({ name: '', reason })),
    ]) {
      const key = `${note.name}::${note.reason}`;
      if (!seenNotes.has(key)) {
        seenNotes.add(key);
        allBuildNotes.push(note);
      }
    }

    const totalVisitWallMs = Date.now() - visitStartMs;

    return {
      currentCode: finalScript,
      attemptCount: state.attemptCount + 1,
      buildFallbacks: 0,
      buildNotes: allBuildNotes,
      buildWallMs: initialWallMs + totalVisitWallMs,
      buildCostUsd: accumulatedCostUsd,
      gateAction: null,
      gateFeedback: null,
      failureKind: finalScript ? 'none' : 'compile',
    };
  };
}
