import { ChatAnthropic } from '@langchain/anthropic';
import { DEFAULT_MODEL, isOfferedModel } from './models';

/**
 * Model routing for the CAD agent.
 *
 * Every node talks to the Anthropic Messages API natively (ChatAnthropic), so
 * thinking and effort can be set per request. On the OpenAI-compatible endpoint
 * Claude 5.x thought adaptively and nothing turned it down: a spec call took
 * 98-135 s and 21-32k output tokens there, against 12.8 s and 2.75k tokens
 * natively with thinking disabled. The key is read from the server environment
 * and is never sent to the browser.
 */

function anthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is missing. Set it in your environment or .env to run the CAD agent.');
  }
  return key;
}

/** App slug ("claude-haiku-5.5") to Anthropic model id ("claude-haiku-5-5"). */
export function anthropicModelId(slug: string): string {
  return slug.replace(/\./g, '-');
}

/**
 * The concrete class, not BaseChatModel: the drafter and repair nodes call
 * bindTools(), which BaseChatModel declares as optional and so cannot be
 * invoked without a cast.
 */
export type CadChatModel = ChatAnthropic;

export type ThinkingMode = 'off' | 'adaptive';
export type EffortLevel = 'low' | 'medium' | 'high';

const THINKING_MODES: readonly ThinkingMode[] = ['off', 'adaptive'];
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high'];

/**
 * Models that reject `thinking: {type: "disabled"}` with a 400 (live probe,
 * 2026-11-07): Sonnet 5.5 and Opus 5.5. With CADAI_THINKING=off they run
 * adaptive thinking at effort `low`, the cheapest setting they accept. Haiku 5.5
 * accepts `disabled` (at effort high or below, which is all CADAI_EFFORT offers).
 */
const THINKING_ALWAYS_ON = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

function envChoice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  console.warn(`${name} "${raw}" is not one of ${allowed.join('|')}; using "${fallback}".`);
  return fallback;
}

/** CADAI_THINKING: `off` (default) or `adaptive`. */
export function thinkingMode(): ThinkingMode {
  return envChoice('CADAI_THINKING', THINKING_MODES, 'off');
}

/** CADAI_EFFORT: `low`, `medium` or `high` (default). */
export function effortLevel(): EffortLevel {
  return envChoice('CADAI_EFFORT', EFFORT_LEVELS, 'high');
}

/** What is actually sent for `modelId`, after the per-model fallback. */
export function thinkingFor(
  modelId: string,
  mode: ThinkingMode = thinkingMode(),
  effort: EffortLevel = effortLevel()
): { thinking: { type: 'disabled' } | { type: 'adaptive' }; effort: EffortLevel } {
  if (mode === 'adaptive') return { thinking: { type: 'adaptive' }, effort };
  if (THINKING_ALWAYS_ON.has(modelId)) return { thinking: { type: 'adaptive' }, effort: 'low' };
  return { thinking: { type: 'disabled' }, effort };
}

/**
 * Default max_tokens. With thinking on, max_tokens has to cover the thinking
 * too: 21-32k output tokens were measured on one spec call, and 32k truncated
 * such calls, so thinking runs get 64k.
 */
const MAX_TOKENS_THINKING_OFF = 32_000;
const MAX_TOKENS_THINKING_ON = 64_000;

/**
 * Builds a chat model for `modelName` (an app slug; defaults to CADAI_MODEL if offered, then
 * DEFAULT_MODEL). Temperature is never sent: Claude 5.5 models reject non-default values.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getChatModel(modelName?: string, _opts?: { temperature?: number }): CadChatModel {
  let selectedModel = modelName;
  if (!selectedModel) {
    const envModel = process.env.CADAI_MODEL;
    if (envModel) {
      if (isOfferedModel(envModel)) {
        selectedModel = envModel;
      } else {
        console.warn(`CADAI_MODEL "${envModel}" is not an offered model; ignoring and falling back to "${DEFAULT_MODEL}".`);
        selectedModel = DEFAULT_MODEL;
      }
    } else {
      selectedModel = DEFAULT_MODEL;
    }
  }

  const model = anthropicModelId(selectedModel);
  const { thinking, effort } = thinkingFor(model);
  const defaultMaxTokens = thinking.type === 'disabled' ? MAX_TOKENS_THINKING_OFF : MAX_TOKENS_THINKING_ON;

  const chat = new ChatAnthropic({
    apiKey: anthropicKey(),
    model,
    maxTokens: Number(process.env.CADAI_MAX_TOKENS ?? defaultMaxTokens),
    thinking,
    outputConfig: { effort },
    // The SDK default is a 10-minute timeout with 2 retries, so one stalled
    // request could hold a run for half an hour; 4 minutes is generous. An
    // explicit timeout also lifts the SDK's refusal of large non-streaming
    // max_tokens.
    clientOptions: { timeout: Number(process.env.CADAI_MODEL_TIMEOUT_MS ?? 240_000) },
    maxRetries: 1,
  });
  noRetryOnAbort(chat);
  return chat;
}

const ABORT_NAMES = new Set(['AbortError', 'TimeoutError', 'APIUserAbortError', 'APIConnectionTimeoutError']);

/**
 * An abort (the run's deadline or a cancelled request) or a client timeout. The
 * SDK reports them as APIUserAbortError "Request was aborted." and
 * APIConnectionTimeoutError "Request timed out.".
 */
export function isAbortOrTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown; constructor?: { name?: unknown } };
  if (typeof e.name === 'string' && ABORT_NAMES.has(e.name)) return true;
  if (typeof e.constructor?.name === 'string' && ABORT_NAMES.has(e.constructor.name)) return true;
  return typeof e.message === 'string' && /^(Request was aborted|Request timed out|Aborted|The operation was aborted)/.test(e.message);
}

/**
 * LangChain's caller retries a failed call once (maxRetries 1), and its default
 * handler does not recognise the Anthropic SDK's abort error, so a call cut by
 * the run deadline was sent again after about a second. The caller's own handler
 * is wrapped: aborts and timeouts end the call, everything else is decided by
 * the library default (429 / 5xx / 529 retried, other 4xx not).
 */
function noRetryOnAbort(chat: ChatAnthropic): void {
  const caller = chat.caller as unknown as { onFailedAttempt?: (error: unknown) => unknown } | undefined;
  if (!caller) return; // a test double without LangChain's caller
  const libraryDefault = caller.onFailedAttempt;
  caller.onFailedAttempt = (error: unknown) => {
    if (isAbortOrTimeout(error)) throw error;
    return libraryDefault?.(error);
  };
}
