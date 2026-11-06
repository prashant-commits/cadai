import { tokenize, type Token } from '../agent/spec-expr';

/**
 * Spec expression -> Python expression, by re-printing a parse tree.
 *
 * The spec grammar is numbers, names, unary minus, + - * /, parentheses and the
 * calls min, max, abs, sqrt, sin, cos, tan. The text is never copied into the
 * script: it is parsed with the spec's own tokenizer and every node is printed
 * again, so no newline, semicolon, import or other Python syntax can get
 * through. Anything outside the grammar, an unknown name, or a function used
 * with the wrong argument count returns null.
 *
 * sin, cos and tan take degrees in the spec; they print as the script's
 * `_sind`/`_cosd`/`_tand` helpers.
 */

type Node =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'neg'; x: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Node; r: Node }
  | { t: 'call'; fn: string; args: Node[] };

const FUNCS: Record<string, { py: string; min: number; max: number }> = {
  min: { py: 'min', min: 1, max: Infinity },
  max: { py: 'max', min: 1, max: Infinity },
  abs: { py: 'abs', min: 1, max: 1 },
  sqrt: { py: 'sqrt', min: 1, max: 1 },
  sin: { py: '_sind', min: 1, max: 1 },
  cos: { py: '_cosd', min: 1, max: 1 },
  tan: { py: '_tand', min: 1, max: 1 },
};

/** `lookup` returns the Python identifier for a declared spec name, else undefined. */
export type NameLookup = (name: string) => string | undefined;

export function pyExpr(src: string, lookup: NameLookup): string | null {
  try {
    const node = parse(src);
    return print(node, lookup, 0);
  } catch {
    return null;
  }
}

function parse(src: string): Node {
  const tokens: Token[] = tokenize(src);
  let p = 0;
  const isOp = (v: string) => tokens[p].t === 'op' && (tokens[p] as { v: string }).v === v;
  const fail = (): never => {
    throw new Error('not a spec expression');
  };

  const expr = (): Node => {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[p++] as { v: '+' | '-' }).v;
      left = { t: 'bin', op, l: left, r: term() };
    }
    return left;
  };
  const term = (): Node => {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = (tokens[p++] as { v: '*' | '/' }).v;
      left = { t: 'bin', op, l: left, r: unary() };
    }
    return left;
  };
  const unary = (): Node => {
    if (isOp('-')) {
      p++;
      return { t: 'neg', x: unary() };
    }
    return atom();
  };
  const atom = (): Node => {
    const tok = tokens[p];
    if (tok.t === 'num') {
      p++;
      if (!Number.isFinite(tok.v)) fail();
      return { t: 'num', v: tok.v };
    }
    if (tok.t === 'name') {
      p++;
      if (!isOp('(')) return { t: 'name', v: tok.v };
      const f = Object.hasOwn(FUNCS, tok.v) ? FUNCS[tok.v] : undefined;
      if (!f) fail();
      p++;
      const args = [expr()];
      while (isOp(',')) {
        p++;
        args.push(expr());
      }
      if (!isOp(')')) fail();
      p++;
      if (args.length < f!.min || args.length > f!.max) fail();
      return { t: 'call', fn: tok.v, args };
    }
    if (isOp('(')) {
      p++;
      const inner = expr();
      if (!isOp(')')) fail();
      p++;
      return inner;
    }
    return fail();
  };

  const root = expr();
  if (tokens[p].t !== 'end') fail();
  return root;
}

const PREC = { add: 1, mul: 2, neg: 3, atom: 4 } as const;

function print(node: Node, lookup: NameLookup, required: number): string {
  let text: string;
  let prec: number;
  switch (node.t) {
    case 'num':
      text = String(node.v);
      prec = PREC.atom;
      break;
    case 'name': {
      const py = lookup(node.v);
      if (py === undefined) throw new Error(`unknown name ${node.v}`);
      text = py;
      prec = PREC.atom;
      break;
    }
    case 'neg':
      text = `-${print(node.x, lookup, PREC.neg)}`;
      prec = PREC.neg;
      break;
    case 'bin': {
      prec = node.op === '+' || node.op === '-' ? PREC.add : PREC.mul;
      // Left-associative: the right operand needs strictly higher precedence.
      text = `${print(node.l, lookup, prec)} ${node.op} ${print(node.r, lookup, prec + 1)}`;
      break;
    }
    case 'call': {
      const args = node.args.map((a) => print(a, lookup, 0)).join(', ');
      text = `${FUNCS[node.fn].py}(${args})`;
      prec = PREC.atom;
      break;
    }
  }
  return prec < required ? `(${text})` : text;
}
