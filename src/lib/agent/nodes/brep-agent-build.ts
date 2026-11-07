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
1. Top-level parameter lines: keep the format \`name = value  # [min:step:max] description\`. Add parameters for moving-part poses with sensible ranges (e.g. lid_open_deg = 0  # [0:5:120] lid opening angle in degrees), and narrow a range when a clash makes part of it unusable, explaining why in finish notes.
2. Labelled parts in \`_cadai_parts\`: keep \`_cadai_parts\` as a list of labelled shapes measured before fusing. Labels must match the spec component names. You may add parts; every spec component should still exist unless your finish notes explain a consolidation.
3. Exported shape: assign the final fused Compound / Part to \`result\`.
4. Imports: no imports beyond the existing prelude.
5. Guardrail rules: use algebra mode only (never \`with BuildPart\`, \`with BuildSketch\`, \`with BuildLine\`). No \`open\`, \`eval\`, \`exec\`, \`os\`, \`sys\`, dunder methods (\`__\`), or file keywords.

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

    let promptText = `User Request:\n${userPrompt}\n\nApproved Spec:\n${compactSpec}\n\nStarting Script:\n\`\`\`python\n${startingScript}\n\`\`\``;
    if (state.failureKind !== 'none' && state.failureKind !== 'no_code') {
      const lastMsg = state.messages[state.messages.length - 1];
      const rep = lastMsg ? contentText(lastMsg) : '';
      if (rep.includes('[Validation Report]')) {
        promptText += `\n\nPrevious attempt failed validation:\n${rep}`;
      }
    }
    promptText += '\n\nRefine the starting script into the complete parametric design. Keep the script contract and product engineering guidelines. Use `run_script` to check geometry and interferences, use `render` with parameter overrides to visually inspect clearances and motion (e.g. testing lid_open_deg), and call `finish` with the final script and design notes when done.';

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

            const frames = toModuleFrames(r);
            const localFrames = r.local ? toModuleFrames({ ...r, parts: r.local }) : undefined;
            const placementReport = toPlacementReport(spec, frames, localFrames);
            const placementViolations = auditPlacement(placementReport, r.bbox?.min ?? null, spec);
            const notes = placementViolations
              .filter((v) => v.kind === 'floor' || v.kind === 'floating')
              .map((v) => v.message);

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
          const r = await runBrep(overriddenScript, { signal: config?.signal });
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

          const ascii = stlToAscii(r.stl);
          const renderedViews = renderStlViews(ascii, { views, size: 512 });

          const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
            { type: 'text', text: `Rendered ${renderedViews.length} views${overrideText ? ` (${overrideText})` : ''}:` },
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
          finished = true;
          if (typeof call.args?.script === 'string' && call.args.script.trim()) {
            lastScript = call.args.script;
            lastOkScript = call.args.script;
          }
          if (call.args?.notes) {
            finishNotes = Array.isArray(call.args.notes)
              ? call.args.notes.filter((n): n is string => typeof n === 'string')
              : [String(call.args.notes)];
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

    return {
      currentCode: finalScript,
      attemptCount: state.attemptCount + 1,
      buildFallbacks: 0,
      buildNotes: finishNotes.map((reason) => ({ name: '', reason })),
      gateAction: null,
      gateFeedback: null,
      failureKind: finalScript ? 'none' : 'compile',
    };
  };
}
