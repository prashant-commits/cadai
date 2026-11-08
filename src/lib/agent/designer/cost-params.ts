import type { AIMessage } from '@langchain/core/messages';

export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-5.5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5.5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5.5': { input: 4, output: 20 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5.1': { input: 10, output: 50 },
};

export function extractReplyUsage(reply: AIMessage): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
} {
  const meta = reply.usage_metadata;
  const respUsage = (reply.response_metadata as { usage?: Record<string, unknown> } | undefined)?.usage;
  const input = typeof meta?.input_tokens === 'number'
    ? meta.input_tokens
    : typeof respUsage?.input_tokens === 'number'
      ? (respUsage.input_tokens as number)
      : 0;
  const output = typeof meta?.output_tokens === 'number'
    ? meta.output_tokens
    : typeof respUsage?.output_tokens === 'number'
      ? (respUsage.output_tokens as number)
      : 0;
  const cacheCreation = typeof (meta as unknown as { input_token_details?: { cache_creation?: number } })?.input_token_details?.cache_creation === 'number'
    ? (meta as unknown as { input_token_details?: { cache_creation?: number } }).input_token_details!.cache_creation!
    : typeof respUsage?.cache_creation_input_tokens === 'number'
      ? (respUsage.cache_creation_input_tokens as number)
      : 0;
  const cacheRead = typeof (meta as unknown as { input_token_details?: { cache_read?: number } })?.input_token_details?.cache_read === 'number'
    ? (meta as unknown as { input_token_details?: { cache_read?: number } }).input_token_details!.cache_read!
    : typeof respUsage?.cache_read_input_tokens === 'number'
      ? (respUsage.cache_read_input_tokens as number)
      : 0;

  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

export function estimateCostUsd(
  modelSlug: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  }
): number {
  const norm = modelSlug.toLowerCase().replace(/\./g, '-');
  const price = MODEL_PRICES[norm] ?? MODEL_PRICES[modelSlug] ?? MODEL_PRICES['claude-sonnet-5-5'];
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1;
  const output = usage.output_tokens ?? 0;
  return (input * price.input + output * price.output) / 1_000_000;
}

export function applyParameterOverrides(
  script: string,
  overrides?: Record<string, number | string | boolean>
): string {
  if (!overrides || Object.keys(overrides).length === 0) return script;
  const lines = script.split('\n');
  const validOverrides = new Map<string, number | boolean>();
  for (const [k, v] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      validOverrides.set(k, v);
    } else if (typeof v === 'boolean') {
      validOverrides.set(k, v);
    }
  }
  if (validOverrides.size === 0) return script;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^#\n]+?)(\s*(?:#.*)?)$/.exec(line);
    if (match) {
      const name = match[1];
      if (validOverrides.has(name)) {
        lines[i] = `${name} = ${validOverrides.get(name)}${match[3]}`;
      }
    }
  }

  return lines.join('\n');
}
