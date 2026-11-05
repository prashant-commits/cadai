import { HumanMessage, SystemMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AssemblySpec } from '../assembly-spec';
import { requiredChanges } from '../architect-prompts';
import { assembleScript, parseBuild } from '../build-format';
import type { AgentStateType } from '../graph';
import { parameterBlock } from '../parameter-block';
import type { SpecViolation } from '../spec-audit';
import { systemPromptFor } from '../system-prompt';
import { blockoutBody } from '../../spec-sheet/blockout-scad';

/**
 * Post-gate Architect call. One module body per component, in that part's
 * local frame. A missing or unusable section falls back to the blockout.
 * On a later visit, only the components named by an error or a human note
 * are rewritten; every other part keeps the body already in currentCode.
 */
export function makeArchitectBuild(model: {
  invoke(messages: BaseMessage[], config?: RunnableConfig): Promise<AIMessage>;
}): (state: AgentStateType, config?: RunnableConfig) => Promise<Partial<AgentStateType>> {
  return async (state, config) => {
    const attemptCount = state.attemptCount + 1;
    const spec = state.assemblySpec;
    if (!spec) {
      return { currentCode: state.currentCode, attemptCount, buildFallbacks: 0 };
    }

    const componentNames = (spec.components ?? []).map((component) => component.name);
    const reserved = [
      ...(spec.parameters ?? []).map((parameter) => parameter.name),
      ...(spec.derived ?? []).map((derived) => derived.name),
    ];
    const findings = errorFindings(state.specViolations ?? [], componentNames);
    const notes = state.gateAction === 'revise' && state.gateFeedback ? [state.gateFeedback] : [];
    const changes = findings.length > 0 || notes.length > 0 ? requiredChanges(findings, notes) : null;

    const repeat = (state.currentCode ?? '').trim().length > 0;
    const named = componentsNamed(findings, notes, componentNames);
    const ask = repeat && named.length > 0 ? named : componentNames;
    const keep = componentNames.filter((name) => !ask.includes(name));

    const reply = await model.invoke(
      [new SystemMessage(systemPromptFor('build')), new HumanMessage(humanPrompt(spec, changes, ask, keep))],
      config,
    );

    const parsed = parseBuild(messageText(reply), componentNames, reserved);
    if (keep.length > 0 && state.currentCode) {
      for (const name of keep) {
        if (Object.prototype.hasOwnProperty.call(parsed.bodies, name)) continue;
        if (parsed.keepBlockout.includes(name) || parsed.dropped.includes(name)) continue;
        const previous = extractModuleBody(state.currentCode, name);
        if (previous === null) continue;
        parsed.bodies[name] = previous;
      }
    }

    return {
      currentCode: assembleScript(spec, parsed, parameterBlock(spec)),
      attemptCount,
      buildFallbacks: countFallbacks(spec, componentNames, parsed),
    };
  };
}

/** Error-severity violations, each issue naming its component, as major findings. */
function errorFindings(violations: SpecViolation[], names: string[]): { severity: string; issue: string }[] {
  const findings: { severity: string; issue: string }[] = [];
  for (const violation of violations) {
    if (violation.severity !== 'error') continue;
    const explicit = componentField(violation);
    const named = explicit && names.includes(explicit) ? explicit : null;
    const fromField = names.includes(violation.field) ? violation.field : null;
    const message = violation.message.trim();
    const mentioned = names.filter((name) => hasWord(message, name));
    const component = named ?? fromField ?? mentioned[0] ?? null;
    const issue = component && !hasWord(message, component)
      ? (message ? `${component}: ${message}` : component)
      : (message || component || violation.kind);
    findings.push({ severity: 'major', issue });
  }
  return findings;
}

function componentField(violation: SpecViolation): string | null {
  const component = (violation as SpecViolation & { component?: unknown }).component;
  return typeof component === 'string' ? component : null;
}

/** Component names that appear in the findings or the human notes, in spec order. */
function componentsNamed(
  findings: { issue: string }[],
  notes: string[],
  names: string[],
): string[] {
  const texts = [...findings.map((finding) => finding.issue), ...notes];
  return names.filter((name) => texts.some((text) => hasWord(text, name)));
}

