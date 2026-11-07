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
  /** Matches the last lines of the traceback. Capture groups feed `fix`. */
  pattern: RegExp;
  fix: (match: RegExpExecArray) => string;
}

const ALGEBRA_EXTRUDE =
  'extrude(Plane.YZ * Polygon(*pts, align=None), amount=w) or extrude(make_face(Polyline(*pts, close=True)), amount=w)';

/** Keywords a body invents, and the build123d spelling that does the job. */
const KEYWORD_FIXES: Record<string, string> = {
  axis: 'Cylinder runs along +Z and has no axis=; point it with rotation=(0, 90, 0) for X or rotation=(-90, 0, 0) for Y',
  diameter: 'there is no diameter=; pass the radius (Cylinder(radius, height), Sphere(radius))',
  height: 'extrude takes amount=, not height=; Cylinder and Cone take the height as the second or third positional argument',
  distance: 'extrude takes amount=, not distance=',
  length: 'Box takes x, y, z sizes positionally; there is no length=',
  depth: 'Box takes x, y, z sizes positionally; there is no depth=',
  width: 'Box takes x, y, z sizes positionally; there is no width=',
  radius: 'pass the radius as the first positional argument: Cylinder(radius, height)',
};

export const REPAIR_HINTS: RepairHint[] = [
  {
    pattern: /A face or sketch must be provided/,
    fix: () =>
      `extrude and revolve outside a builder take the profile as their first argument; a with BuildSketch block does not feed them. Write ${ALGEBRA_EXTRUDE}, and never use with BuildPart, BuildSketch or BuildLine.`,
  },
  {
    pattern: /got an unexpected keyword argument '(\w+)'/,
    fix: (m) =>
      `${KEYWORD_FIXES[m[1]] ?? `there is no keyword ${m[1]}=; use only the keywords on the cheat sheet`}.`,
  },
  {
    pattern: /NameError: name '(\w+)' is not defined/,
    fix: (m) =>
      `${m[1]} is not defined in this body. Use only the parameter and derived names listed in the prompt, build123d names, and variables you assign yourself first; never import anything.`,
  },
];

/** The fix line for an error text, or null when no row matches. */
export function repairHint(error: string): string | null {
  for (const row of REPAIR_HINTS) {
    const match = row.pattern.exec(error);
    if (match) return row.fix(match);
  }
  return null;
}
