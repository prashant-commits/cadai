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
 * A section with no `@end` is dropped. Code then draws that part from its blockout.
 */

const END_LINE = /^[ \t]*@end[ \t]*$/;
const BODY_LINE = /^[ \t]*@body[ \t]+(\S+)(?:[ \t]+(blockout))?[ \t]*$/;
const ADDRESSED_LINE = /^[ \t]*@addressed\b(.*)$/;
const PARAM_ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*.+;\s*(?:\/\/.*|\/\*.*\*\/)?\s*$/;

export function parseBuild(text: string, componentNames: string[]): {
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
      if (END_LINE.test(lines[i])) {
        closed = true;
        i += 1;
        break;
      }
      // A later directive means this section was cut off before `@end`.
      if (readAddressed(lines[i]) !== null || readBodyDirective(lines[i])) break;
      collected.push(lines[i]);
      i += 1;
    }

    if (!closed || !known.has(directive.name)) {
      drop(directive.name);
      continue;
    }

    bodies[directive.name] = sanitizeBody(collected.join('\n'));
    remove(keepBlockout, directive.name);
    remove(dropped, directive.name);
  }

  return { bodies, keepBlockout, addressed, dropped };
}

/**
 * Strip a `module` wrapper, one whole-body `translate`/`rotate`/`mirror`,
 * and `name = value;` lines. `$fn = ...` stays. Anything else is returned unchanged.
 */
export function sanitizeBody(body: string): string {
  const peeled = peelWrappers(body);
  const base = peeled ?? body;
  const stripped = stripParamAssignments(base);
  if (peeled === null && stripped === null) return body;
  return stripped ?? peeled ?? body;
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

function peelWrappers(src: string): string | null {
  let current = src;
  let changed = false;

  const withoutModule = unwrapModule(current);
  if (withoutModule !== null) {
    current = withoutModule;
    changed = true;
  }

  const withoutTransform = unwrapTransform(current);
  if (withoutTransform !== null) {
    current = withoutTransform;
    changed = true;
    const innerModule = unwrapModule(current);
    if (innerModule !== null) current = innerModule;
  }

  return changed ? current : null;
}

function unwrapModule(src: string): string | null {
  const start = skipWsAndComments(src, 0);
  const head = src.slice(start).match(/^module\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/);
  if (!head) return null;
  const parenOpen = start + head[0].length - 1;
  const parenClose = matchClose(src, parenOpen, '(', ')');
  if (parenClose === null) return null;
  const braceOpen = skipWsAndComments(src, parenClose + 1);
  if (src[braceOpen] !== '{') return null;
  const braceClose = matchClose(src, braceOpen, '{', '}');
  if (braceClose === null) return null;
  if (skipWsAndComments(src, braceClose + 1) !== src.length) return null;
  return src.slice(braceOpen + 1, braceClose);
}

function unwrapTransform(src: string): string | null {
  const start = skipWsAndComments(src, 0);
  const head = src.slice(start).match(/^(translate|rotate|mirror)\s*\(/);
  if (!head) return null;
  const parenOpen = start + head[0].length - 1;
  const parenClose = matchClose(src, parenOpen, '(', ')');
  if (parenClose === null) return null;
  const next = skipWsAndComments(src, parenClose + 1);
  if (src[next] === '{') {
    const braceClose = matchClose(src, next, '{', '}');
    if (braceClose === null) return null;
    if (skipWsAndComments(src, braceClose + 1) !== src.length) return null;
    return src.slice(next + 1, braceClose);
  }
  const end = statementEnd(src, next);
  if (end === null) return null;
  if (skipWsAndComments(src, end) !== src.length) return null;
  return src.slice(next, end);
}

function stripParamAssignments(body: string): string | null {
  const lines = body.split('\n');
  let removed = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (isParamAssignment(line)) {
      removed = true;
      continue;
    }
    kept.push(line);
  }
  return removed ? kept.join('\n') : null;
}

function isParamAssignment(line: string): boolean {
  if (/^\s*\$fn\s*=/.test(line)) return false;
  return PARAM_ASSIGNMENT.test(line);
}

function skipWsAndComments(src: string, index: number): number {
  let i = index;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return src.length;
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

/** Index of the closer matching the opener at `openIndex`. */
function matchClose(src: string, openIndex: number, open: string, close: string): number | null {
  let depth = 0;
  let i = openIndex;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '"' || src[i] === '\n') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return null;
}

/** Index just past the statement that starts at `index`, when it is the only child. */
function statementEnd(src: string, index: number): number | null {
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  let i = index;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '"' || src[i] === '\n') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '(') paren += 1;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === '[') bracket += 1;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '{') brace += 1;
    else if (c === '}') {
      if (brace === 0) return null;
      brace -= 1;
      if (brace === 0 && paren === 0 && bracket === 0) return i + 1;
    } else if (c === ';' && paren === 0 && brace === 0 && bracket === 0) {
      return i + 1;
    }
    i += 1;
  }
  return null;
}
