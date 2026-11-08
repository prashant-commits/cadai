import { z } from 'zod';
import { assembleStructuredOutputPipeline } from '@langchain/core/language_models/structured_output';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { ChatAnthropic } from '@langchain/anthropic';
import { toAnthropicCompatibleSchema } from './strict-schema';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Stop reasons that leave a reply cut off before it was finished. */
const CUT_OFF_STOPS = new Set(['max_tokens', 'model_context_window_exceeded', 'pause_turn']);
export type UnusableStop = 'max_tokens' | 'model_context_window_exceeded' | 'pause_turn' | 'refusal';

/**
 * The stop reason of a model reply when it makes the reply unusable: cut off
 * (max_tokens, model_context_window_exceeded, or pause_turn, which only server
 * tools cause and none are bound), or a refusal. Non-streamed replies carry it
 * in response_metadata, streamed ones in additional_kwargs (from the message_delta event).
 */
export function unusableStop(msg: unknown): UnusableStop | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as { response_metadata?: Record<string, unknown>; additional_kwargs?: Record<string, unknown> };
  const reason = m.response_metadata?.stop_reason ?? m.additional_kwargs?.stop_reason;
  if (reason === 'refusal') return 'refusal';
  return typeof reason === 'string' && CUT_OFF_STOPS.has(reason) ? (reason as UnusableStop) : null;
}

/** True for the stop reasons that cut a reply short (as opposed to a refusal). */
export function isCutOff(stop: UnusableStop | null | undefined): boolean {
  return !!stop && CUT_OFF_STOPS.has(stop);
}

/** A structured reply that stopped for an unusable reason; callers retry, and can tell a truncation apart. */
export class UnusableReplyError extends Error {
  constructor(readonly stop: UnusableStop) {
    super(`structured reply unusable: stop_reason ${stop}`);
    this.name = 'UnusableReplyError';
  }
}

/** JsonOutputParser that throws on a reply cut off at max_tokens or refused, so the caller retries. */
export class StopCheckedJsonOutputParser extends JsonOutputParser {
  async parseResult(...args: Parameters<JsonOutputParser['parseResult']>): ReturnType<JsonOutputParser['parseResult']> {
    const message = (args[0][0] as { message?: unknown } | undefined)?.message;
    const stop = unusableStop(message);
    if (stop) throw new UnusableReplyError(stop);
    return super.parseResult(...args);
  }
}

/**
 * `model.withStructuredOutput(schema, opts)`, adapted for Claude models on the Anthropic endpoint.
 *
 * For Claude models, schemas are sent as native structured output (`method: 'jsonSchema'`, i.e.
 * `output_config.format`), which constrains the reply to the schema without a tool call.
 * For non-Claude slugs, schema and opts are passed untouched.
 * The reply is still validated by the caller against the zod schema.
 */
export function structuredFor<M extends { withStructuredOutput: (...args: never[]) => unknown }>(
  model: M,
  slug: string,
  schema: z.ZodType | Record<string, unknown>,
  opts: { name?: string; strict?: boolean; includeRaw?: boolean } = {}
): ReturnType<M['withStructuredOutput']> {
  const call = model.withStructuredOutput as unknown as (s: unknown, o?: unknown) => ReturnType<M['withStructuredOutput']>;
  if (!slug.startsWith('claude-')) return call.call(model, schema, opts);

  let json: Record<string, unknown>;
  if (schema instanceof z.ZodType) {
    json = z.toJSONSchema(schema) as Record<string, unknown>;
    delete json.$schema;
  } else {
    json = schema;
  }

  const safe = toAnthropicCompatibleSchema(json);
  delete safe.$schema;
  if (model instanceof ChatAnthropic) {
    // Sent as output_config.format directly. withStructuredOutput({method: 'jsonSchema'})
    // would run the schema through the SDK's transformJSONSchema, which moves `enum`
    // into the description as text, so the decoder no longer enforces it.
    // `safe` is already Anthropic-compatible.
    const llm = model.withConfig({
      outputVersion: 'v0',
      outputConfig: { format: { type: 'json_schema', schema: safe } },
      ls_structured_output_format: { kwargs: { method: 'json_schema' }, schema: safe },
    } as never);
    return assembleStructuredOutputPipeline(
      llm as never,
      new StopCheckedJsonOutputParser() as never,
      opts.includeRaw
    ) as unknown as ReturnType<M['withStructuredOutput']>;
  }
  const jsonOpts: { name: string; method: 'jsonSchema'; includeRaw?: boolean } = {
    name: opts.name ?? 'Reply',
    method: 'jsonSchema',
  };
  if (opts.includeRaw !== undefined) jsonOpts.includeRaw = opts.includeRaw;
  return call.call(model, safe, jsonOpts);
}
