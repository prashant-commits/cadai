import type { AssemblySpec } from './assembly-spec';
import { blockoutBody } from '../spec-sheet/blockout-scad';

/**
 * The Architect's post-gate build reply:
 *
 * ```
 * @body <component>
 * <OpenSCAD module body, local frame>
 * @end
 * @body <component> blockout
 * @addressed <id>[: free text]
 * ```
 *
 * A section with no `@end` is dropped. An empty, comment-only, or still-wrapped
 * module body is dropped too. A body that calls its own module is dropped too,
 * because assembling that call would recurse. Code then draws that part from
 * its blockout.
 */

const END_LINE = /^[ \t]*@end\b(?:[ \t]+(?!\/\/)\S+)?[ \t]*(?:\/\/.*)?[ \t]*$/;
const BODY_LINE = /^[ \t]*@body[ \t]+(\S+)(?:[ \t]+(blockout))?[ \t]*(?:\/\/.*)?$/;
const ADDRESSED_LINE = /^[ \t]*@addressed\b(.*)$/;
const FENCE_LINE = /^[ \t]*```/;

type Piece =
  | { kind: 'gap' | 'empty' | 'special' | 'stmt'; start: number; end: number }
  | { kind: 'assignment'; start: number; end: number; name: string }
  | { kind: 'module'; start: number; end: number; interiorStart: number; interiorEnd: number; paramsEmpty: boolean; name: string }
  | { kind: 'braced-transform'; start: number; end: number; interiorStart: number; interiorEnd: number };

function isModule(piece: Piece): piece is Extract<Piece, { kind: 'module' }> {
  return piece.kind === 'module';
}

function isBracedTransform(piece: Piece): piece is Extract<Piece, { kind: 'braced-transform' }> {
  return piece.kind === 'braced-transform';
}

export function parseBuild(text: string, componentNames: string[], reserved: string[] = []): {
  bodies: Record<string, string>;
  keepBlockout: string[];
  addressed: string[];
  dropped: string[];
} {
  const known = new Set(componentNames);
  const bodies: Record<string, string> = {};
  const keepBlockout: string[] = [];
  const addressed: string[] = [];
  const dropped: string[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;

  const drop = (name: string) => {
    delete bodies[name];
    remove(keepBlockout, name);
    if (!dropped.includes(name)) dropped.push(name);
  };

  const noteDropped = (name: string) => {
    if (!dropped.includes(name)) dropped.push(name);
  };

  while (i < lines.length) {
    const line = lines[i];
    const addressedId = readAddressed(line);
    if (addressedId !== null) {
      addressed.push(addressedId);
      i += 1;
      continue;
    }

    const directive = readBodyDirective(line);
    if (!directive) {
      i += 1;
      continue;
    }

    if (directive.blockout) {
      if (known.has(directive.name)) {
        delete bodies[directive.name];
        remove(dropped, directive.name);
        if (!keepBlockout.includes(directive.name)) keepBlockout.push(directive.name);
      } else {
        drop(directive.name);
      }
      i += 1;
      continue;
    }

    const collected: string[] = [];
    i += 1;
    let closed = false;
    while (i < lines.length) {
      const next = lines[i];
      if (END_LINE.test(next)) {
        closed = true;
        i += 1;
        break;
      }
      // A later directive means this section was cut off before `@end`.
      if (readAddressed(next) !== null || readBodyDirective(next)) break;
      if (FENCE_LINE.test(next)) {
        i += 1;
        continue;
      }
      collected.push(next);
      i += 1;
    }

    const name = directive.name;
    if (!closed) {
      // A cut-off repeat must not discard a body or a blockout request already accepted.
      const kept = Object.prototype.hasOwnProperty.call(bodies, name) || keepBlockout.includes(name);
      if (!known.has(name) || !kept) noteDropped(name);
      continue;
    }
    if (!known.has(name)) {
      drop(name);
      continue;
    }

    const raw = collected.join('\n');
    const cleaned = sanitizeBody(raw, reserved);
    if (!acceptsSection(raw, name, reserved) || !isUsableBody(cleaned, name)) {
      drop(name);
      continue;
    }
    bodies[name] = cleaned;
    remove(keepBlockout, name);
    remove(dropped, name);
  }

  return { bodies, keepBlockout, addressed, dropped };
}

/**
 * Peel one empty-parameter `module` wrapper and one whole-body braced
 * transform, then remove top-level assignments whose names are in `reserved`.
 * Local variables, `$fn`, and a transform applied to a single statement stay.
 * A body that needs none of that is returned unchanged.
 */
export function sanitizeBody(body: string, reserved: string[]): string {
  const names = new Set(reserved);
  let current = body;
  let changed = false;

  const strippedFirst = stripReservedAssignments(current, names);
  if (strippedFirst !== null) {
    current = strippedFirst;
    changed = true;
  }

  let unwrappedModule = false;
  let unwrappedTransform = false;
  for (let pass = 0; pass < 4 && (!unwrappedModule || !unwrappedTransform); pass += 1) {
    if (!unwrappedModule) {
      const next = unwrapOneModule(current);
      if (next !== null) {
        current = next;
        changed = true;
        unwrappedModule = true;
        continue;
      }
    }
    if (!unwrappedTransform) {
      const next = unwrapWholeBracedTransform(current);
      if (next !== null) {
        current = next;
        changed = true;
        unwrappedTransform = true;
        continue;
      }
    }
    break;
  }

  const stripped = stripReservedAssignments(current, names);
  if (stripped !== null) {
    current = stripped;
    changed = true;
  }

  return changed ? current : body;
}

export function assembleScript(
  spec: AssemblySpec,
  parsed: ReturnType<typeof parseBuild>,
  header = '',
): string {
  const modules: string[] = [];
  for (const comp of spec.components ?? []) {
    const name = comp.name;
    const authored = Object.prototype.hasOwnProperty.call(parsed.bodies, name)
      ? parsed.bodies[name]
      : undefined;
    const body = authored !== undefined ? authored : blockoutBody(spec, name);
    if (body === undefined || body === null) continue;
    modules.push(moduleSource(name, body));
  }

  const script = modules.join('\n\n');
  if (!header) return script ? `${script}\n` : '';
  const prefix = header.endsWith('\n') ? header : `${header}\n`;
  return script ? `${prefix}\n${script}\n` : prefix;
}

function moduleSource(name: string, body: string): string {
  const header = /\d/.test(name) ? `module ${name}() { // local module ${name}` : `module ${name}() {`;
  const inner = body.replace(/\n+$/, '');
  if (inner.trim() === '') return `${header}\n}`;
  return `${header}\n${inner}\n}`;
}

