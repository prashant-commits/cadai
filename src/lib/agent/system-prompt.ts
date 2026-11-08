import { SystemMessage } from '@langchain/core/messages';

/**
 * The node's system prompt as a SystemMessage whose single text block carries
 * `cache_control: {type: "ephemeral"}`. The prompts are large and static, so
 * every later call of the same node within the cache TTL reads them from the
 * prompt cache instead of paying full input price.
 */
export function cachedSystemMessage(text: string): SystemMessage {
  return new SystemMessage({ content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] });
}
