/** A fake Anthropic client for ChatAnthropic tests: records request bodies, never touches the network. */
import type { CadChatModel } from '../model-provider';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = Record<string, any>;

/** An Anthropic Messages API reply carrying `content`. */
export function reply(content: unknown[], stop_reason?: string) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content,
    stop_reason: stop_reason ?? (content.some((b) => (b as { type: string }).type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/** The stream events of a reply whose single text block arrives in `pieces`. */
export function textStream(pieces: string[]) {
  const events: unknown[] = [
    { type: 'message_start', message: { ...reply([]), stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...pieces.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

/**
 * Points a ChatAnthropic at a fake Anthropic client: every request body is
 * recorded, and `respond` answers it. No network.
 */
export function withFakeClient(model: CadChatModel, respond: (body: Body, call: number) => unknown): Body[] {
  const bodies: Body[] = [];
  const create = async (body: Body) => {
    bodies.push(body);
    return respond(body, bodies.length - 1);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (model as any).createClient = () => ({ messages: { create }, beta: { messages: { create } } });
  return bodies;
}


/** The stream events of a reply with one tool_use block whose input arrives as `json`, ending with `stopReason`. */
export function toolUseStream(name: string, json: string, stopReason: string) {
  const events: unknown[] = [
    { type: 'message_start', message: { ...reply([]), stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_s', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ];
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}