function readBodyDirective(line: string): { name: string; blockout: boolean } | null {
  const match = BODY_LINE.exec(line);
  if (!match) return null;
  return { name: match[1], blockout: match[2] === 'blockout' };
}

function readAddressed(line: string): string | null {
  const match = ADDRESSED_LINE.exec(line);
  if (!match) return null;
  const id = match[1].trim().split(':')[0].trim();
  return id || null;
}

function remove(list: string[], name: string) {
  const at = list.indexOf(name);
  if (at >= 0) list.splice(at, 1);
}

/**
 * After reserved assignments are stripped, a section is usable only as plain
 * geometry, or as exactly one `module <part>() {}` plus `$fn` and assignment lines.
 * Assignment-only text draws nothing, so it falls back to the blockout.
 */
function acceptsSection(raw: string, partName: string, reserved: string[]): boolean {
  const stripped = stripReservedAssignments(raw, new Set(reserved)) ?? raw;
  if (!containsModuleDef(stripped)) return hasGeometry(stripped);
  const pieces = splitTop(stripped);
  const modules = pieces.filter(isModule);
  if (modules.length !== 1) return false;
  const wrapped = modules[0];
  if (!wrapped.paramsEmpty || wrapped.name !== partName) return false;
  if (containsModuleDef(stripped.slice(wrapped.interiorStart, wrapped.interiorEnd))) return false;
  for (const piece of pieces) {
    if (piece === wrapped) continue;
    if (piece.kind !== 'gap' && piece.kind !== 'empty' && piece.kind !== 'assignment' && piece.kind !== 'special') {
      return false;
    }
  }
  return hasGeometry(stripped.slice(wrapped.interiorStart, wrapped.interiorEnd));
}

/** A body that draws nothing, still defines a module, or calls that module cannot be assembled. */
function isUsableBody(src: string, partName: string): boolean {
  if (containsModuleDef(src)) return false;
  if (callsOwnModule(src, partName)) return false;
  return hasGeometry(src);
}

