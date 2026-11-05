import type { AssemblySpec } from './assembly-spec';

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

const NAME_START = /[a-z]/;
const NAME_PART = /[a-z0-9_]/;
const DIGIT = /[0-9]/;

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

  for (const p of raw.parameters ?? []) scope[p.name] = p.value;
  for (const d of raw.derived ?? []) {
    try {
      const v = evalExpr(d.expr, scope);
      if (Number.isFinite(v)) scope[d.name] = v;
      else errors.push(`derived "${d.name}" = "${d.expr}" is not a finite number`);
    } catch (e) {
      errors.push(`derived "${d.name}" = "${d.expr}": ${(e as Error).message}`);
    }
  }

  /** Number in, number out; string in, evaluated. `where` names the field in errors. */
  const num = (v: unknown, where: string): { value: number; expr: string | null } => {
    if (typeof v !== 'string') return { value: v as number, expr: null };
    try {
      const n = evalExpr(v, scope);
      if (Number.isFinite(n)) return { value: n, expr: v };
      errors.push(`${where} = "${v}" is not a finite number`);
    } catch (e) {
      errors.push(`${where} = "${v}": ${(e as Error).message}`);
    }
    return { value: 0, expr: v };
  };

  const vec = (v: unknown, where: string): { value: number[]; expr: (string | null)[] | undefined } => {
    const arr = v as unknown[];
    const parts = arr.map((x, i) => num(x, `${where}[${i}]`));
    return { value: parts.map((x) => x.value), expr: parts.some((x) => x.expr !== null) ? parts.map((x) => x.expr) : undefined };
  };

  const components = raw.components?.map((c) => {
    const w = `component "${c.name}"`;
    const out: Component = { ...c };
    const expr: ComponentExpr = { ...(c.expr ?? {}) };

    for (const f of ['localExtents', 'position', 'rotation'] as const) {
      if (c[f] === undefined) continue;
      const r = vec(c[f], `${w} ${f}`);
      out[f] = r.value;
      if (r.expr) expr[f] = r.expr;
    }

    if (c.shape) {
      const shape = { ...c.shape };
      for (const f of ['innerD', 'wall'] as const) {
        if (shape[f] === undefined) continue;
        const r = num(shape[f], `${w} shape.${f}`);
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
        const d = num(h.d, `${hw}.d`);
        hole.d = d.value;
        if (d.expr !== null) he.d = d.expr;
        const at = vec(h.at, `${hw}.at`);
        hole.at = at.value;
        if (at.expr) he.at = at.expr;
        if (h.depth !== undefined) {
          const dp = num(h.depth, `${hw}.depth`);
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

  const spec: AssemblySpec = components ? { ...raw, components } : { ...raw };
  return { spec, errors };
}
