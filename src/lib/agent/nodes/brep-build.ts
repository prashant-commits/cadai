import { HumanMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AssemblySpec } from '../assembly-spec';
import { parseBuild } from '../build-format';
import type { AgentStateType } from '../graph';
import { isCutOff, unusableStop } from '../llm-schemas';
import { cachedSystemMessage, systemPromptFor } from '../system-prompt';
import { blockoutBody } from '../../brep/blockout-b123d';
import { specNames } from '../../brep/py-names';
import { emitBrepScript } from '../../brep/emit-script';
import { countFallbacks, messageText, planBuildVisit } from './architect-build';

/**
 * Post-gate Architect call under CADAI_KERNEL=brep. Same visit logic as
 * architectBuild (only the components named by an error or a human note are
 * rewritten), but the bodies are build123d function bodies and code emits the
 * whole script. A missing or rejected body falls back to the blockout.
 * A reply that stopped short (max_tokens, context window) or was refused builds nothing: the
 * attempt is marked `truncated` / `no_code` and validateBrep takes the failed-attempt path.
 */
export function makeBrepBuild(model: {
  invoke(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage>;
}): (state: AgentStateType, config?: RunnableConfig) => Promise<Partial<AgentStateType>> {
  return async (state, config) => {
    const attemptCount = state.attemptCount + 1;
    const spec = state.assemblySpec;
    if (!spec) {
      return { currentCode: state.currentCode, attemptCount, buildFallbacks: 0, buildNotes: [], gateAction: null, gateFeedback: null, failureKind: 'none' };
    }

    const { componentNames, reserved, changes, ask, keep } = planBuildVisit(state, spec);

    const reply = await model.invoke(
      [cachedSystemMessage(systemPromptFor('brep-build')), new HumanMessage(humanPrompt(spec, changes, ask, keep, state.failureKind === 'truncated'))],
      config,
    );

    // A cut-off reply holds half a body and a refusal holds none: neither is emitted as a script.
    const stop = unusableStop(reply);
    if (stop) {
      console.warn(`brepBuild: reply unusable (stop_reason ${stop})`);
      return {
        currentCode: state.currentCode,
        attemptCount,
        buildFallbacks: 0,
        buildNotes: [],
        gateAction: null,
        gateFeedback: null,
        failureKind: isCutOff(stop) ? 'truncated' : 'no_code',
      };
    }

    const { names } = specNames(spec, String);
    const parsed = parseBuild(messageText(reply), componentNames, reserved.map((r) => names.map.get(r) ?? r), { language: 'python' });
    if (keep.length > 0 && state.currentCode) {
      for (const name of keep) {
        if (Object.prototype.hasOwnProperty.call(parsed.bodies, name)) continue;
        if (parsed.keepBlockout.includes(name)) continue;
        const previous = extractFunctionBody(state.currentCode, name);
        if (previous === null) continue;
        parsed.bodies[name] = previous;
        const droppedAt = parsed.dropped.indexOf(name);
        if (droppedAt >= 0) parsed.dropped.splice(droppedAt, 1);
      }
    }

    const { script, skipped } = emitBrepScript(spec, parsed.bodies);
    // A body the parser accepted (or kept from the previous build) can still be rejected by the
    // emitter's own check; it is then drawn from the blockout and counted as a fallback too.
    const emitterRejected = skipped.filter((note) => /^body rejected/.test(note.reason) && Object.prototype.hasOwnProperty.call(parsed.bodies, note.name));
    // Why the parser refused a body, so the user and the next build visit are told it, not just that the blockout was drawn.
    // Only a refusal that is still the outcome counts: a part that ended up with a body (sent again, or kept from the previous build) was not drawn from the blockout.
    const refused = parsed.rejections
      .filter((item) => !Object.prototype.hasOwnProperty.call(parsed.bodies, item.name))
      .map((item) => ({ name: item.name, reason: `body rejected (${item.reason}); drawn from the blockout` }));
    return {
      currentCode: script,
      attemptCount,
      buildFallbacks: countFallbacks(componentNames, parsed, (name) => blockoutFor(spec, name) !== null) + emitterRejected.length,
      buildNotes: [...refused, ...skipped],
      gateAction: null,
      gateFeedback: null,
      failureKind: 'none',
    };
  };
}

function blockoutFor(spec: AssemblySpec, name: string): string | null {
  const component = (spec.components ?? []).find((c) => c.name === name);
  if (!component) return null;
  try {
    return blockoutBody(component, specNames(spec, String).names.ctx);
  } catch {
    return null;
  }
}

/** The retry line after a reply that hit the output limit, as the spec retry does. */
export const SHORTER_REPLY =
  'Your previous reply was cut off at the output limit before every @body section was complete. Reply again more concisely: only @body sections, each body as short as the geometry allows, no comments, no repeated code, and `@body <name> blockout` for a part whose blockout already fits.';

function humanPrompt(spec: AssemblySpec, changes: string | null, ask: string[], keep: string[], cutOff = false): string {
  const { sheet, ...skeleton } = spec;
  // The names as the script spells them (a name the script uses itself is prefixed `p_`).
  const { names } = specNames(spec, String);
  const parameters = (spec.parameters ?? []).map((parameter) => names.map.get(parameter.name) ?? parameter.name);
  if (names.map.has('edge_r') && !parameters.includes(names.map.get('edge_r')!)) {
    parameters.push(names.map.get('edge_r')!);
  }
  if (names.map.has('minor_r') && !parameters.includes(names.map.get('minor_r')!)) {
    parameters.push(names.map.get('minor_r')!);
  }
  const derived = (spec.derived ?? []).map((item) => names.map.get(item.name) ?? item.name);
  const blockouts = (spec.components ?? []).map((component) => {
    const body = blockoutFor(spec, component.name);
    return body === null ? `# ${component.name}: no blockout` : `@body ${component.name}\n${body}\n@end`;
  });
  const parts = [
    cutOff ? SHORTER_REPLY : null,
    changes,
    `Spec skeleton (JSON):\n${JSON.stringify(skeleton, null, 2)}`,
    `Sheet:\n${sheet ?? ''}`,
    `Parameter names: ${parameters.length ? parameters.join(', ') : '(none)'}`,
    `Derived names: ${derived.length ? derived.join(', ') : '(none)'}`,
    `Blockout starting point for each component (build123d):\n${blockouts.join('\n\n')}`,
    askLine(ask, keep),
  ].filter((part): part is string => Boolean(part));
  return parts.join('\n\n');
}

function askLine(ask: string[], keep: string[]): string {
  if (ask.length === 0) return 'The spec names no components. Reply with no @body sections.';
  if (keep.length === 0) return `Write a function body for every component: ${ask.join(', ')}.`;
  return `Write a function body only for: ${ask.join(', ')}. Do not send ${keep.join(', ')}; each keeps its body from the previous build.`;
}

/**
 * The dedented body of `def <name>():` in an emitted script (also `<name>_part`,
 * which the emitter uses when the name collides with a parameter). It runs to
 * the next line at column 0.
 */
export function extractFunctionBody(code: string, name: string): string | null {
  const lines = code.split('\n');
  const headers = new Set([`def ${name}():`, `def ${name}_part():`]);
  const start = lines.findIndex((line) => headers.has(line.trimEnd()));
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && !/^[ \t]/.test(line)) break;
    body.push(line.startsWith('    ') ? line.slice(4) : line.trimStart());
  }
  const text = body.join('\n').replace(/\s+$/, '');
  return text.trim() === '' ? null : text;
}