function humanPrompt(spec: AssemblySpec, changes: string | null, ask: string[], keep: string[]): string {
  const { sheet, ...skeleton } = spec;
  const parameters = (spec.parameters ?? []).map((parameter) => parameter.name);
  const derived = (spec.derived ?? []).map((item) => item.name);
  const blockouts = (spec.components ?? []).map((component) => blockoutSection(spec, component.name));
  const parts = [
    changes,
    `Spec skeleton (JSON):\n${JSON.stringify(skeleton, null, 2)}`,
    `Sheet:\n${sheet ?? ''}`,
    `Parameter names: ${parameters.length ? parameters.join(', ') : '(none)'}`,
    `Derived names: ${derived.length ? derived.join(', ') : '(none)'}`,
    `Blockout starting point for each component:\n${blockouts.join('\n\n')}`,
    askLine(ask, keep),
  ].filter((part): part is string => Boolean(part));
  return parts.join('\n\n');
}

function blockoutSection(spec: AssemblySpec, name: string): string {
  const body = blockoutBody(spec, name);
  if (body === null) return `// ${name}: no blockout`;
  return `@body ${name}\n${body}\n@end`;
}

function askLine(ask: string[], keep: string[]): string {
  if (ask.length === 0) return 'The spec names no components. Reply with no @body sections.';
  if (keep.length === 0) return `Write a module body for every component: ${ask.join(', ')}.`;
  return `Write a module body only for: ${ask.join(', ')}. Do not send ${keep.join(', ')}; each keeps its body from the previous build.`;
}

/**
 * Components whose section was missing or dropped, so assembleScript drew the
 * blockout. An explicit `@body name blockout` is a choice, not a fallback.
 */
function countFallbacks(spec: AssemblySpec, names: string[], parsed: ReturnType<typeof parseBuild>): number {
  let count = 0;
  for (const name of names) {
    if (parsed.keepBlockout.includes(name)) continue;
    if (Object.prototype.hasOwnProperty.call(parsed.bodies, name)) continue;
    if (blockoutBody(spec, name) !== null) count += 1;
  }
  return count;
}

function messageText(message: AIMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
    return '';
  }).join('');
}

/** Interior of `module <name>() { ... }` in a previously assembled script, or null. */
function extractModuleBody(code: string, name: string): string | null {
  const header = new RegExp(`\\bmodule\\s+${escapeRegExp(name)}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = header.exec(code)) !== null) {
    const parenOpen = match.index + match[0].length - 1;
    const parenClose = matchDelim(code, parenOpen, '(', ')');
    if (parenClose === null) continue;
    let braceOpen = parenClose + 1;
    while (braceOpen < code.length && /[ \t]/.test(code[braceOpen])) braceOpen += 1;
    if (code[braceOpen] !== '{') continue;
    const braceClose = matchDelim(code, braceOpen, '{', '}');
    if (braceClose === null) return null;
    const inner = code.slice(braceOpen + 1, braceClose).replace(/^\n/, '').replace(/\s+$/, '');
    return inner.trim() === '' ? null : inner;
  }
  return null;
}

function matchDelim(src: string, openIndex: number, open: string, close: string): number | null {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const step = stepOver(src, i);
    if (step > i) {
      i = step;
      continue;
    }
    const ch = src[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return null;
}

/** Index just after a comment or string starting at `index`, or `index` when the character is code. */
function stepOver(src: string, index: number): number {
  const ch = src[index];
  if (ch === '/' && src[index + 1] === '/') {
    const nl = src.indexOf('\n', index);
    return nl < 0 ? src.length : nl + 1;
  }
  if (ch === '/' && src[index + 1] === '*') {
    const end = src.indexOf('*/', index + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (ch === '"') {
    let i = index + 1;
    while (i < src.length) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '"' || src[i] === '\n') return i + 1;
      i += 1;
    }
    return src.length;
  }
  return index;
}

function hasWord(text: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
