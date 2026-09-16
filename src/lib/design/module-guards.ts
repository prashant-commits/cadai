import type { AssemblySpec } from '../agent/assembly-spec';
import type { SpecViolation } from '../agent/spec-audit';

/**
 * Static guards on how a component module is written, for the defects no
 * measurement can see.
 *
 * Handedness is the clearest case. A part and its mirror image have the same
 * bounding box, the same volume, the same shell count, the same overhang and
 * the same centre of mass, so every numeric check in the pipeline passes a
 * left-handed bracket that should have been right-handed. The composer then
 * measures the mirrored module's min corner and politely corrects it back to
 * the origin, so even the local-frame warning stays silent. The part is simply
 * wrong, and nothing downstream says so.
 *
 * What is detectable is the transform itself. A `mirror()` wrapping a
 * component module's ENTIRE body flips the whole part, which is never what the
 * placement contract wants: modules are authored in assembly pose in
 * +x/+y/+z, and a part that needs the opposite hand is a different component,
 * not a flipped one. A mirror around one internal feature is legitimate and is
 * deliberately not flagged - only the whole-body case is.
 *
 * `scale()` with a negative factor is the same operation spelled differently,
 * so it is treated the same. A whole-body `scale()` with positive factors is
 * caught by the extents audit instead and is left alone here.
 */

/** Strips line and block comments so a transform inside a comment is not read as code. */
export function stripComments(code: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; i++; continue; }
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Index of the `}` matching the `{` at `open`, or -1. */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The body of `module <name>(...)`, comments stripped, or null when absent. */
export function moduleBody(code: string, name: string): string | null {
  const src = stripComments(code);
  const header = src.search(new RegExp(`module\\s+${name}\\s*\\(`));
  if (header === -1) return null;
  const open = src.indexOf('{', header);
  if (open === -1) return null;
  const close = matchBrace(src, open);
  if (close === -1) return null;
  return src.slice(open + 1, close);
}

/** True when `args` is a scale() argument list containing a negative factor. */
function hasNegativeFactor(args: string): boolean {
  return /-\s*(\d|\.)/.test(args);
}

/**
 * The chain of transform calls that wrap a module body in its entirety.
 *
 * `translate([..]) rotate([..]) { cube(); }` yields ['translate', 'rotate'].
 * A body with two sibling statements yields [] for the second and beyond,
 * because neither wraps the whole body.
 */
export function wholeBodyTransforms(body: string): { name: string; args: string }[] {
  const chain: { name: string; args: string }[] = [];
  let rest = body.trim();

  for (;;) {
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(rest);
    if (!m) break;
    const open = rest.indexOf('(', m.index);
    let depth = 0;
    let argEnd = -1;
    for (let i = open; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')') {
        depth--;
        if (depth === 0) { argEnd = i; break; }
      }
    }
    if (argEnd === -1) break;

    const args = rest.slice(open + 1, argEnd);
    const after = rest.slice(argEnd + 1).trim();
    // A transform modifies what follows it; a call ends at its semicolon.
    if (after.startsWith(';') || after === '') break;

    chain.push({ name: m[1], args });

    if (after.startsWith('{')) {
      const close = matchBrace(after, 0);
      if (close === -1) break;
      // Anything after the block means this transform did not wrap the whole body.
      if (after.slice(close + 1).trim() !== '') break;
      rest = after.slice(1, close).trim();
    } else {
      rest = after;
    }
  }

  return chain;
}

/**
 * Flags a component module whose entire body is mirrored or negatively scaled.
 * Error severity: the compiled part is the wrong hand, and no other check in
 * the pipeline can see it.
 */
export function auditModuleGuards(code: string, spec: AssemblySpec | null): SpecViolation[] {
  const violations: SpecViolation[] = [];
  for (const c of spec?.components ?? []) {
    const body = moduleBody(code, c.name);
    if (body === null) continue;
    for (const t of wholeBodyTransforms(body)) {
      const mirrored = t.name === 'mirror';
      const flipped = t.name === 'scale' && hasNegativeFactor(t.args);
      if (!mirrored && !flipped) continue;
      violations.push({
        kind: 'handedness',
        field: c.name,
        expected: 'the part authored in the hand the spec describes',
        measured: `${t.name}(${t.args.trim()}) wrapping the whole module body`,
        severity: 'error',
        message:
          `module ${c.name}() wraps its entire body in ${t.name}(${t.args.trim()}), so the compiled part is ` +
          'the mirror image of what the spec describes. A mirrored part has the same bounding box, volume and ' +
          'shell count as the original, so nothing else in the pipeline can catch this. Author the geometry ' +
          'in the hand the spec asks for; mirroring an individual feature inside the module is still fine.',
      });
      break;
    }
  }
  return violations;
}
