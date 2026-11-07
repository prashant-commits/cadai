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
  const remaining = { ...overrides };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^#\n]+?)(\s*(?:#.*)?)$/.exec(line);
    if (match) {
      const name = match[1];
      if (Object.prototype.hasOwnProperty.call(remaining, name)) {
        lines[i] = `${name} = ${remaining[name]}${match[3]}`;
        delete remaining[name];
      }
    }
  }

  if (Object.keys(remaining).length > 0) {
    const insertIdx = lines.findIndex((l) => l.startsWith('# ---- parameters') || l.startsWith('from build123d'));
    const extraLines = Object.entries(remaining).map(([k, v]) => `${k} = ${v}`);
    if (insertIdx >= 0) {
      lines.splice(insertIdx + 1, 0, ...extraLines);
    } else {
      lines.unshift(...extraLines);
    }
  }

  return lines.join('\n');
}

export function checkScriptGuardrails(script: string): { ok: boolean; reason?: string } {
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(script)) {
    return { ok: false, reason: 'control character in script' };
  }
  const lines = script.split('\n');
  let inPrelude = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    if (inPrelude) {
      if (
        line.startsWith('from build123d import') ||
        line.startsWith('from math import') ||
        line.startsWith('import math') ||
        line.startsWith('def _sind') ||
        line.startsWith('def _cosd') ||
        line.startsWith('def _tand') ||
        line.startsWith('def _fuse') ||
        line.startsWith('groups =') ||
        line.startsWith('merged =') ||
        line.startsWith('while merged') ||
        line.startsWith('for i in range') ||
        line.startsWith('for j in range') ||
        line.startsWith('a, b =') ||
        line.startsWith('fused =') ||
        line.startsWith('if len(fused') ||
        line.startsWith('del groups') ||
        line.startsWith('if merged') ||
        line.startsWith('break') ||
        line.startsWith('out =') ||
        line.startsWith('for names,') ||
        line.startsWith('shape.label') ||
        line.startsWith('out.append') ||
        line.startsWith('return out')
      ) {
        continue;
      }
      inPrelude = false;
    }
    if (/^\s*(?:from\s+\S+\s+import|import\s+)/.test(line)) {
      return { ok: false, reason: `illegal import statement outside prelude: "${line}"` };
    }
    if (/with\s+Build(?:Part|Sketch|Line)/.test(line)) {
      return { ok: false, reason: 'builder mode context managers (with BuildPart, etc.) are forbidden; use algebra mode' };
    }
    const codePart = line.split('#')[0];
    if (/\b(?:open|eval|exec|compile|globals|locals|vars|getattr|setattr|delattr|os|sys|subprocess|shutil|socket|ctypes|importlib|pickle)\b/.test(codePart)) {
      return { ok: false, reason: `forbidden identifier in line: "${line}"` };
    }
    if (codePart.includes('__') && !codePart.includes('__main__')) {
      return { ok: false, reason: `dunder is forbidden: "${line}"` };
    }
  }
  return { ok: true };
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
1. Top-level parameter lines: keep the format \`name = value  # [min:step:max] description\`. Add parameters for moving-part poses with sensible ranges (e.g. lid_open_deg = 0  # [0:5:120] lid opening angle in degrees), and narrow a range when a clash makes part of it unusable, explaining why in finish notes. A pose parameter changes the part's position, never its size.
2. Labelled parts in \`_cadai_parts\`: \`_cadai_parts\` must contain one labelled shape per spec component (label = component name), measured BEFORE any fusing; consolidation happens only in \`result\`. Every spec component must exist in \`_cadai_parts\` unless deliberately removed/replaced and declared in \`finish(omitted=[{component, reason}])\`.
3. Exported shape: assign the final fused Compound / Part to \`result\`.
4. Imports: no imports beyond the existing prelude.
5. Guardrail rules: use algebra mode only (never \`with BuildPart\`, \`with BuildSketch\`, \`with BuildLine\`). No \`open\`, \`eval\`, \`exec\`, \`os\`, \`sys\`, dunder methods (\`__\`), or file keywords.

# VERIFICATION BEFORE FINISH
- Before finish, you must verify motion: if the model has a moving part, the script must expose a pose parameter (_deg or _travel with range). You must test the script at its range max (and min if not 0) using render or run_script and see zero unintended collisions.
- A pose parameter changes the part's position, never its size.
- Before finish, you must verify the atomic requirements checklist and report each requirement as met, partly, or unmet (with evidence).
- All parts must touch or be within 0.5 mm of another part in the closed pose (pin in bore clearance <= 1 mm). Disconnected parts are rejected.
- Inserted or stacking features must fit within their host opening without collision.

# BUILD123D CHEAT SHEET
${BREP_CHEATSHEET}`.trim();

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

    const maxTurns = Number(process.env.CADAI_AGENT_MAX_TURNS ?? 10);
    const maxRenders = Number(process.env.CADAI_AGENT_MAX_RENDERS ?? 6);

    const specComponentNames = (spec.components ?? []).map((c) => c.name);
    const startingScript = state.currentCode || emitBrepScript(spec).script;

    let lastScript = startingScript;
    let lastOkScript = '';
    let renderCount = 0;
    let finished = false;
    let finishNotes: string[] = [];
    let finishOmitted: Array<{ component: string; reason: string }> = [];

    const testedPoses = new Map<string, Set<number>>();
    const poseInterferences = new Map<string, Map<number, number>>();
    const posePartVolumes = new Map<string, Map<number, Map<string, number>>>();
    const defaultPartVolumes = new Map<string, number>();

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

    const checklist = await getBuildRequirements(userPrompt, undefined, model);

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

    let turns = 0;
    while (turns < maxTurns && !finished) {
      turns++;

      let reply: AIMessage;
      try {
        reply = await boundModel.invoke(conversation, config);
      } catch (err) {
        if (config?.signal?.aborted) throw err;
        console.warn('brepAgentBuild model invocation failed:', err);
        break;
      }

      if (!reply) break;

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

      const toolCalls = reply.tool_calls ?? [];
      conversation.push(reply);

      if (toolCalls.length === 0) {
        // Model replied with text only without calling a tool; prompt it to continue.
        conversation.push(new HumanMessage('Please continue your design using run_script, render, or finish.'));
        continue;
      }

      for (const call of toolCalls) {
        const callId = call.id ?? `call_${Date.now()}`;
        if (call.name === 'run_script') {
          const script = typeof call.args?.script === 'string' ? call.args.script : lastScript;
          lastScript = script;

          const guard = checkScriptGuardrails(script);
          if (!guard.ok) {
            const errPayload = { ok: false, error: `Script guardrail rejection: ${guard.reason}` };
            config?.writer?.({ t: 'delta', text: `run failed: guardrail (${guard.reason})\n`, node: 'brepAgentBuild' });
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify(errPayload),
            }));
            continue;
          }

          const r = await runBrep(script, { interferences: true, signal: config?.signal });
          if (config?.signal?.aborted) {
            throw Object.assign(new Error('The run was stopped during the geometry run.'), { name: 'AbortError' });
          }

          if (r.ok) {
            lastOkScript = script;
            const interferences = (r.interferences ?? [])
              .filter((i) => i.volume > 1.0)
              .map((i) => ({ a: i.a, b: i.b, volume: round2(i.volume) }));

            // Record tested pose parameter from script if present
            const poseParams = parsePoseParameters(script);
            for (const pp of poseParams) {
              if (!testedPoses.has(pp.name)) testedPoses.set(pp.name, new Set());
              testedPoses.get(pp.name)!.add(pp.value);
              if (!poseInterferences.has(pp.name)) poseInterferences.set(pp.name, new Map());
              poseInterferences.get(pp.name)!.set(pp.value, interferences.length);
              if (!posePartVolumes.has(pp.name)) posePartVolumes.set(pp.name, new Map());
              const vMap = new Map<string, number>();
              for (const part of r.parts) vMap.set(part.label, part.volume);
              posePartVolumes.get(pp.name)!.set(pp.value, vMap);
            }

            // Save default volumes if not yet set
            if (defaultPartVolumes.size === 0) {
              for (const part of r.parts) defaultPartVolumes.set(part.label, part.volume);
            }

            const frames = toModuleFrames(r);
            const localFrames = r.local ? toModuleFrames({ ...r, parts: r.local }) : undefined;
            const placementReport = toPlacementReport(spec, frames, localFrames);
            const placementViolations = auditPlacement(placementReport, r.bbox?.min ?? null, spec);

            const jointedNames = new Set(
              (spec?.jointContracts ?? []).flatMap((j) => [j.partA, j.partB]).filter((n): n is string => Boolean(n))
            );

            // Replace floating warning for jointed parts with connectivity check
            const notes = placementViolations
              .filter((v) => v.kind === 'floor' || (v.kind === 'floating' && !jointedNames.has(v.field) && !/lid|pin|drawer|slide|hinge/i.test(v.field)))
              .map((v) => v.message);

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
            const tail = r.error ? r.error.split('\n').filter(Boolean).pop()?.slice(0, 80) : 'failed';
            config?.writer?.({ t: 'delta', text: `run failed: ${tail}\n`, node: 'brepAgentBuild' });

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

          const overrideText = overrides && Object.keys(overrides).length > 0
            ? Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(' ')
            : '';
          config?.writer?.({ t: 'delta', text: `render${overrideText ? ` ${overrideText}` : ''}\n`, node: 'brepAgentBuild' });

          const overriddenScript = applyParameterOverrides(lastScript, overrides);
          const r = await runBrep(overriddenScript, { interferences: true, signal: config?.signal });
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

          // Track overrides for pose parameters
          if (overrides) {
            for (const [k, v] of Object.entries(overrides)) {
              if ((k.endsWith('_deg') || k.endsWith('_travel')) && typeof v === 'number') {
                if (!testedPoses.has(k)) testedPoses.set(k, new Set());
                testedPoses.get(k)!.add(v);
                if (!poseInterferences.has(k)) poseInterferences.set(k, new Map());
                poseInterferences.get(k)!.set(v, renderInterferences.length);
                if (!posePartVolumes.has(k)) posePartVolumes.set(k, new Map());
                const vMap = new Map<string, number>();
                for (const part of r.parts) vMap.set(part.label, part.volume);
                posePartVolumes.get(k)!.set(v, vMap);
              }
            }
          }

          const ascii = stlToAscii(r.stl);
          const renderedViews = renderStlViews(ascii, { views, size: 512 });

          const clashDesc = renderInterferences.length > 0
            ? ` (${renderInterferences.length} interference(s) detected: ${renderInterferences.map((i) => `${i.a} with ${i.b} [${i.volume} mm3]`).join(', ')})`
            : '';

          const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
            { type: 'text', text: `Rendered ${renderedViews.length} views${overrideText ? ` (${overrideText})` : ''}${clashDesc}:` },
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
            : (lastOkScript || lastScript);

          const guard = checkScriptGuardrails(finalCandidateScript);
          if (!guard.ok) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({ ok: false, error: `Finish rejected: Script guardrail failure (${guard.reason})` }),
            }));
            continue;
          }

          const r = await runBrep(finalCandidateScript, { interferences: true, signal: config?.signal });
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

          // Rule 2: Moving parts must move
          if (movingNeeded) {
            const poseParams = parsePoseParameters(finalCandidateScript);
            if (poseParams.length === 0) {
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

            let poseError: string | null = null;
            for (const pp of poseParams) {
              const testedSet = testedPoses.get(pp.name);
              const maxTested = testedSet && Array.from(testedSet).some((v) => Math.abs(v - pp.max) <= 1e-2);
              if (!maxTested) {
                poseError = `Pose parameter '${pp.name}' was not run at its range max (${pp.max}). Run render or run_script with ${pp.name}=${pp.max} before finish.`;
                break;
              }
              if (pp.min !== 0) {
                const minTested = testedSet && Array.from(testedSet).some((v) => Math.abs(v - pp.min) <= 1e-2);
                if (!minTested) {
                  poseError = `Pose parameter '${pp.name}' was not run at its range min (${pp.min}). Run render or run_script with ${pp.name}=${pp.min} before finish.`;
                  break;
                }
              }

              // Check interferences at pose max
              const interfsAtMax = poseInterferences.get(pp.name)?.get(pp.max) ?? 0;
              if (interfsAtMax > 0) {
                poseError = `Pose parameter '${pp.name}' has unintended collision(s) at range max (${pp.max}). Clear clearances before finish.`;
                break;
              }

              // Check if pose parameter changes part size
              const volsAtMax = posePartVolumes.get(pp.name)?.get(pp.max);
              if (volsAtMax) {
                for (const [pName, pVol] of volsAtMax.entries()) {
                  const defVol = defaultPartVolumes.get(pName);
                  if (defVol !== undefined && defVol > 1.0) {
                    const delta = Math.abs(pVol - defVol);
                    if (delta > 1.0 && delta / defVol > 0.02) {
                      poseError = `Pose parameter '${pp.name}' changes the size/volume of part '${pName}' (from ${round2(defVol)} to ${round2(pVol)} mm3). A pose parameter must change position/rotation, never size.`;
                      break;
                    }
                  }
                }
                if (poseError) break;
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

          // Rule 3: Requirements check before finish
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

          const unmetWithoutReason = reqs.find((r) => r.status === 'unmet' && (!r.evidence || !r.evidence.trim()));
          if (unmetWithoutReason) {
            conversation.push(new ToolMessage({
              tool_call_id: callId,
              name: call.name,
              content: JSON.stringify({
                ok: false,
                error: `Finish rejected: Requirement '${unmetWithoutReason.id}' is marked unmet without an explanation in evidence.`,
              }),
            }));
            continue;
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

    const finalScript = lastOkScript || lastScript;

    const allBuildNotes: Array<{ name: string; reason: string }> = [
      ...finishOmitted.map((o) => ({ name: o.component, reason: o.reason })),
      ...finishNotes.map((reason) => ({ name: '', reason })),
    ];

    return {
      currentCode: finalScript,
      attemptCount: state.attemptCount + 1,
      buildFallbacks: 0,
      buildNotes: allBuildNotes,
      gateAction: null,
      gateFeedback: null,
      failureKind: finalScript ? 'none' : 'compile',
    };
  };
}
