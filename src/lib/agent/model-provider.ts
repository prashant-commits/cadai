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

/**
 * The concrete class, not BaseChatModel: the drafter and repair nodes call
 * bindTools(), which BaseChatModel declares as optional and so cannot be
 * invoked without a cast.
 */
export type CadChatModel = ChatOpenAI;

/** Builds a chat model for `modelName`. */
export function getChatModel(modelName?: string): CadChatModel {
  const selectedModel = modelName || process.env.CADAI_MODEL || DEFAULT_MODEL;

  return new ChatOpenAI({
    apiKey: explabsKey(),
    model: selectedModel,
    temperature: 0.2,
    // The OpenAI client defaults to a 10-minute timeout with 2 retries, so one
    // stalled gateway request can hold a run for half an hour. A structured
    // spec on deepseek-v4-flash averages 78 s; 4 minutes is generous.
    timeout: Number(process.env.CADAI_MODEL_TIMEOUT_MS ?? 240_000),
    maxRetries: 1,
    configuration: { baseURL: EXPLABS_BASE_URL },
  });
}
