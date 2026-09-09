import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';

/**
 * Model routing for the CAD agent.
 *
 * The pipeline needs two different things from a model and no single model we
 * have access to does both well:
 *
 *   - The Architect, Drafter and Repair nodes need long structured output over
 *     AssemblySpecSchema. Gemini's constrained decoding degenerates on that
 *     schema - it emits a valid number and then locks into repeating digits
 *     ("width": 100101010101...) until it hits the token cap, producing
 *     unparseable JSON. Measured 1/5 valid on gemini-3.6-flash against 5/5 on
 *     every DeepSeek model tried, so these nodes default to DeepSeek.
 *
 *   - The Visual Critic is the only node that sends images, and no DeepSeek
 *     text route accepts image input. It therefore resolves separately, to a
 *     multimodal slug.
 *
 * Both lanes speak the OpenAI wire format through the Experiential Labs
 * gateway, so one ChatOpenAI client with a swapped baseURL covers them, while
 * any `gemini-*` slug still routes to Google directly and behaves exactly as
 * it did before.
 */

export const EXPLABS_BASE_URL = 'https://api.experientiallabs.ai/v1';

/** Text/structured-output default. 5/5 valid Assembly Specs, tool-calling, $0. */
export const DEFAULT_TEXT_MODEL = 'deepseek-v4-flash';

/**
 * Vision default for the Visual Critic.
 *
 * gpt-5.6-luna is the only multimodal slug tested that also serves
 * `response_format: json_schema`, which the critic needs for its structured
 * critique. deepseek-v4-flash-vision-exp reads images but the gateway refuses
 * response_format on that profile, and the critic cannot use it.
 *
 * Note that luna enforces OpenAI STRICT json_schema: every property must appear
 * in `required`. That is why VisualCritiqueSchema has no optional fields.
 */
export const DEFAULT_VISION_MODEL = 'gpt-5.6-luna';

function isGeminiSlug(model: string): boolean {
  return model.startsWith('gemini-');
}

function googleKey(apiKey?: string): string {
  const key = apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      'Google Gemini API Key is missing. Please set GOOGLE_API_KEY in your environment or .env.local.'
    );
  }
  return key;
}

function explabsKey(): string {
  const key = process.env.EXPLABS_API_KEY;
  if (!key) {
    throw new Error(
      'EXPLABS_API_KEY is missing. Set it in your environment or .env to use non-Gemini models, or pick a gemini-* model.'
    );
  }
  return key;
}

/**
 * Both concrete classes, not BaseChatModel: the drafter and repair nodes call
 * bindTools(), which BaseChatModel declares as optional and so cannot be
 * invoked without a cast.
 */
export type CadChatModel = ChatGoogleGenerativeAI | ChatOpenAI;

/**
 * Builds a chat model for `modelName`.
 *
 * `apiKey` is the user's own Gemini key from the header dialog; it only applies
 * to the Google lane. Gateway models authenticate with the server-side
 * EXPLABS_API_KEY, which is never sent to the browser.
 */
export function getChatModel(apiKey?: string, modelName?: string): CadChatModel {
  const selectedModel = modelName || process.env.CADAI_MODEL || DEFAULT_TEXT_MODEL;

  if (isGeminiSlug(selectedModel)) {
    return new ChatGoogleGenerativeAI({
      apiKey: googleKey(apiKey),
      model: selectedModel,
      temperature: 0.2,
      maxOutputTokens: 8192,
    });
  }

  return new ChatOpenAI({
    apiKey: explabsKey(),
    model: selectedModel,
    temperature: 0.2,
    configuration: { baseURL: EXPLABS_BASE_URL },
  });
}

/**
 * Builds the model the Visual Critic uses.
 *
 * When the selected model can already see, the critic reuses it so a run stays
 * on one provider. Otherwise it falls back to the vision default rather than
 * sending images to a text-only route, which the gateway rejects outright with
 * "The selected model route cannot accept image input".
 */
export function getVisionModel(apiKey?: string, modelName?: string): CadChatModel {
  const selectedModel = modelName || process.env.CADAI_MODEL || DEFAULT_TEXT_MODEL;
  if (isGeminiSlug(selectedModel)) return getChatModel(apiKey, selectedModel);

  return getChatModel(apiKey, process.env.CADAI_VISION_MODEL || DEFAULT_VISION_MODEL);
}

/** True when this slug can accept image_url content blocks. */
export function supportsVision(modelName: string): boolean {
  return isGeminiSlug(modelName) || modelName === DEFAULT_VISION_MODEL;
}
