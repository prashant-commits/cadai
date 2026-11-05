import type { BaseMessage } from '@langchain/core/messages';
import type { AssemblySpec } from './assembly-spec';
import type { AgentStateType } from './graph';

/**
 * A message sent after a design was finished is an edit of that design, not a
 * new request.
 *
 * Every chat turn is a fresh run (one checkpoint per run), so the graph does not
 * remember the last model. The client does: it re-sends the thread's design
 * contract, whose `spec` is the last approved Assembly Spec. When that spec is
 * present, the run has no variants yet, and the conversation already holds an
 * assistant reply, the Architect revises that spec with the new message as a
 * mandatory change instead of planning a new design from the chat text.
 */
export function followUpEdit(state: AgentStateType): { spec: AssemblySpec; request: string } | null {
  const spec = state.designContract?.spec;
  if (!spec || (state.specVariants?.length ?? 0) > 0) return null;
  const messages = state.messages ?? [];
  const last = messages.at(-1);
  if (!last || last._getType() !== 'human') return null;
  if (!messages.slice(0, -1).some((m) => m._getType() === 'ai')) return null;
  const request = textOf(last).trim();
  return request ? { spec, request } : null;
}

function textOf(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : ''))
    .filter(Boolean)
    .join('\n');
}
