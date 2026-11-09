/**
 * Versioned build123d preludes for CAD AI scripts.
 *
 * Prepend a generated prelude to design bodies before compilation and execution.
 * Entries in PRELUDES are strictly add-only: once written, a prelude version
 * is never modified or removed, ensuring persisted scripts remain reproducible.
 */

export const PRELUDE_SENTINEL = '# ---- cadai prelude end ----';

export const FUSE_HELPER = `def _fuse(items):
    groups = [([name], shape) for name, shape in items]
    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                a, b = groups[i][1], groups[j][1]
                fused = a + b
                if len(fused.solids()) < len(a.solids()) + len(b.solids()):
                    groups[i] = (groups[i][0] + groups[j][0], fused)
                    del groups[j]
                    merged = True
                    break
            if merged:
                break
    out = []
    for names, shape in groups:
        shape.label = "+".join(names)
        out.append(shape)
    return out`;

export const GENERATED_PRELUDE_LINES = [
  '# Generated from the approved Assembly Spec. Edit a parameter to preview; change the spec to keep it.',
  'from build123d import *',
  'import math as _math',
  'from math import sin, cos, tan, radians, sqrt, pi',
  '',
  '# Spec expressions take degrees; model bodies use the math functions above (radians).',
  'def _sind(deg): return _math.sin(_math.radians(deg))',
  'def _cosd(deg): return _math.cos(_math.radians(deg))',
  'def _tand(deg): return _math.tan(_math.radians(deg))',
  '',
  FUSE_HELPER,
];

export const GENERATED_PRELUDE = GENERATED_PRELUDE_LINES.join('\n');

/**
 * Registry of generated preludes by version.
 * Add-only: entries are only ever added, never edited or removed.
 */
export const PRELUDES: Record<string, string> = {
  '1': GENERATED_PRELUDE,
};

export const PRELUDE_VERSION = '1';

export function hasPreludeSentinel(script: string): boolean {
  return script.includes(PRELUDE_SENTINEL);
}

/**
 * Maps a 1-based line number from a compiled script (which may include a prelude)
 * to a 1-based line number in the design body.
 *
 * When the script has PRELUDE_SENTINEL, the body starts on the first non-blank line
 * after the sentinel line. Lines inside the prelude return null.
 * Without a sentinel, returns scriptLine.
 */
export function scriptLineToBodyLine(scriptLine: number, script: string): number | null {
  if (!hasPreludeSentinel(script)) {
    return scriptLine;
  }

  const lines = script.split('\n');
  const sentinelIdx = lines.findIndex((l) => l.includes(PRELUDE_SENTINEL));
  if (sentinelIdx === -1) {
    return scriptLine;
  }

  let bodyStartIdx = sentinelIdx + 1;
  while (bodyStartIdx < lines.length && lines[bodyStartIdx].trim() === '') {
    bodyStartIdx++;
  }

  if (bodyStartIdx >= lines.length) {
    return null;
  }

  const bodyStartLine = bodyStartIdx + 1;
  const mapped = scriptLine - (bodyStartLine - 1);
  if (mapped <= 0) {
    return null;
  }
  return mapped;
}

export function withGeneratedPrelude(body: string, version: string = PRELUDE_VERSION): string {
  const prelude = PRELUDES[version];
  if (prelude === undefined) {
    throw new Error(`unknown prelude version: ${version}`);
  }
  return `${prelude}\n\n${PRELUDE_SENTINEL}\n\n${body}`;
}

const ALLOWED_MATH_FUNCS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'radians', 'degrees', 'sqrt', 'pi', 'exp', 'log', 'floor', 'ceil',
]);

const ALLOWED_PRELUDE_EXACT_LINES = new Set([
  'from build123d import *',
  'import math as _math',
  'import math',
  'from math import sin, cos, tan, radians, sqrt, pi',
  'def _sind(deg): return _math.sin(_math.radians(deg))',
  'def _cosd(deg): return _math.cos(_math.radians(deg))',
  'def _tand(deg): return _math.tan(_math.radians(deg))',
]);

