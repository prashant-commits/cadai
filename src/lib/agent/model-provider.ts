import { ChatOpenAI } from '@langchain/openai';
import { DEFAULT_TEXT_MODEL, DEFAULT_VISION_MODEL, EXPLABS_BASE_URL } from './models';

/**
 * Model routing for the CAD agent.
 *
 * Every node talks to the Experiential Labs gateway over the OpenAI wire
 * format, so there is one client and one key. Two defaults, not one, because
 * the pipeline needs two different things from a model:
 *
 *   - The Architect, Drafter and Repair nodes need long structured output over
 *     AssemblySpecSchema. deepseek-v4-flash measured 5/5 valid specs against
 *     1/5 on the Gemini route this replaced, and it tool-calls, so it is the
 *     text default.
 *
 *   - The Visual Critic is the only node that sends images, and no DeepSeek
 *     text route accepts image input. It therefore resolves separately, to a
 *     multimodal slug.
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
  const selectedModel = modelName || process.env.CADAI_MODEL || DEFAULT_TEXT_MODEL;

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

/**
 * Builds the model the Visual Critic uses.
 *
 * When the selected model can already see, the critic reuses it so a run stays
 * on one model. Otherwise it falls back to the vision default rather than
 * sending images to a text-only route, which the gateway rejects outright with
 * "The selected model route cannot accept image input".
 */
export function getVisionModel(modelName?: string): CadChatModel {
  const selectedModel = modelName || process.env.CADAI_MODEL || DEFAULT_TEXT_MODEL;
  const visionModel = process.env.CADAI_VISION_MODEL || DEFAULT_VISION_MODEL;

  return getChatModel(selectedModel === visionModel ? selectedModel : visionModel);
}
