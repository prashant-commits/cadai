import type { AssemblySpec, Guide } from './assembly-spec';

/** An arithmetic expression over spec parameters, e.g. "2*wall + max(a, 3)". */
export type Expr = string;

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

type Token =
  | { t: 'num'; v: number; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '(' | ')' | ','; pos: number }
  | { t: 'end'; pos: number };

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const NAME_START = /[a-z]/;
const NAME_PART = /[a-z0-9_]/;
const DIGIT = /[0-9]/;

const OPENSCAD_RESERVED = new Set([
  // Keywords, constants, control flow
  'for', 'let', 'each', 'if', 'else', 'module', 'function', 'include', 'use', 'true', 'false', 'undef',
  // 3D and 2D shapes
  'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon', 'text', 'import', 'surface', 'render',
  // Transformations & CSG
  'translate', 'rotate', 'scale', 'resize', 'mirror', 'multmatrix', 'color', 'hull', 'minkowski',
  'union', 'difference', 'intersection', 'linear_extrude', 'rotate_extrude', 'projection',
  // Built-in functions & special operations
  'children', 'echo', 'assert', 'len', 'abs', 'sign', 'sin', 'cos', 'tan', 'acos', 'asin', 'atan', 'atan2',
  'ceil', 'ln', 'log', 'exp', 'sqrt', 'min', 'max', 'pow', 'norm', 'cross', 'concat',
  'lookup', 'str', 'chr', 'search', 'version', 'version_num', 'parent_module',
]);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
    } else if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && DIGIT.test(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (i < src.length && DIGIT.test(src[i])) i++;
      }
      const text = src.slice(start, i);
      // "2x" / "3.4.5": a number glued to a name or a second dot is not in the grammar.
      if (i < src.length && (NAME_START.test(src[i]) || src[i] === '.' || src[i] === '_')) {
        throw new ExprError(`Unexpected "${src.slice(start, i + 1)}" at position ${start}`);
      }
      out.push({ t: 'num', v: Number(text), pos: start });
    } else if (NAME_START.test(ch)) {
      const start = i;
      while (i < src.length && NAME_PART.test(src[i])) i++;
      out.push({ t: 'name', v: src.slice(start, i), pos: start });
    } else if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')' || ch === ',') {
      out.push({ t: 'op', v: ch, pos: i });
      i++;
    } else {
      throw new ExprError(`Unexpected "${ch}" at position ${i}`);
    }
  }
  out.push({ t: 'end', pos: src.length });
  return out;
}

const FUNCS: Record<string, { min: number; max: number; fn: (a: number[]) => number }> = {
  min: { min: 1, max: Infinity, fn: (a) => Math.min(...a) },
  max: { min: 1, max: Infinity, fn: (a) => Math.max(...a) },
  sqrt: { min: 1, max: 1, fn: (a) => Math.sqrt(a[0]) },
};

/**
 * Evaluates one expression. Hand-written recursive descent over:
 *   expr   = term (('+'|'-') term)*
 *   term   = unary (('*'|'/') unary)*
 *   unary  = '-' unary | atom
 *   atom   = number | name | func '(' expr (',' expr)* ')' | '(' expr ')'
 * Anything else throws ExprError naming the offending token or name.
 */
export function evalExpr(expr: Expr, scope: Record<string, number>): number {
  const tokens = tokenize(expr);
  let p = 0;
  const peek = () => tokens[p];
  const describe = (tok: Token) => (tok.t === 'end' ? 'end of expression' : `"${tok.v}" at position ${tok.pos}`);
  const isOp = (v: string) => {
    const tok = peek();
    return tok.t === 'op' && tok.v === v;
  };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}" but found ${describe(peek())}`);
    p++;
  };

  function parseExpr(): number {
    let left = parseTerm();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[p++] as { v: string }).v;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseUnary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[p++] as { v: string }).v;
      const right = parseUnary();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  function parseUnary(): number {
    if (isOp('-')) {
      p++;
      return -parseUnary();
    }
    return parseAtom();
  }

  function parseAtom(): number {
    const tok = peek();
    if (tok.t === 'num') {
      p++;
      return tok.v;
    }
    if (tok.t === 'name') {
      p++;
      if (isOp('(')) {
        const f = Object.hasOwn(FUNCS, tok.v) ? FUNCS[tok.v] : undefined;
        if (!f) throw new ExprError(`Unknown function "${tok.v}" at position ${tok.pos}`);
        p++;
        const args = [parseExpr()];
        while (isOp(',')) {
          p++;
          args.push(parseExpr());
        }
        expectOp(')');
        if (args.length < f.min || args.length > f.max) {
          throw new ExprError(`Function "${tok.v}" takes ${f.min === f.max ? f.min : `at least ${f.min}`} argument(s), got ${args.length}`);
        }
        return f.fn(args);
      }
      if (!Object.hasOwn(scope, tok.v)) throw new ExprError(`Unknown name "${tok.v}" at position ${tok.pos}`);
      return scope[tok.v];
    }
    if (isOp('(')) {
      p++;
      const v = parseExpr();
      expectOp(')');
      return v;
    }
    throw new ExprError(`Unexpected ${describe(tok)}`);
  }

  const value = parseExpr();
  if (peek().t !== 'end') throw new ExprError(`Unexpected ${describe(peek())}`);
  return value;
}