/** True when `src` instantiates `name`. A definition (`module name(...)`) is not a call. */
function callsOwnModule(src: string, name: string): boolean {
  let i = 0;
  while (i < src.length) {
    const step = stepToken(src, i);
    if (step.kind === 'skip') {
      i = step.to;
      continue;
    }
    const word = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (!word) {
      i += 1;
      continue;
    }
    const after = i + word[0].length;
    if (word[0] === name && src[skipTrivia(src, after)] === '(' && !/\bmodule\s+$/.test(src.slice(0, i))) {
      return true;
    }
    i = after;
  }
  return false;
}

function hasGeometry(src: string): boolean {
  return splitTop(src).some((piece) => piece.kind === 'stmt' || piece.kind === 'braced-transform');
}

function stripReservedAssignments(src: string, reserved: Set<string>): string | null {
  const pieces = splitTop(src);
  if (!pieces.some((piece) => piece.kind === 'assignment' && reserved.has(piece.name))) return null;
  let out = '';
  for (const piece of pieces) {
    if (piece.kind === 'assignment' && reserved.has(piece.name)) continue;
    out += src.slice(piece.start, piece.end);
  }
  return out;
}

function unwrapOneModule(src: string): string | null {
  const pieces = splitTop(src);
  const modules = pieces.filter(isModule);
  if (modules.length !== 1 || !modules[0].paramsEmpty) return null;
  const wrapped = modules[0];
  if (containsModuleDef(src.slice(wrapped.interiorStart, wrapped.interiorEnd))) return null;
  // Only `$fn`, assignments, and empty statements may sit beside the wrapper.
  for (const piece of pieces) {
    if (piece === wrapped || piece.kind === 'gap' || piece.kind === 'empty' || piece.kind === 'assignment' || piece.kind === 'special') {
      continue;
    }
    return null;
  }
  return rebuild(src, pieces, wrapped, src.slice(wrapped.interiorStart, wrapped.interiorEnd));
}

function unwrapWholeBracedTransform(src: string): string | null {
  const pieces = splitTop(src);
  const transforms = pieces.filter(isBracedTransform);
  if (transforms.length !== 1) return null;
  const extra = pieces.some((piece) => piece !== transforms[0] && piece.kind !== 'gap' && piece.kind !== 'empty');
  if (extra) return null;
  const wrapped = transforms[0];
  return rebuild(src, pieces, wrapped, src.slice(wrapped.interiorStart, wrapped.interiorEnd));
}

function rebuild(src: string, pieces: Piece[], replace: Piece, insertion: string): string {
  let out = '';
  for (const piece of pieces) out += piece === replace ? insertion : src.slice(piece.start, piece.end);
  return out;
}

function splitTop(src: string): Piece[] {
  const pieces: Piece[] = [];
  let i = 0;
  while (i < src.length) {
    const next = skipTrivia(src, i);
    if (next > i) pieces.push({ kind: 'gap', start: i, end: next });
    if (next >= src.length) break;
    const stmt = scanStatement(src, next);
    if (!stmt || stmt.end <= next) {
      pieces.push({ kind: 'stmt', start: next, end: next + 1 });
      i = next + 1;
      continue;
    }
    pieces.push(stmt);
    i = stmt.end;
  }
  return pieces;
}

function scanStatement(src: string, start: number): Piece | null {
  if (src[start] === ';') return { kind: 'empty', start, end: start + 1 };
  return scanModule(src, start) ?? scanAssignment(src, start) ?? scanBracedTransform(src, start) ?? scanGeneral(src, start);
}

function scanModule(src: string, start: number): Piece | null {
  const head = src.slice(start).match(/^module\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!head) return null;
  const parenOpen = start + head[0].length - 1;
  const parenClose = matchClose(src, parenOpen, '(', ')');
  if (parenClose === null) return null;
  const braceOpen = skipTrivia(src, parenClose + 1);
  if (src[braceOpen] !== '{') return null;
  const braceClose = matchClose(src, braceOpen, '{', '}');
  if (braceClose === null) return null;
  let end = braceClose + 1;
  const after = skipTrivia(src, end);
  if (src[after] === ';') end = after + 1;
  return {
    kind: 'module',
    start,
    end,
    interiorStart: braceOpen + 1,
    interiorEnd: braceClose,
    paramsEmpty: isOnlyTrivia(src.slice(parenOpen + 1, parenClose)),
    name: head[1],
  };
}

