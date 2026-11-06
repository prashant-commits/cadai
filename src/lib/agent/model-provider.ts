import { ChatOpenAI } from '@langchain/openai';
import { DEFAULT_MODEL } from './models';

/**
 * Model routing for the CAD agent.
 *
 * Every node talks to the Anthropic API through its OpenAI-compatible endpoint,
 * so there is one client and one key. The key is read from the server
 * environment and is never sent to the browser.
 */

export const ANTHROPIC_OPENAI_BASE_URL = 'https://api.anthropic.com/v1/';

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
export type CadChatModel = ChatOpenAI;

/**
 * Builds a chat model for `modelName` (an app slug; defaults to CADAI_MODEL, then
 * DEFAULT_MODEL). `opts.temperature` is accepted for revision call sites but never
 * sent: Claude 5.5 models reject `temperature` on this endpoint.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getChatModel(modelName?: string, _opts?: { temperature?: number }): CadChatModel {
  const selectedModel = modelName || process.env.CADAI_MODEL || DEFAULT_MODEL;
  return new ChatOpenAI({
    apiKey: anthropicKey(),
    model: anthropicModelId(selectedModel),
    // The OpenAI client defaults to a 10-minute timeout with 2 retries, so one
    // stalled request can hold a run for half an hour; 4 minutes is generous.
    timeout: Number(process.env.CADAI_MODEL_TIMEOUT_MS ?? 240_000),
    maxRetries: 1,
    configuration: { baseURL: ANTHROPIC_OPENAI_BASE_URL },
  });
}
