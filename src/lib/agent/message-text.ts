/**
 * The visible text of a message's `content`. The native Anthropic client
 * returns a plain string for a text-only reply, but an array of content blocks
 * when the reply also carries tool_use or thinking blocks (and for every
 * streamed chunk of a tool-bound or thinking call). Only `text` blocks are
 * visible text; thinking, tool_use and input_json_delta blocks are skipped.
 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('');
}
