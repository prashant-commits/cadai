import { parseParams } from '../design/parse-params';
import { stripComments } from '../design/module-guards';
import { stripGeneratedAssembly } from '../design/compose-assembly';

export interface LiteralLintResult {
  component: string;
  literal: number;
  param: string;
}

const IGNORED_NUMBERS = new Set([0, 1, 2, 90, 180, 360]);

/** Index of the `)` matching the `(` at `open`, or -1. */
function matchParen(code: string, open: number): number {
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
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

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
  const stripped = stripGeneratedAssembly(code);
  const params = parseParams(stripped).filter(
    (p) => typeof p.value === 'number' && !p.name.startsWith('$')
  );
  if (params.length === 0) return [];

  const clean = stripComments(stripped);
  const modHeaderRe = /\bmodule\s+([a-zA-Z0-9_$]+)/g;
  let m: RegExpExecArray | null;
  const results: LiteralLintResult[] = [];
  const seen = new Set<string>();

  while ((m = modHeaderRe.exec(clean)) !== null) {
    const component = m[1];
    let pos = m.index + m[0].length;
    while (pos < clean.length && /\s/.test(clean[pos])) pos++;

    if (pos < clean.length && clean[pos] === '(') {
      const closeParen = matchParen(clean, pos);
      if (closeParen === -1) continue;
      pos = closeParen + 1;
      while (pos < clean.length && /\s/.test(clean[pos])) pos++;
    }

    if (pos >= clean.length || clean[pos] !== '{') continue;
    const openBrace = pos;
    const closeBrace = matchBrace(clean, openBrace);
    if (closeBrace === -1) continue;

    const rawBody = clean.slice(openBrace + 1, closeBrace);
    modHeaderRe.lastIndex = closeBrace + 1;

    const noStrings = stripStrings(rawBody);
    // Ignore any $fn = ... assignment
    const noFn = noStrings.replace(/\$fn\s*=\s*[^;,)\n]+/g, (match) => ' '.repeat(match.length));

    // Match numeric literals (with optional sign) not part of an identifier
    const numRe =
      /(?<![a-zA-Z0-9_$])(-?)(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?(?![a-zA-Z0-9_$])/g;
    let numMatch: RegExpExecArray | null;
    while ((numMatch = numRe.exec(noFn)) !== null) {
      const sign = numMatch[1];
      const magnitude = Number(numMatch[0].slice(sign.length));
      const val = sign === '-' ? -magnitude : magnitude;
      if (IGNORED_NUMBERS.has(Math.abs(val))) continue;

      const matchedParam = params.find((p) => p.value === val || p.value === -val);
      if (matchedParam) {
        const literal = (matchedParam.value === val ? val : matchedParam.value) as number;
        const key = `${component}:${matchedParam.name}:${literal}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            component,
            literal,
            param: matchedParam.name,
          });
        }
      }
    }
  }

  return results;
}
