import type { AssemblySpec } from '../agent/assembly-spec';
import { BUILD123D_NAMES, MATH_NAMES, PYTHON_BUILTINS, PYTHON_KEYWORDS } from './python-names';
import { pyExpr, type NameLookup } from './py-expr';

/**
 * Python names for the spec's parameters, derived values and components.
 *
 * Spec names are lowercase snake_case, which is not enough to be safe in the
 * script: `class` is a keyword, `extrude` is a build123d function the profile
 * blockout calls, `radians` and `min` are used by the prelude and by
 * expressions. A name that is not a plain identifier, or that the script uses
 * or inherits, is prefixed (`p_extrude`) and every reference is mapped.
 */

const PLAIN = /^[a-z][a-z0-9_]*$/;

/** Names the script's own code, its prelude or a model body may rely on. */
export function isReservedName(name: string): boolean {
  return PYTHON_KEYWORDS.has(name) || PYTHON_BUILTINS.has(name) || MATH_NAMES.has(name) || BUILD123D_NAMES.has(name);
}

/** A Python identifier for `name` that is not reserved and not in `taken`; adds it to `taken`. */
export function safeIdentifier(name: string, taken: Set<string>): string {
  let candidate = name;
  if (!PLAIN.test(candidate) || isReservedName(candidate) || taken.has(candidate)) {
    const body = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '') || 'x';
    candidate = `p_${body}`;
    for (let n = 2; isReservedName(candidate) || taken.has(candidate); n++) candidate = `p_${body}_${n}`;
  }
  taken.add(candidate);
  return candidate;
}

/** How a term in a component field turns into Python: the resolved number, or a re-printed expression. */
export interface TermContext {
  term(expr: string | null | undefined, value: number): number | string;
}

/** Without a spec: a name is accepted as written when it is a plain, unreserved identifier. */
export const STANDALONE_CONTEXT: TermContext = makeContext((name) => (PLAIN.test(name) && !isReservedName(name) ? name : undefined));

export function makeContext(lookup: NameLookup): TermContext {
  return {
    term(expr, value) {
      if (!expr) return value;
      return pyExpr(expr, lookup) ?? value;
    },
  };
}

export interface SpecNames {
  /** Python identifier for each declared parameter or derived name. */
  map: Map<string, string>;
  /** Every identifier the script binds at top level (so generated names stay clear of them). */
  taken: Set<string>;
  ctx: TermContext;
  /** Derived values whose expression is not a valid spec expression (emitted as 0). */
  badDerived: string[];
}

export function specNames(spec: AssemblySpec, fmt: (n: number) => string): {
  names: SpecNames;
  parameterLines: string[];
} {
  const map = new Map<string, string>();
  const taken = new Set<string>();
  const lookup: NameLookup = (name) => map.get(name);
  const lines: string[] = [];
  const badDerived: string[] = [];

  for (const p of spec.parameters ?? []) {
    const py = map.get(p.name) ?? safeIdentifier(p.name, taken);
    map.set(p.name, py);
    const step = p.step ?? (p.unit === 'mm' ? 0.1 : 1);
    const desc = comment(p.description);
    lines.push(`${py} = ${fmt(p.value)}  # [${fmt(p.min)}:${fmt(step)}:${fmt(p.max)}]${desc ? ` ${desc}` : ''}`);
  }
  for (const d of spec.derived ?? []) {
    const printed = pyExpr(d.expr, lookup);
    const py = map.get(d.name) ?? safeIdentifier(d.name, taken);
    map.set(d.name, py);
    if (printed === null) {
      badDerived.push(d.name);
      lines.push(`${py} = 0  # derived expression of ${py} is not a valid spec expression`);
    } else {
      lines.push(`${py} = ${printed}`);
    }
  }
  const names: SpecNames = {
    map,
    taken,
    ctx: makeContext(lookup),
    badDerived,
  };
  return { names, parameterLines: lines };
}

/** One line of comment text: control characters and line breaks become spaces. */
export function comment(text: string | undefined): string {
  return (text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}
