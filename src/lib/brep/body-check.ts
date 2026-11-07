/**
 * A Python-aware check of a model-written component body, before it is placed
 * inside `def <name>():` in the emitted script.
 *
 * A body is build123d construction code. It does not need to import, run
 * dynamic code, open files, reach dunder attributes, define functions or
 * classes, call another component, or rebind a spec parameter. The check works
 * on tokens, not on the raw text, so a `#` inside a string, a keyword inside a
 * string, or an alias (`f = lid; f()`) is read the way Python reads it.
 * A rejected body falls back to the code-drawn blockout.
 */

export interface BodyCheckOptions {
  /** Parameter and derived names as the script spells them: a body must not rebind them. */
  reserved?: Iterable<string>;
  /** Component names and their function names: a body must not call or alias them. */
  components?: Iterable<string>;
}

export type BodyCheck = { ok: true } | { ok: false; reason: string };

type Tok =
  | { k: 'name'; v: string }
  | { k: 'num'; v: string }
  | { k: 'str'; v: string; prefix: string }
  | { k: 'op'; v: string }
  | { k: 'nl' };

/** Names a body may not use as a name or an attribute. */
const BANNED_ANYWHERE = new Set([
  'import', 'from', 'def', 'class', 'global', 'nonlocal', 'async', 'await', 'yield', 'format', 'format_map',
]);
/** Names a body may not use as a bare name (an attribute of the same spelling is harmless). */
export const BANNED_NAMES = new Set([
  'exec', 'eval', 'compile', 'open', 'globals', 'locals', 'vars', 'dir', 'getattr', 'setattr', 'delattr',
  'input', 'breakpoint', 'help', 'exit', 'quit', 'memoryview', 'type', 'object', 'super', 'classmethod',
  'staticmethod', 'property', 'Mesher', 'ezdxf', 'brep_from_stl', 'FontManager',
  'os', 'sys', 'subprocess', 'builtins', 'ctypes', 'pathlib', 'shutil', 'socket', 'importlib', 'pickle',
]);
/**
 * Attribute names a body may not reach: anything private or special (`_x`, `__x__`), the
 * frame, code and traceback introspection families (`gi_frame.f_builtins` reaches `exec`
 * without a dunder), and the MRO.
 */
const BANNED_ATTRIBUTE = /^(?:_|gi_|cr_|ag_|f_|tb_|co_|func_)|^(?:mro|format|format_map)$/;
/** Keyword arguments that name a file to read or write (`Text(..., font_path=...)`). */
const FILE_KEYWORD = /^(?:font|font_path|file|files|filename|file_name|fname|filepath|path_name)$|_path$|_file$/;
/** Text(txt, font_size, font, font_path, ...): only the first two may be positional. */
const TEXT_MAX_POSITIONAL = 2;
const STRING_PREFIX = /^(?:[rRbBuUfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/;
const AUGMENTED = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '@=', '&=', '|=', '^=', '>>=', '<<=']);
const OPS3 = ['**=', '//=', '>>=', '<<=', '...'];
const OPS2 = ['==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', ':=', '->', '**', '//', '<<', '>>'];
const NUMBER = /^(?:0[xXoObB][0-9a-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)/;

export function checkPythonBody(body: string, options: BodyCheckOptions = {}): BodyCheck {
  // Only \n ends a line. A carriage return, form feed, NUL or other control character would
  // end a line for Python but not for the code that indents the body under `def`.
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(body)) return reject('control character in the body');
  let tokens: Tok[];
  try {
    tokens = tokenize(body);
  } catch (error) {
    return reject((error as Error).message);
  }

  const reserved = new Set(options.reserved ?? []);
  const components = new Set(options.components ?? []);

  // A name is an attribute when the previous token is '.'; a keyword argument when it sits
  // directly after '(' or ',' inside a call and is followed by '=' (not '==').
  const attribute = (i: number) => isOp(tokens[i - 1], '.');

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === 'str') {
      // f-strings and (Python 3.14) t-strings evaluate the expressions inside their braces.
      if (/[fFtT]/.test(t.prefix)) return reject('f-string or t-string');
      if (t.v.includes('__')) return reject('dunder in a string');
      // An underscore spelled as an escape (\x5f, \137, \u005f, \N{LOW LINE}) builds the same dunder.
      if (/\\(?:x5[fF]|137|u005[fF]|U0000005[fF]|N\{)/.test(t.v)) return reject('escaped underscore in a string');
      // A file keyword spelled as a string key (`**{'font_path': ...}`).
      if (FILE_KEYWORD.test(t.v)) return reject(`string ${t.v} names a file keyword`);
      continue;
    }
    if (t.k !== 'name') continue;
    if (t.v.includes('__')) return reject(`dunder name ${t.v}`);
    if (BANNED_ANYWHERE.has(t.v)) return reject(`${t.v} is not allowed in a body`);
    if (attribute(i)) {
      // Every attribute in a chain is checked, not only the first after a name.
      if (BANNED_ATTRIBUTE.test(t.v)) return reject(`attribute .${t.v} is not allowed in a body`);
      continue;
    }
    if (BANNED_NAMES.has(t.v) || /^(?:export|import)/i.test(t.v)) return reject(`${t.v} is not allowed in a body`);
    if (isKeywordArgument(tokens, i) && FILE_KEYWORD.test(t.v)) return reject(`keyword ${t.v}= names a file`);
    if (t.v === 'Text' && isOp(tokens[i + 1], '(')) {
      if (positionalArguments(tokens, i + 1) > TEXT_MAX_POSITIONAL) return reject('Text with a font or file given by position');
      if (unpacksArguments(tokens, i + 1)) return reject('Text with * or ** arguments');
    }
  }

  const bound = boundNames(tokens);
  for (const name of bound) {
    if (reserved.has(name)) return reject(`binds the spec parameter ${name}`);
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k !== 'name' || !components.has(t.v) || attribute(i)) continue;
    if (bound.has(t.v)) continue; // a local variable that happens to share the part's name
    if (isKeywordArgument(tokens, i)) continue;
    return reject(`refers to the component ${t.v}`);
  }
  // `_`-prefixed names belong to the script around the body (`_l_<part>`, `_p_<part>`, `_fuse`):
  // a body may use only the ones it binds itself.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k !== 'name' || !t.v.startsWith('_') || t.v === '_' || attribute(i)) continue;
    if (bound.has(t.v) || isKeywordArgument(tokens, i)) continue;
    return reject(`refers to ${t.v}, which the body does not define`);
  }

  if (!tokens.some((t) => t.k === 'name' && t.v === 'return')) return reject('no return statement');
  return { ok: true };
}