function scanAssignment(src: string, start: number): Piece | null {
  const head = src.slice(start).match(/^(\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (!head) return null;
  const end = findSemicolon(src, start);
  if (end === null) return null;
  const name = head[1];
  if (name.startsWith('$')) return { kind: 'special', start, end };
  return { kind: 'assignment', start, end, name };
}

function scanBracedTransform(src: string, start: number): Piece | null {
  const head = src.slice(start).match(/^(translate|rotate|mirror)\s*\(/);
  if (!head) return null;
  const parenOpen = start + head[0].length - 1;
  const parenClose = matchClose(src, parenOpen, '(', ')');
  if (parenClose === null) return null;
  const braceOpen = skipTrivia(src, parenClose + 1);
  if (src[braceOpen] !== '{') return null;
  const braceClose = matchClose(src, braceOpen, '{', '}');
  if (braceClose === null) return null;
  return {
    kind: 'braced-transform',
    start,
    end: braceClose + 1,
    interiorStart: braceOpen + 1,
    interiorEnd: braceClose,
  };
}

function scanGeneral(src: string, start: number): Piece | null {
  const end = walkStatement(src, start);
  if (end <= start) return null;
  return { kind: 'stmt', start, end };
}

/** Index just past the `;` that ends an assignment, or null when the statement does not close. */
function findSemicolon(src: string, start: number): number | null {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let i = start;
  while (i < src.length) {
    const step = stepToken(src, i);
    if (step.kind === 'skip') {
      i = step.to;
      continue;
    }
    const c = src[i];
    if (c === '(') paren += 1;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '{') brace += 1;
    else if (c === '}') {
      if (brace === 0) return null;
      brace -= 1;
    } else if (c === ';' && paren === 0 && bracket === 0 && brace === 0) {
      return i + 1;
    }
    i += 1;
  }
  return null;
}

/** Index just past a statement: a depth-0 `;`, or the `}` that closes its child block. */
function walkStatement(src: string, start: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let sawBrace = false;
  let i = start;
  while (i < src.length) {
    const step = stepToken(src, i);
    if (step.kind === 'skip') {
      i = step.to;
      continue;
    }
    const c = src[i];
    if (c === '(') paren += 1;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '{') {
      brace += 1;
      sawBrace = true;
    } else if (c === '}') {
      if (brace > 0) brace -= 1;
      if (brace === 0 && paren === 0 && bracket === 0 && sawBrace) return i + 1;
    } else if (c === ';' && paren === 0 && bracket === 0 && brace === 0) {
      return i + 1;
    }
    i += 1;
  }
  return src.length;
}

function containsModuleDef(src: string): boolean {
  let i = 0;
  while (i < src.length) {
    const step = stepToken(src, i);
    if (step.kind === 'skip') {
      i = step.to;
      continue;
    }
    const word = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (word) {
      const after = i + word[0].length;
      if (word[0] === 'module' && /^\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(src.slice(after))) return true;
      i = after;
      continue;
    }
    i += 1;
  }
  return false;
}

function isOnlyTrivia(src: string): boolean {
  return skipTrivia(src, 0) === src.length;
}

function skipTrivia(src: string, index: number): number {
  let i = index;
  while (i < src.length) {
    const step = stepToken(src, i);
    if (step.kind !== 'skip' || step.trivia !== true) break;
    i = step.to;
  }
  return i;
}

/** One comment, string, or the character under `index`. Strings and comments are not code. */
function stepToken(src: string, index: number): { kind: 'skip'; to: number; trivia?: boolean } | { kind: 'char' } {
  const c = src[index];
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
    return { kind: 'skip', to: index + 1, trivia: true };
  }
  if (c === '/' && src[index + 1] === '/') {
    const nl = src.indexOf('\n', index);
    return { kind: 'skip', to: nl < 0 ? src.length : nl + 1, trivia: true };
  }
  if (c === '/' && src[index + 1] === '*') {
    const end = src.indexOf('*/', index + 2);
    return { kind: 'skip', to: end < 0 ? src.length : end + 2, trivia: true };
  }
  if (c === '"') {
    let i = index + 1;
    while (i < src.length) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '"' || src[i] === '\n') return { kind: 'skip', to: i + 1 };
      i += 1;
    }
    return { kind: 'skip', to: src.length };
  }
  return { kind: 'char' };
}

/** Index of the closer matching the opener at `openIndex`. */
function matchClose(src: string, openIndex: number, open: string, close: string): number | null {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const step = stepToken(src, i);
    if (step.kind === 'skip') {
      i = step.to;
      continue;
    }
    const c = src[i];
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return null;
}