function isRegisteredPreludeComment(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('#')) return false;
  for (const registered of Object.values(PRELUDES)) {
    for (const pline of registered.split('\n')) {
      const ptrimmed = pline.trim();
      if (ptrimmed.startsWith('#') && ptrimmed === trimmed) {
        return true;
      }
    }
  }
  return false;
}

function matchesCadaiNotesBlock(lines: string[], i: number): boolean {
  if (i + 4 > lines.length) return false;
  return (
    lines[i].trimEnd() === 'try:' &&
    (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t')) &&
    lines[i + 1].trim() === '_cadai_notes' &&
    lines[i + 2].trimEnd() === 'except NameError:' &&
    (lines[i + 3].startsWith(' ') || lines[i + 3].startsWith('\t')) &&
    lines[i + 3].trim() === '_cadai_notes = []'
  );
}

function trimLeadingBlankLines(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') {
    i++;
  }
  return lines.slice(i).join('\n');
}

function matchAndStripCandidate(lines: string[], targetText: string, allowSkipComments: boolean): string[] | null {
  const targetLines = targetText
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (targetLines.length === 0) return null;

  let sIdx = 0;
  let tIdx = 0;
  while (sIdx < lines.length && tIdx < targetLines.length) {
    const lineTrimmed = lines[sIdx].trim();
    if (lineTrimmed === '') {
      sIdx++;
      continue;
    }
    if (allowSkipComments && lineTrimmed.startsWith('#') && !targetLines[tIdx].startsWith('#')) {
      sIdx++;
      continue;
    }
    if (lines[sIdx].trimEnd() === targetLines[tIdx]) {
      sIdx++;
      tIdx++;
    } else {
      return null;
    }
  }

  if (tIdx === targetLines.length) {
    return lines.slice(sIdx);
  }
  return null;
}

function stripAllowedPreludeLines(lines: string[]): string[] {
  // The user's own header comments stay in place; prelude lines below them are still stripped.
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length > 0 && kept[kept.length - 1].trim() !== '') kept.push(line);
      i++;
      continue;
    }
    if (matchesCadaiNotesBlock(lines, i)) {
      i += 4;
      continue;
    }
    if (trimmed.startsWith('#')) {
      if (isRegisteredPreludeComment(line)) {
        i++;
        continue;
      }
      kept.push(line);
      i++;
      continue;
    }
    if (ALLOWED_PRELUDE_EXACT_LINES.has(trimmed)) {
      i++;
      continue;
    }
    if (trimmed.startsWith('from build123d import ')) {
      const items = trimmed.slice('from build123d import '.length).split(',').map((s) => s.trim());
      if (items.length === 1 && items[0] === '*') {
        i++;
        continue;
      }
      if (items.length > 0 && items.every((fn) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(fn) && !fn.includes('__'))) {
        i++;
        continue;
      }
    }
    if (trimmed.startsWith('from math import ')) {
      const items = trimmed.slice('from math import '.length).split(',').map((s) => s.trim());
      if (items.length > 0 && items.every((fn) => ALLOWED_MATH_FUNCS.has(fn))) {
        i++;
        continue;
      }
    }
    break;
  }
  return [...kept, ...lines.slice(i)];
}

/**
 * Extracts the body portion of a build123d script.
 *
 * - With sentinel: drops everything before sentinel and leading blank lines.
 * - Without sentinel: strips copied versioned preludes and allowed prelude lines.
 * - Body-only: returns unchanged (apart from leading blank lines).
 */
export function toBody(script: string): string {
  if (hasPreludeSentinel(script)) {
    const sentinelIdx = script.indexOf(PRELUDE_SENTINEL);
    return trimLeadingBlankLines(script.slice(sentinelIdx + PRELUDE_SENTINEL.length));
  }

  let lines = script.split('\n');

  for (const registered of Object.values(PRELUDES)) {
    const matched =
      matchAndStripCandidate(lines, registered, false) ??
      matchAndStripCandidate(
        lines,
        registered
          .split('\n')
          .filter((l) => !l.startsWith('#'))
          .join('\n'),
        false
      );
    if (matched) {
      lines = matched;
      break;
    }
  }

  lines = stripAllowedPreludeLines(lines);
  return trimLeadingBlankLines(lines.join('\n'));
}
