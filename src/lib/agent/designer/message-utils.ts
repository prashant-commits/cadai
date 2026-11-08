const VALIDATION_REPORT_PREFIX = '[Validation Report]';

/**
 * The user's current request, from the latest human message they wrote.
 * Accepts LangChain messages (`_getType`) and checkpoint JSON (`type` / `kwargs`).
 */
export function latestHumanText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (const msg of [...messages].reverse()) {
    if (messageRole(msg) !== 'human') continue;
    const text = messageText(msg);
    if (text && !text.startsWith(VALIDATION_REPORT_PREFIX)) return text;
  }
  return '';
}

/**
 * The user's original request, from the earliest human message they wrote.
 */
export function firstHumanText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (const msg of messages) {
    if (messageRole(msg) !== 'human') continue;
    const text = messageText(msg);
    if (text && !text.startsWith(VALIDATION_REPORT_PREFIX)) return text;
  }
  return '';
}

function messageRole(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const rec = msg as {
    _getType?: () => string;
    getType?: () => string;
    type?: string;
    id?: unknown;
  };
  if (typeof rec._getType === 'function') return rec._getType();
  if (typeof rec.getType === 'function') return rec.getType();
  if (typeof rec.type === 'string' && rec.type !== 'constructor') return rec.type;
  if (Array.isArray(rec.id) && rec.id.length > 0) {
    const last = rec.id[rec.id.length - 1];
    if (typeof last === 'string' && last.endsWith('Message')) return last.slice(0, -'Message'.length).toLowerCase();
  }
  return '';
}

function messageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const rec = msg as { content?: unknown; kwargs?: { content?: unknown } };
  const content = rec.content ?? rec.kwargs?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const part = content.find((item) => item && typeof item === 'object' && (item as { type?: string }).type === 'text') as
    | { text?: string }
    | undefined;
  return part?.text ?? '';
}
