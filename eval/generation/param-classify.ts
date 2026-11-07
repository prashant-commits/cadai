/**
 * Which numeric parameters of a final script can fairly be called "dead".
 *
 * Two kinds are left out of the live-parameter ratio, for both kernels:
 *  - fixed: the range has min == max (the user or physics pins the value);
 *  - guide: nothing that feeds geometry reads the parameter. A guide-only
 *    parameter (a phone envelope, say) is declared but only drawn as a guide,
 *    so it never reaches a component, hole, profile, placement or derived value
 *    that geometry uses.
 *
 * "Reads" is decided on the script, the one artifact both kernels and the
 * rescore share: the parameter block (a run of `name = expr` lines before the
 * first def/module/section header) is a dependency graph, and everything
 * outside it is geometry code. A parameter is a guide when no identifier in
 * geometry code reaches it, directly or through derived assignments.
 */
import { parseParams } from '@/lib/design/parse-params';
import { detectLanguage } from '@/lib/brep/language';

export interface ParamClasses {
  /** Numeric, non-`$` parameters parsed from the script. */
  total: string[];
  /** Eligible for the live ratio: not fixed, not guide-only. */
  eligible: Array<{ name: string; value: number; min?: number; max?: number; step?: number }>;
  fixed: string[];
  guide: string[];
}

const REGION_END = /^(def |module |function |class |# ----|\/\/ ----|union\s*\(|difference\s*\(|intersection\s*\()/;
const IDENT = /[A-Za-z_$][\w$]*/g;

function stripComments(code: string, python: boolean): string[] {
  const text = python ? code : code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return text.split(/\r?\n/).map((line) => {
    const noStrings = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const cut = noStrings.indexOf(python ? '#' : '//');
    return cut < 0 ? noStrings : noStrings.slice(0, cut);
  });
}

const identsOf = (text: string): string[] => text.match(IDENT) ?? [];

export function classifyParams(code: string): ParamClasses {
  const numeric = parseParams(code).filter((p) => typeof p.value === 'number' && !p.name.startsWith('$'));
  const fixed = numeric.filter((p) => p.min !== undefined && p.min === p.max).map((p) => p.name);

  const python = detectLanguage(code) === 'build123d';
  const lines = stripComments(code, python);
  const first = numeric.length ? Math.min(...numeric.map((p) => p.line)) - 1 : -1;
  let end = lines.length;
  if (first >= 0) {
    const raw = code.split(/\r?\n/);
    for (let i = first + 1; i < raw.length; i++) {
      if (REGION_END.test(raw[i])) { end = i; break; }
    }
  }

  // Dependency graph over the parameter block; everything else is geometry code.
  const nodes = new Map<string, string>();
  const rootLines: string[] = [];
  let last: string | null = null;
  lines.forEach((line, i) => {
    const inRegion = first >= 0 && i >= first && i < end;
    if (!inRegion) { rootLines.push(line); return; }
    const m = (python ? /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+?)\s*$/ : /^\s*([A-Za-z_$][\w$]*)\s*=(?!=)\s*(.+?);?\s*$/).exec(line);
    if (m) {
      nodes.set(m[1], m[2]);
      last = m[1];
    } else if (last && /^\s/.test(line)) {
      nodes.set(last, `${nodes.get(last)} ${line}`);
    }
  });

  const reached = new Set<string>();
  const queue = identsOf(rootLines.join('\n'));
  while (queue.length) {
    const name = queue.pop()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const rhs = nodes.get(name);
    if (rhs) queue.push(...identsOf(rhs));
  }

  const inRegion = new Set(numeric.filter((p) => p.line - 1 >= first && p.line - 1 < end).map((p) => p.name));
  const guide = numeric.filter((p) => !fixed.includes(p.name) && inRegion.has(p.name) && !reached.has(p.name)).map((p) => p.name);
  const excluded = new Set([...fixed, ...guide]);
  return {
    total: numeric.map((p) => p.name),
    eligible: numeric.filter((p) => !excluded.has(p.name)).map((p) => ({
      name: p.name, value: p.value as number, min: p.min, max: p.max, step: p.step,
    })),
    fixed,
    guide,
  };
}