function isOp(t: Tok | undefined, v: string): boolean {
  return t?.k === 'op' && t.v === v;
}

function reject(reason: string): BodyCheck {
  return { ok: false, reason };
}

/** True when the call whose '(' is at `open` passes `*x` or `**x` at its top level. */
function unpacksArguments(tokens: Tok[], open: number): boolean {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === 'op' && '([{'.includes(t.v)) depth++;
    else if (t.k === 'op' && ')]}'.includes(t.v)) {
      depth--;
      if (depth === 0) return false;
    } else if (depth === 1 && (isOp(t, '*') || isOp(t, '**')) && (isOp(tokens[i - 1], '(') || isOp(tokens[i - 1], ','))) {
      return true;
    }
  }
  return false;
}

/** Positional arguments of the call whose '(' is at `open` (top level only; `name=` arguments are not counted). */
function positionalArguments(tokens: Tok[], open: number): number {
  let depth = 0;
  let count = 0;
  let argStart = true;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === 'op' && '([{'.includes(t.v)) {
      depth++;
      if (depth === 1) continue;
    } else if (t.k === 'op' && ')]}'.includes(t.v)) {
      depth--;
      if (depth === 0) return count;
    }
    if (depth !== 1) continue;
    if (isOp(t, ',')) {
      argStart = true;
      continue;
    }
    if (argStart) {
      argStart = false;
      const keyword = t.k === 'name' && isOp(tokens[i + 1], '=');
      if (!keyword) count++;
    }
  }
  return count;
}

function isKeywordArgument(tokens: Tok[], i: number): boolean {
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  return (
    prev?.k === 'op' && (prev.v === '(' || prev.v === ',') && next?.k === 'op' && next.v === '='
  );
}

