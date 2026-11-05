import { parseParams } from '../design/parse-params';
import { stripComments } from '../design/module-guards';

export interface LiteralLintResult {
  component: string;
  literal: number;
  param: string;
}

const IGNORED_NUMBERS = new Set([0, 1, 2, 90, 180, 360]);

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Replaces strings with spaces to keep offsets and avoid matching numbers in string literals. */
function stripStrings(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') {
        out += '  ';
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      out += ' ';
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Checks for numeric literals inside component module bodies that duplicate parameter values.
 */
export function literalLint(code: string): LiteralLintResult[] {
  const params = parseParams(code).filter((p) => typeof p.value === 'number');
  if (params.length === 0) return [];

  const clean = stripComments(code);
  const modRe = /\bmodule\s+([a-zA-Z0-9_$]+)\s*(?:\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  const results: LiteralLintResult[] = [];

  while ((m = modRe.exec(clean)) !== null) {
    const component = m[1];
    const openBrace = m.index + m[0].lastIndexOf('{');
    const closeBrace = matchBrace(clean, openBrace);
    if (closeBrace === -1) continue;

    const rawBody = clean.slice(openBrace + 1, closeBrace);
    modRe.lastIndex = closeBrace + 1;

    const noStrings = stripStrings(rawBody);
    // Ignore any $fn = ... assignment
    const noFn = noStrings.replace(/\$fn\s*=\s*[^;,)\n]+/g, (match) => ' '.repeat(match.length));

    // Match unsigned numeric literals not part of an identifier
    const numRe =
      /(?<![a-zA-Z0-9_$])(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?(?![a-zA-Z0-9_$])/g;
    let numMatch: RegExpExecArray | null;
    while ((numMatch = numRe.exec(noFn)) !== null) {
      const num = Number(numMatch[0]);
      if (IGNORED_NUMBERS.has(num)) continue;

      const matchedParam = params.find((p) => p.value === num);
      if (matchedParam) {
        results.push({
          component,
          literal: num,
          param: matchedParam.name,
        });
      }
    }
  }

  return results;
}
