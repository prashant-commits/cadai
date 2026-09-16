/**
 * Turns the architect's streaming structured output into markdown deltas.
 *
 * withStructuredOutput(...).stream() yields progressively-complete PARSED
 * OBJECTS, not raw JSON fragments - LangChain's cumulative parser already does
 * the partial-JSON work - so this diffs consecutive snapshots rather than
 * re-parsing text.
 *
 * Settling rule: JSON keys arrive in order, so key N is complete once key N+1
 * exists. Emitting earlier would let a line rewrite itself while the user reads
 * it, which is worse than arriving late.
 */

/**
 * Beyond this, a dimension is not a design - it is a degenerate decode. The
 * value is still shown, labelled: silently dropping it would hide from the user
 * that the model produced something wrong.
 */
const PLAUSIBLE_MAX_MM = 10_000;

/** Top-level spec keys, in the order the schema emits them. */
const KEY_ORDER = [
  'assemblyName',
  'boundingBox',
  'components',
  'jointContracts',
  'stressPoints',
  'assumptions',
  'openQuestions',
] as const;

function num(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '?';
  if (Math.abs(v) > PLAUSIBLE_MAX_MM) return `${v} **(implausible)**`;
  return String(v);
}

function renderKey(key: string, value: unknown): string {
  switch (key) {
    case 'assemblyName':
      return typeof value === 'string' && value ? `**${value}**\n` : '';
    case 'boundingBox': {
      const b = value as { width?: unknown; length?: unknown; height?: unknown } | undefined;
      if (!b) return '';
      return `Bounding box: ${num(b.width)} x ${num(b.length)} x ${num(b.height)} mm\n`;
    }
    default:
      return '';
  }
}

function renderComponent(c: { name?: string; description?: string }): string {
  return `- ${c.name ?? 'unnamed'}: ${c.description ?? ''}\n`;
}

function renderListItem(key: string, item: Record<string, unknown>): string {
  switch (key) {
    case 'components':
      return renderComponent(item as { name?: string; description?: string });
    case 'stressPoints':
      return `- ${item.risk ?? 'unknown'} risk at ${item.location ?? '?'} - ${item.mitigation ?? ''}\n`;
    case 'assumptions':
      return `- ${item.field ?? '?'}: ${item.value ?? '?'} (${item.rationale ?? ''})\n`;
    case 'openQuestions':
      return `- ${item.question ?? '?'}\n`;
    case 'jointContracts':
      return `- ${item.type ?? 'joint'} between ${item.partA ?? '?'} and ${item.partB ?? '?'}, ${num(item.clearance)}mm clearance\n`;
    default:
      return '';
  }
}

/** Headings printed the first time a list key produces an item. */
const LIST_HEADINGS: Record<string, string> = {
  components: '\nComponents:\n',
  jointContracts: '\nJoints:\n',
  stressPoints: '\nStress points:\n',
  assumptions: '\nAssumptions:\n',
  openQuestions: '\nOpen questions:\n',
};

export function createSpecRenderer(): { push(partial: unknown): string } {
  const emittedKeys = new Set<string>();
  const emittedCounts = new Map<string, number>();
  const headed = new Set<string>();

  return {
    push(partial: unknown): string {
      if (!partial || typeof partial !== 'object') return '';
      const obj = partial as Record<string, unknown>;
      // A caller can force every pending key out by setting __done - used when
      // the stream ends and the last key has no successor to settle it.
      const done = obj.__done === true;
      const present = KEY_ORDER.filter((k) => obj[k] !== undefined);
      let out = '';

      for (let i = 0; i < present.length; i++) {
        const key = present[i];
        const settled = done || i < present.length - 1;
        const value = obj[key];

        if (Array.isArray(value)) {
          // An element is complete once the array grew past it; the last
          // element waits for the next key, or for __done.
          const limit = settled ? value.length : value.length - 1;
          const already = emittedCounts.get(key) ?? 0;
          for (let j = already; j < limit; j++) {
            if (!headed.has(key)) {
              out += LIST_HEADINGS[key] ?? '';
              headed.add(key);
            }
            out += renderListItem(key, value[j] as Record<string, unknown>);
          }
          if (limit > already) emittedCounts.set(key, limit);
          continue;
        }

        if (!settled || emittedKeys.has(key)) continue;
        emittedKeys.add(key);
        out += renderKey(key, value);
      }

      return out;
    },
  };
}
