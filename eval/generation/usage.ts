import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import { anthropicModelId } from '@/lib/agent/model-provider';
import { costUsd } from '../architect/score';

/**
 * Sums model usage over a run from LangChain's `usage_metadata`, which every
 * chat-model call reports through handleLLMEnd. Prices come from the Architect
 * eval's table (`eval/architect/score.ts`; models.ts has no prices).
 */
export class UsageHandler extends BaseCallbackHandler {
  name = 'usage-meter';
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;

  async handleLLMEnd(output: LLMResult): Promise<void> {
    for (const generations of output.generations) {
      for (const g of generations) {
        const usage = (g as { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } }).message?.usage_metadata;
        if (!usage) continue;
        this.calls += 1;
        this.inputTokens += usage.input_tokens ?? 0;
        this.outputTokens += usage.output_tokens ?? 0;
      }
    }
  }

  /** USD for the summed tokens at `model`'s list price; null when the model has no price. */
  cost(model: string): number | null {
    return costUsd(anthropicModelId(model), { input_tokens: this.inputTokens, output_tokens: this.outputTokens }, false);
  }
}