/** Every name the body binds: assignment targets, `for` and `as` targets, walrus, annotated names. */
function boundNames(tokens: Tok[]): Set<string> {
  const out = new Set<string>();
  const lines: Tok[][] = [];
  let current: Tok[] = [];
  for (const t of tokens) {
    if (t.k === 'nl') {
      lines.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length > 0) lines.push(current);

  for (const { toks: line, header } of lines.flatMap((l) => splitCompound(l))) {
    if (!header) {
      // Assignment: everything left of the last top-level '=' (chained a = b = c binds a and b).
      let depth = 0;
      let lastEq = -1;
      let augmented = -1;
      for (let i = 0; i < line.length; i++) {
        const t = line[i];
        if (t.k !== 'op') continue;
        if ('([{'.includes(t.v)) depth++;
        else if (')]}'.includes(t.v)) depth--;
        else if (depth === 0 && t.v === '=') lastEq = i;
        else if (depth === 0 && AUGMENTED.has(t.v)) augmented = i;
      }
      const end = lastEq >= 0 ? lastEq : augmented;
      if (end >= 0) targets(line.slice(0, end), out);
      // x: int = 3 binds x.
      const first = line[0];
      if (first?.k === 'name' && isOp(line[1], ':') && !isKeyword(first.v)) out.add(first.v);
    }

    const first = line[0];
    if (header && first?.k === 'name' && first.v === 'for') {
      const inAt = line.findIndex((t, i) => i > 0 && t.k === 'name' && t.v === 'in');
      if (inAt > 0) targets(line.slice(1, inAt), out);
    }
    for (let i = 0; i < line.length; i++) {
      const t = line[i];
      if (t.k === 'name' && t.v === 'as') targets(line.slice(i + 1, i + 2), out);
      if (t.k === 'op' && t.v === ':=' && line[i - 1]?.k === 'name') out.add((line[i - 1] as { v: string }).v);
    }
  }
  return out;
}

const COMPOUND = new Set(['if', 'elif', 'else', 'while', 'for', 'with', 'try', 'except', 'finally', 'match', 'case']);

/**
 * A compound statement's header and the statement after its colon, when they share a line
 * (`if _l_a: z = 1`). The header binds only `for` and `as` targets and walrus names; a name
 * it merely reads is never a binding. A header with nothing after the colon is returned alone.
 */
function splitCompound(line: Tok[]): { toks: Tok[]; header: boolean }[] {
  const first = line[0];
  if (first?.k !== 'name' || !COMPOUND.has(first.v)) return [{ toks: line, header: false }];
  // `match` and `case` are soft keywords: `match = 3` is an assignment, not a header.
  if ((first.v === 'match' || first.v === 'case') && (isOp(line[1], '=') || isOp(line[1], '.') || isOp(line[1], '('))) {
    if (!line.some((t, i) => i > 1 && isOp(t, ':'))) return [{ toks: line, header: false }];
  }
  let depth = 0;
  let lambdas = 0;
  for (let i = 1; i < line.length; i++) {
    const t = line[i];
    if (t.k === 'name' && t.v === 'lambda' && depth === 0) lambdas++;
    if (t.k !== 'op') continue;
    if ('([{'.includes(t.v)) depth++;
    else if (')]}'.includes(t.v)) depth--;
    else if (depth === 0 && t.v === ':') {
      if (lambdas > 0) {
        lambdas--;
        continue;
      }
      const rest = line.slice(i + 1);
      return [{ toks: line.slice(0, i), header: true }, ...(rest.length > 0 ? splitCompound(rest) : [])];
    }
  }
  return [{ toks: line, header: true }];
}

/** Plain names in an assignment target; names inside a subscript, call or attribute are reads. */
function targets(toks: Tok[], out: Set<string>): void {
  const closers: boolean[] = []; // true when the open bracket groups names (tuple/list target)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'op' && '([{'.includes(t.v)) {
      const prev = toks[i - 1];
      const grouping = !prev || (prev.k === 'op' && !')]}'.includes(prev.v));
      closers.push(grouping);
      continue;
    }
    if (t.k === 'op' && ')]}'.includes(t.v)) {
      closers.pop();
      continue;
    }
    if (t.k !== 'name' || isKeyword(t.v)) continue;
    if (isOp(toks[i - 1], '.')) continue;
    if (closers.some((grouping) => !grouping)) continue;
    // `a.b = 1` and `a[0] = 1` read `a`; only a bare name followed by '.' or '[' is a read.
    const next = toks[i + 1];
    if (next?.k === 'op' && (next.v === '.' || next.v === '[' || next.v === '(')) continue;
    out.add(t.v);
  }
}

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'break', 'continue', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'if', 'in', 'is', 'lambda', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with',
]);
const isKeyword = (name: string) => KEYWORDS.has(name);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let depth = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') {
      if (depth === 0 && out.length > 0 && out[out.length - 1].k !== 'nl') out.push({ k: 'nl' });
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      throw new Error('stray backslash');
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if ((src[j] === '"' || src[j] === "'") && STRING_PREFIX.test(word)) {
        const { end, value } = readString(src, j);
        out.push({ k: 'str', v: value, prefix: word });
        i = end;
        continue;
      }
      out.push({ k: 'name', v: word });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const { end, value } = readString(src, i);
      out.push({ k: 'str', v: value, prefix: '' });
      i = end;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = NUMBER.exec(src.slice(i));
      if (!m) throw new Error('bad number');
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS3.find((o) => src.startsWith(o, i)) ?? OPS2.find((o) => src.startsWith(o, i)) ?? ch;
    if (!/^[-+*/%@&|^~<>=!.,:;()[\]{}]+$/.test(op)) throw new Error(`character ${JSON.stringify(ch)} is not Python syntax`);
    if ('([{'.includes(op)) depth++;
    else if (')]}'.includes(op)) depth = Math.max(0, depth - 1);
    if (op === ';') {
      out.push({ k: 'nl' });
    } else {
      out.push({ k: 'op', v: op });
    }
    i += op.length;
  }
  return out;
}

function readString(src: string, start: number): { end: number; value: string } {
  const quote = src[start];
  const triple = src.startsWith(quote.repeat(3), start);
  const delim = triple ? quote.repeat(3) : quote;
  let i = start + delim.length;
  const content: string[] = [];
  while (i < src.length) {
    if (src[i] === '\\') {
      content.push(src.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (src.startsWith(delim, i)) return { end: i + delim.length, value: content.join('') };
    if (!triple && src[i] === '\n') break;
    content.push(src[i]);
    i++;
  }
  throw new Error('unterminated string');
}
