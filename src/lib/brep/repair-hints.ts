import { EXTRUDE_FORMS } from './extrude-forms';

/**
 * One fix line for a build123d error the model keeps repeating. The table is the whole feature:
 * the first row whose pattern matches the error text adds its `fix` to the repair message.
 *
 * Evidence (saved B-rep runs, eval/results/matrix-final1 and matrix-night1): "A face or sketch must
 * be provided" is the only build123d traceback in them (phone_stand and desk_cup_holder, three repair
 * attempts each that kept the mistake). The other two rows are the error classes a body hits next, from
 * the geometry-runner reviews (an invented keyword such as `axis=`; a name the body never defined).
 */
export interface RepairHint {
  /** Matches the exception line (never the echoed source). Capture groups feed `fix`. */
  pattern: RegExp;
  fix: (match: RegExpExecArray) => string;
}

/** Algebra-mode forms, shared with the prompt and the rejection reason. */
const ALGEBRA_EXTRUDE = EXTRUDE_FORMS;

/**
 * Invented keywords, per failing call, with the build123d spelling that does the job. A keyword
 * only gets its advice for the calls it was written for: `Text(height=)` is not an extrude error.
 */
const KEYWORD_FIXES: { callees: string[]; keyword: string; fix: string }[] = [
  { callees: ['Cylinder', 'Cone'], keyword: 'axis', fix: 'Cylinder runs along +Z and has no axis=; point it with rotation=(0, 90, 0) for X or rotation=(-90, 0, 0) for Y' },
  { callees: ['Cylinder', 'Cone', 'Sphere'], keyword: 'diameter', fix: 'there is no diameter=; pass the radius (Cylinder(radius, height), Sphere(radius))' },
  { callees: ['extrude'], keyword: 'height', fix: 'extrude takes amount=, not height=' },
  { callees: ['extrude'], keyword: 'distance', fix: 'extrude takes amount=, not distance=' },
  { callees: ['Cylinder', 'Cone'], keyword: 'height', fix: 'the height is positional: Cylinder(radius, height), Cone(bottom_radius, top_radius, height)' },
  { callees: ['Box'], keyword: 'length', fix: 'Box takes x, y, z sizes positionally; there is no length=' },
  { callees: ['Box'], keyword: 'width', fix: 'Box takes x, y, z sizes positionally; there is no width=' },
  { callees: ['Box'], keyword: 'depth', fix: 'Box takes x, y, z sizes positionally; there is no depth=' },
  { callees: ['Cylinder', 'Cone', 'Sphere'], keyword: 'radius', fix: 'pass the radius as the first positional argument: Cylinder(radius, height)' },
];

export const REPAIR_HINTS: RepairHint[] = [
  {
    pattern: /^(?:\w+\.)*ValueError: A face or sketch must be provided/,
    fix: () =>
      `extrude and revolve outside a builder take the profile as their first argument; a with BuildSketch block does not feed them. Write ${ALGEBRA_EXTRUDE}, and never use with BuildPart, BuildSketch or BuildLine.`,
  },
  {
    // `TypeError: Cylinder.__init__() got an unexpected keyword argument 'axis'` or `TypeError: extrude() got ...`
    pattern: /^TypeError: (?:(\w+)\.)?(\w+)\(\) got an unexpected keyword argument '(\w+)'/,
    fix: (m) => {
      const callee = m[1] && m[2] === '__init__' ? m[1] : m[2];
      const row = KEYWORD_FIXES.find((r) => r.keyword === m[3] && r.callees.includes(callee));
      return row ? `${row.fix}.` : `${callee} has no keyword ${m[3]}=; use only the keywords on the cheat sheet.`;
    },
  },
  {
    pattern: /^NameError: name '(\w+)' is not defined/,
    fix: (m) =>
      `${m[1]} is not defined in this body. Use only the parameter and derived names listed in the prompt, build123d names, and variables you assign yourself first; never import anything.`,
  },
];

/** The exception line of an error text: the last line that names an exception, else the last line. */
function exceptionLine(error: string): string {
  const lines = error.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(?:[\w.]+\.)?[A-Z]\w*(?:Error|Exception|NotDone|Failure):/.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1] ?? '';
}

/** The fix line for an error text, or null when no row matches. Echoed source lines never match. */
export function repairHint(error: string): string | null {
  const line = exceptionLine(error);
  for (const row of REPAIR_HINTS) {
    const match = row.pattern.exec(line);
    if (match) return row.fix(match);
  }
  return null;
}