type Component = NonNullable<AssemblySpec['components']>[number];
type Hole = NonNullable<Component['holes']>[number];
type ComponentExpr = NonNullable<Component['expr']>;

/**
 * Evaluates every expression string in a spec into a number, so every
 * downstream consumer keeps seeing plain numbers. Scope is `parameters`
 * (by value), then each `derived` in order. The original string is kept in
 * `component.expr` beside the number it produced (null where the field was
 * already a number). Never throws: unknown names and non-finite results are
 * returned in `errors`, and the field is left at 0 so the spec stays typed.
 */
export function resolveSpec(raw: AssemblySpec): { spec: AssemblySpec; errors: string[] } {
  const errors: string[] = [];
  const scope: Record<string, number> = {};

  /**
   * Models often write names with capitals ("W", "peg_L", "R_o"). The grammar is
   * lowercase-only, so such a name is lowercased (here and in every expression
   * that uses it) when the lowercase form is valid and taken by no other name.
   * Otherwise it is left as written and reported below.
   */
  const rawNames = [...(raw.parameters ?? []).map((p) => p.name), ...(raw.derived ?? []).map((d) => d.name)];
  const rename = new Map<string, string>();
  for (const name of rawNames) {
    if (NAME_RE.test(name)) continue;
    const lower = name.toLowerCase();
    // The lowercase form must be valid, not a keyword/built-in, and unique among all names.
    if (!NAME_RE.test(lower) || OPENSCAD_RESERVED.has(lower) || Object.hasOwn(FUNCS, lower)) continue;
    if (rawNames.filter((n) => n.toLowerCase() === lower).length > 1) continue;
    rename.set(name, lower);
  }
  const canonName = (name: string) => rename.get(name) ?? name;
  /** Renamed names, and capitalised calls of the grammar's functions (MAX(a, b) -> max(a, b)). */
  const canon = (src: string) =>
    src.replace(/(?<![\w.])[A-Za-z_][A-Za-z0-9_]*/g, (tok) => {
      const renamed = rename.get(tok);
      if (renamed) return renamed;
      const lower = tok.toLowerCase();
      return lower !== tok && Object.hasOwn(FUNCS, lower) ? lower : tok;
    });
  /** An empty string in an optional numeric field means the model left it unset. */
  const blank = (v: unknown) => typeof v === 'string' && v.trim() === '';

  const declared = new Set<string>();
  /** A declared name must fit the grammar and be unique across parameters and derived. */
  const declare = (kind: 'parameter' | 'derived', name: string): boolean => {
    if (!NAME_RE.test(name)) {
      errors.push(`${kind} "${name}" is not a valid name (lowercase letters, digits, underscore; must start with a letter)`);
      return false;
    }
    if (OPENSCAD_RESERVED.has(name)) {
      errors.push(`${kind} "${name}" is an OpenSCAD keyword or built-in and cannot be used as a ${kind} name`);
      return false;
    }
    if (declared.has(name)) {
      errors.push(`${kind} "${name}" is declared more than once (names must be unique across parameters and derived)`);
      return false;
    }
    declared.add(name);
    return true;
  };

  const parameters = raw.parameters?.map((p) => ({ ...p, name: canonName(p.name) }));
  const derived = raw.derived?.map((d) => ({ ...d, name: canonName(d.name), expr: canon(d.expr) }));
  const relations = raw.relations?.map((r) => ({ ...r, expr: canon(r.expr) }));

  for (const p of parameters ?? []) if (declare('parameter', p.name)) scope[p.name] = p.value;
  for (const d of derived ?? []) {
    if (!declare('derived', d.name)) continue;
    try {
      const v = evalExpr(d.expr, scope);
      if (Number.isFinite(v)) scope[d.name] = v;
      else errors.push(`derived "${d.name}" = "${d.expr}" is not a finite number`);
    } catch (e) {
      errors.push(`derived "${d.name}" = "${d.expr}": ${(e as Error).message}`);
    }
  }

  /**
   * Number in, number out; string in, evaluated. `prior` is the expression kept
   * from an earlier pass: when present it is the source of truth and the number
   * is only its cache, so resolving twice gives the same value and the same
   * errors. `where` names the field in errors.
   */
  const num = (v: unknown, where: string, prior?: string | null): { value: number; expr: string | null } => {
    const given = prior ?? (typeof v === 'string' ? v : null);
    if (given === null) return { value: v as number, expr: null };
    const src = canon(given);
    try {
      const n = evalExpr(src, scope);
      if (Number.isFinite(n)) return { value: n, expr: src };
      errors.push(`${where} = "${src}" is not a finite number`);
    } catch (e) {
      errors.push(`${where} = "${src}": ${(e as Error).message}`);
    }
    return { value: 0, expr: src };
  };

  const vec = (v: unknown, where: string, prior?: (string | null)[]): { value: number[]; expr: (string | null)[] | undefined } => {
    const arr = v as unknown[];
    const parts = arr.map((x, i) => num(x, `${where}[${i}]`, prior?.[i]));
    return { value: parts.map((x) => x.value), expr: parts.some((x) => x.expr !== null) ? parts.map((x) => x.expr) : undefined };
  };

  const components = raw.components?.map((c) => {
    const w = `component "${c.name}"`;
    const out: Component = { ...c };
    const expr: ComponentExpr = { ...(c.expr ?? {}) };

    for (const f of ['localExtents', 'position', 'rotation'] as const) {
      if (c[f] === undefined) continue;
      const r = vec(c[f], `${w} ${f}`, c.expr?.[f]);
      out[f] = r.value;
      if (r.expr) expr[f] = r.expr;
    }

    if (c.shape) {
      const shape = { ...c.shape };
      for (const f of ['innerD', 'wall'] as const) {
        if (blank(shape[f]) && !c.expr?.[f]) delete shape[f];
        if (shape[f] === undefined) continue;
        const r = num(shape[f], `${w} shape.${f}`, c.expr?.[f]);
        shape[f] = r.value;
        if (r.expr !== null) expr[f] = r.expr;
      }
      out.shape = shape;
    }

    if (c.holes) {
      const holeExprs: NonNullable<ComponentExpr['holes']> = [];
      let any = false;
      out.holes = c.holes.map((h, i) => {
        const hw = `${w} holes[${i}]`;
        const hole: Hole = { ...h };
        const he: NonNullable<ComponentExpr['holes']>[number] = {};
        const prior = c.expr?.holes?.[i];
        const d = num(h.d, `${hw}.d`, prior?.d);
        hole.d = d.value;
        if (d.expr !== null) he.d = d.expr;
        const at = vec(h.at, `${hw}.at`, prior?.at);
        hole.at = at.value;
        if (at.expr) he.at = at.expr;
        if (blank(h.depth) && !prior?.depth) delete hole.depth;
        else if (h.depth !== undefined) {
          const dp = num(h.depth, `${hw}.depth`, prior?.depth);
          hole.depth = dp.value;
          if (dp.expr !== null) he.depth = dp.expr;
        }
        if (Object.keys(he).length) any = true;
        holeExprs.push(he);
        return hole;
      });
      if (any) expr.holes = holeExprs;
    }

    if (Object.keys(expr).length) out.expr = expr;
    return out;
  });

  const guides = raw.guides?.map((g) => {
    const w = `guide "${g.label}"`;
    const out: Guide = { ...g };
    const expr: NonNullable<Guide['expr']> = { ...(g.expr ?? {}) };
    for (const f of ['localExtents', 'position', 'rotation'] as const) {
      if (g[f] === undefined) continue;
      const r = vec(g[f], `${w} ${f}`, g.expr?.[f]);
      out[f] = r.value;
      if (r.expr) expr[f] = r.expr;
    }
    if (g.points) {
      const pts = g.points.map((pt, i) => vec(pt, `${w} points[${i}]`, g.expr?.points?.[i] ?? undefined));
      out.points = pts.map((r) => r.value);
      if (pts.some((r) => r.expr)) expr.points = pts.map((r) => r.expr ?? null);
    }
    if (g.shape) {
      const shape = { ...g.shape };
      for (const f of ['innerD', 'wall'] as const) {
        if (blank(shape[f]) && !g.expr?.[f]) delete shape[f];
        if (shape[f] === undefined) continue;
        const r = num(shape[f], `${w} shape.${f}`, g.expr?.[f]);
        shape[f] = r.value;
        if (r.expr !== null) expr[f] = r.expr;
      }
      out.shape = shape;
    }
    if (Object.keys(expr).length) out.expr = expr;
    return out;
  });

  const spec: AssemblySpec = {
    ...raw,
    ...(parameters ? { parameters } : {}),
    ...(derived ? { derived } : {}),
    ...(relations ? { relations } : {}),
    ...(components ? { components } : {}),
    ...(guides ? { guides } : {}),
  };
  return { spec, errors };
}
