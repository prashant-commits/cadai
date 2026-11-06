import type { AssemblySpec } from './assembly-spec';
import type { SpecViolation } from './spec-audit';
import { resolveSpec } from './spec-expr';

const KNOWN_FUNCTIONS = new Set(['min', 'max', 'sqrt', 'abs', 'sin', 'cos', 'tan']);

/**
 * Extracts identifiers referenced in an arithmetic expression string.
 * Function calls (e.g. min, max) are ignored; arguments and variable names are returned.
 */
export function extractIdentifiers(expr: string): Set<string> {
  const ids = new Set<string>();
  if (!expr || typeof expr !== 'string') return ids;
  const regex = /([a-zA-Z][a-zA-Z0-9_]*)\s*(\()?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(expr)) !== null) {
    const name = match[1].toLowerCase();
    const isCall = Boolean(match[2]);
    if (isCall && KNOWN_FUNCTIONS.has(name)) {
      continue;
    }
    ids.add(name);
  }
  return ids;
}

/**
 * Collects all expression strings from components and guides.
 * Looks in both raw fields (which may contain strings before resolution)
 * and the `expr` field (populated by resolveSpec).
 */
export function collectExprStrings(spec: AssemblySpec | null, resolvedSpec?: AssemblySpec | null): string[] {
  const strings: string[] = [];

  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim() !== '') {
      strings.push(v);
    }
  };

  const addArray = (arr: unknown) => {
    if (Array.isArray(arr)) {
      for (const item of arr) add(item);
    }
  };

  /** Profile outlines and inner outlines: arrays of [u, v] vertices, plus their kept expression sources. */
  const addOutlines = (shape: { points?: unknown; holes?: unknown } | undefined, outline: unknown, outlineHoles: unknown) => {
    for (const pts of [shape?.points, outline, ...(Array.isArray(shape?.holes) ? shape.holes : []), ...(Array.isArray(outlineHoles) ? outlineHoles : [])]) {
      if (Array.isArray(pts)) for (const pt of pts) addArray(pt);
    }
  };

  const scan = (s: AssemblySpec | null | undefined) => {
    if (!s) return;
    for (const c of s.components ?? []) {
      addArray(c.localExtents);
      addArray(c.position);
      addArray(c.rotation);
      if (c.shape) {
        add(c.shape.innerD);
        add(c.shape.wall);
      }
      addOutlines(c.shape, c.expr?.outline, c.expr?.outlineHoles);
      if (c.holes) {
        for (const h of c.holes) {
          add(h.d);
          addArray(h.at);
          add(h.depth);
        }
      }
      if (c.expr) {
        addArray(c.expr.localExtents);
        addArray(c.expr.position);
        addArray(c.expr.rotation);
        add(c.expr.innerD);
        add(c.expr.wall);
        if (c.expr.holes) {
          for (const he of c.expr.holes) {
            add(he.d);
            addArray(he.at);
            add(he.depth);
          }
        }
      }
    }

    for (const g of s.guides ?? []) {
      addArray(g.localExtents);
      addArray(g.position);
      addArray(g.rotation);
      if (g.points) {
        for (const pt of g.points) {
          addArray(pt);
        }
      }
      if (g.shape) {
        add(g.shape.innerD);
        add(g.shape.wall);
      }
      addOutlines(g.shape, g.expr?.outline, g.expr?.outlineHoles);
      if (g.expr) {
        addArray(g.expr.localExtents);
        addArray(g.expr.position);
        addArray(g.expr.rotation);
        if (g.expr.points) {
          for (const pt of g.expr.points) {
            addArray(pt);
          }
        }
        add(g.expr.innerD);
        add(g.expr.wall);
      }
    }
  };

  scan(spec);
  if (resolvedSpec && resolvedSpec !== spec) {
    scan(resolvedSpec);
  }

  return strings;
}

/**
 * Lints for declared parameters that are not reached by any component or guide expression.
 * Transitive reachability through `derived` is followed.
 * Relations do not count as use.
 * Literal specs (no parameters) produce nothing.
 * Skipped when expression resolution has errors (L5).
 */
export function lintDeadParameters(rawSpec: AssemblySpec | null, resolvedSpec?: AssemblySpec | null): SpecViolation[] {
  if (!rawSpec) return [];
  const declaredParams = rawSpec.parameters ?? [];
  if (declaredParams.length === 0) return [];

  // L5: skip lint when resolution has errors (e.g. typos like "wdith" shouldn't report "width" dead)
  const res = resolveSpec(rawSpec);
  if (res.errors.length > 0) return [];
  const resolved = resolvedSpec ?? res.spec;

  const derivedMap = new Map<string, string>();
  for (const d of rawSpec.derived ?? []) {
    if (d.name && d.expr) {
      derivedMap.set(d.name.toLowerCase(), d.expr);
    }
  }

  const exprStrings = collectExprStrings(rawSpec, resolved);
  const reached = new Set<string>();

  for (const expr of exprStrings) {
    for (const id of extractIdentifiers(expr)) {
      reached.add(id);
    }
  }

  const queue = Array.from(reached);
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const derivedExpr = derivedMap.get(curr);
    if (derivedExpr) {
      for (const id of extractIdentifiers(derivedExpr)) {
        if (!visited.has(id)) {
          visited.add(id);
          queue.push(id);
        }
      }
    }
  }

  const violations: SpecViolation[] = [];
  for (const param of declaredParams) {
    const lower = param.name.toLowerCase();
    if (!visited.has(lower) && !visited.has(param.name)) {
      violations.push({
        kind: 'coherence',
        field: `parameters.${param.name}`,
        expected: 'used in a component or guide expression',
        measured: 'unused',
        severity: 'error',
        message: `Parameter "${param.name}" is declared but never reached by any component or guide expression. Use it in a component expression or remove it.`,
      });
    }
  }

  return violations;
}

/**
 * Spec-gate audit for dead parameters.
 * Runs only at the spec stage (prior to code generation), returning errors for any
 * declared parameter that is never reached by any component or guide expression.
 * Skipped if expression resolution produces errors.
 */
export function auditSpecParameters(rawSpec: AssemblySpec | null): SpecViolation[] {
  return lintDeadParameters(rawSpec);
}
