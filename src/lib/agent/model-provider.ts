import { ChatOpenAI } from '@langchain/openai';
import { DEFAULT_MODEL, EXPLABS_BASE_URL } from './models';

/**
 * Model routing for the CAD agent.
 *
 * Every node talks to the Experiential Labs gateway over the OpenAI wire
 * format, so there is one client and one key.
 *
 * The gateway key is read from the server environment and is never sent to the
 * browser, so there is no user-supplied key anywhere in the app.
 */

function explabsKey(): string {
  const key = process.env.EXPLABS_API_KEY;
  if (!key) {
    throw new Error(
      'EXPLABS_API_KEY is missing. Set it in your environment or .env to run the CAD agent.'
    );
  }
  return key;
}

const ANTHROPIC_OPENAI_BASE_URL = 'https://api.anthropic.com/v1/';

function anthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('CADAI_PROVIDER=anthropic needs ANTHROPIC_API_KEY.');
  return key;
}

/**
 * The concrete class, not BaseChatModel: the drafter and repair nodes call
 * bindTools(), which BaseChatModel declares as optional and so cannot be
 * invoked without a cast.
 */
export type CadChatModel = ChatOpenAI;

/** Sampling temperature for every call except revisions. */
export const DEFAULT_TEMPERATURE = 0.2;

/**
 * Models whose route accepts exactly one temperature. Probed on the gateway on
 * 2026-10-08: claude-opus-5.5 rejects any value but 1.0 ("Supported values are
 * between 1.0 and 1.0"). The value here wins over the 0.2 default AND the 0.6
 * revision temperature.
 */
export const FIXED_TEMPERATURE: Record<string, number> = { 'claude-opus-5.5': 1 };

/** Builds a chat model for `modelName`. `temperature` defaults to 0.2; revisions ask for more to avoid anchoring on the previous spec. */
export function getChatModel(modelName?: string, opts?: { temperature?: number }): CadChatModel {
  const selectedModel = modelName || process.env.CADAI_MODEL || DEFAULT_MODEL;

  // CADAI_PROVIDER=anthropic sends Claude slugs straight to Anthropic's
  // OpenAI-compatible endpoint (evals on Anthropic credit). The app keeps its
  // gateway slug ("claude-haiku-5.5") everywhere else; only the wire id changes.
  const anthropic = process.env.CADAI_PROVIDER === 'anthropic' && selectedModel.startsWith('claude-');
  return new ChatOpenAI({
    apiKey: anthropic ? anthropicKey() : explabsKey(),
    model: anthropic ? selectedModel.replace(/\./g, '-') : selectedModel,
    // Anthropic rejects `temperature` for Claude 5.5 models ("deprecated for this model").
    temperature: anthropic ? undefined : FIXED_TEMPERATURE[selectedModel] ?? opts?.temperature ?? DEFAULT_TEMPERATURE,
    // The OpenAI client defaults to a 10-minute timeout with 2 retries, so one
    // stalled gateway request can hold a run for half an hour. A structured
    // spec on deepseek-v4-flash averages 78 s; 4 minutes is generous.
    timeout: Number(process.env.CADAI_MODEL_TIMEOUT_MS ?? 240_000),
    maxRetries: 1,
    configuration: { baseURL: anthropic ? ANTHROPIC_OPENAI_BASE_URL : EXPLABS_BASE_URL },
  });
}
