import { AssemblySpec } from '../agent/assembly-spec';
import type { ModuleFrame } from '../engine/module-frames';
import { buildPlacementComponents, PlacementComponent, PlacementReport } from './placement-report';
import { isZeroVec, Vec3 } from './placement-geometry';
import { gussetScad, gussetsFor } from './gussets';
import { matingCuts } from './mating-cuts';
import { shapeScad } from '../spec-sheet/blockout-scad';

/**
 * Deterministic assembly placement.
 *
 * Coordinate-frame confusion and CSG solid/void tracking are where language
 * models fail hardest at CAD - not at describing a part, but at saying where it
 * goes. Until now every `translate()` and `rotate()` in a generated script was
 * LLM-authored tokens, and the only check on them was a bounding-box comparison
 * that a wrongly-placed part passes as long as the overall envelope is right.
 *
 * The split here: the model writes each component as a `module` in its OWN
 * local frame, sitting at the origin, which it is good at. TypeScript reads the
 * approved Assembly Spec and emits every placement transform, which it cannot
 * get wrong.
 *
 * Composition is strictly opt-in and fails safe. If the spec declares no
 * placements, or the code does not define the modules the spec names, or the
 * model wrote its own top-level assembly anyway, the code is returned exactly
 * as authored. A generated part is never worse off for this running.
 */

export interface TopLevelAnalysis {
  /** Names of `module <name>(...)` declared at depth 0. */
  moduleNames: string[];
  /**
   * True when a statement at depth 0 actually instantiates geometry (a call, a
   * transform, a CSG block) rather than declaring or assigning. Its presence
   * means the model wrote its own assembly and we must not add a second one.
   */
  hasTopLevelGeometry: boolean;
}

export type ComposeSkipReason = 'no_spec' | 'missing_modules';

export interface ComposeResult {
  code: string;
  composed: boolean;
  /** Why composition was declined; useful in traces when a run is not using it. */
  reason?: ComposeSkipReason;
  /** Spec components whose module the code never defined. */
  missing?: string[];
  report: PlacementReport | null;
}

const GENERATED_HEADER = '// ---- Assembly placement (generated from the approved Assembly Spec) ----';

/**
 * Scans OpenSCAD for its top-level shape, ignoring anything inside strings,
 * line comments or block comments.
 */
export function analyzeTopLevel(code: string): TopLevelAnalysis {
  const moduleNames: string[] = [];
  let hasTopLevelGeometry = false;

  let depth = 0;
  let inBlockComment = false;
  // Text of the current depth-0 statement, accumulated until its terminator.
  let statement = '';

  const flush = () => {
    const s = statement.trim();
    statement = '';
    if (!s) return;

    if (/^module\s+([A-Za-z0-9_$]+)/.test(s)) {
      moduleNames.push(RegExp.$1);
      return;
    }
    // Declarations and directives are not geometry.
    if (/^function\s+[A-Za-z0-9_$]+/.test(s)) return;
    if (/^(include|use)\s*</.test(s)) return;
    // An assignment: `name = expr` with `=` not part of ==, <=, >=, !=
    if (/^[A-Za-z0-9_$]+\s*=[^=]/.test(s)) return;

    // Anything else at depth 0 that survived is a call, a transform or a CSG
    // block - i.e. the model placed geometry itself.
    hasTopLevelGeometry = true;
  };

  const lines = code.split(/\r?\n/);
  for (const line of lines) {
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '/') break; // rest of line is a comment

      if (ch === '"') {
        // Consume the string literal wholesale so braces inside cannot shift depth.
        let j = i + 1;
        while (j < line.length) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === '"') break;
          j++;
        }
        if (depth === 0) statement += line.slice(i, Math.min(j + 1, line.length));
        i = j + 1;
        continue;
      }

      if (ch === '{') {
        if (depth === 0) {
          // A depth-0 `{` opens a module body or a bare geometry block; either
          // way the statement's identity is already decided by its head.
          flushHeadBeforeBrace();
        }
        depth++;
        i++;
        continue;
      }

      if (ch === '}') {
        depth = Math.max(0, depth - 1);
        i++;
        continue;
      }

      if (ch === ';') {
        if (depth === 0) flush();
        i++;
        continue;
      }

      if (depth === 0) statement += ch;
      i++;
    }

    if (depth === 0 && statement.trim()) statement += ' ';
  }

  // A trailing statement with no terminator (rare, but a truncated draft can
  // produce one) still counts.
  flush();

  function flushHeadBeforeBrace() {
    const s = statement.trim();
    statement = '';
    if (!s) {
      // A bare `{ ... }` block at top level is geometry grouping.
      hasTopLevelGeometry = true;
      return;
    }
    if (/^module\s+([A-Za-z0-9_$]+)/.test(s)) {
      moduleNames.push(RegExp.$1);
      return;
    }
    if (/^function\s+[A-Za-z0-9_$]+/.test(s)) return;
    if (/^if\s*\(/.test(s) || /^for\s*\(/.test(s)) {
      // Control flow at top level wraps geometry in practice.
      hasTopLevelGeometry = true;
      return;
    }
    hasTopLevelGeometry = true;
  }

  return { moduleNames, hasTopLevelGeometry };
}

/**
 * Removes every depth-0 statement that instantiates geometry - bare calls,
 * transformed calls, CSG blocks, for/if - and keeps declarations (module,
 * function, assignment, include/use) with the comments that precede them.
 *
 * The composer needs this to enforce the placement contract instead of
 * declining when the Drafter placed parts itself; the interference probe
 * needs it because OpenSCAD implicitly unions top-level objects, so any
 * leftover top-level geometry is unioned INTO the probe's intersection().
 */
export function stripTopLevelGeometry(code: string): { code: string; removed: number } {
  const out: string[] = [];
  let removed = 0;
  let depth = 0;
  let inBlockComment = false;
  let stmt = '';
  let keep: boolean | null = null;

  const isDeclaration = (head: string): boolean =>
    head === '' ||
    /^(module|function)\s+[A-Za-z0-9_$]+/.test(head) ||
    /^(include|use)\s*</.test(head) ||
    /^[A-Za-z0-9_$]+\s*=[^=]/.test(head);

  // The statement head with comments removed, so "// note\nfoo();" is judged by "foo();".
  const headOf = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();

  const decide = () => {
    if (keep === null) keep = isDeclaration(headOf(stmt));
  };
  const flush = () => {
    decide();
    if (keep) out.push(stmt);
    else removed++;
    stmt = '';
    keep = null;
  };

  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (inBlockComment) {
      stmt += ch;
      if (ch === '*' && next === '/') {
        stmt += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      stmt += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const seg = code.slice(i, end === -1 ? code.length : end);
      stmt += seg;
      i += seg.length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') {
        if (code[j] === '\\') j++;
        j++;
      }
      stmt += code.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) decide();
      depth++;
      stmt += ch;
      i++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      stmt += ch;
      i++;
      if (depth === 0) flush();
      continue;
    }
    if (ch === ';' && depth === 0) {
      stmt += ch;
      i++;
      flush();
      continue;
    }
    stmt += ch;
    i++;
  }
  if (stmt.trim()) flush();
  else out.push(stmt);

  return { code: out.join('').replace(/\n{3,}/g, '\n\n'), removed };
}

/** True when the code carries a placement block generated by composeAssembly. */
export function hasGeneratedAssembly(code: string): boolean {
  return code.includes(GENERATED_HEADER);
}

/** Trims float noise without dropping real precision. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

function vec(v: Vec3): string {
  return `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`;
}

const AXES = ['x', 'y', 'z'] as const;

/**
 * `translate(P) rotate(R) translate(C) name();` with P given per axis (literal
 * or parameter name). A caller may pass `body` (a wrapper call or an inline
 * union) that already contains the origin correction; the correction is then
 * not applied again here.
 */
function placementCall(c: PlacementComponent, posExpr: [string, string, string], body?: string): string {
  let call = body ?? `${c.name}();`;
  if (!body && !isZeroVec(c.correction)) call = `translate(${vec(c.correction)}) ${call}`;
  if (!isZeroVec(c.rotation)) call = `rotate(${vec(c.rotation)}) ${call}`;
  if (posExpr.some((e) => e !== '0')) call = `translate([${posExpr.join(', ')}]) ${call}`;
  return call;
}

/**
 * The lines of a union body for a component with generated gussets: the
 * module, origin-corrected, then every gusset in the component's frame.
 */
function bracedBodyLines(
  c: PlacementComponent,
  gussets: ReturnType<typeof gussetsFor>,
  indent: string
): string[] {
  const lines = [`${indent}${isZeroVec(c.correction) ? '' : `translate(${vec(c.correction)}) `}${c.name}();`];
  for (const g of gussets) {
    lines.push(`${indent}// gusset: ${g.location.replace(/\s+/g, ' ').trim()}`);
    lines.push(...gussetScad(g.gusset, indent));
  }
  return lines;
}

/**
 * Enforces the placement contract. Model-written top-level geometry is
 * stripped, every component is placed from the spec, and each module's
 * measured min corner is corrected so its origin lands where the Architect
 * meant. Only two things stop it: no spec, or a spec component with no module
 * (then the code is returned exactly as authored, since stripping it would
 * leave nothing to render).
 *
 * `rotate` is emitted inside `translate`, so a component is rotated about its
 * own origin and then moved into place - the reading an engineer expects from
 * "position" and "rotation" on a part.
 *
 * Non-zero coordinates are emitted as named parameters with the Architect's
 * positionNote as the comment, so the design panel can expose them and a later
 * parametric rewrite is a one-token edit. The block is regenerated from the
 * spec on every compose, so an edit to these parameters is a preview, and the
 * spec stays the source of truth.
 */
export function composeAssembly(code: string, spec: AssemblySpec | null, frames: ModuleFrame[] = []): ComposeResult {
  if (!spec?.components?.length) {
    return { code, composed: false, reason: 'no_spec', report: null };
  }

  const analysis = analyzeTopLevel(code);
  const defined = new Set(analysis.moduleNames);
  const missing = spec.components.map((c) => c.name).filter((n) => !defined.has(n));
  if (missing.length > 0) {
    return { code, composed: false, reason: 'missing_modules', missing, report: null };
  }

  const stripped = stripTopLevelGeometry(code);
  const components = buildPlacementComponents(spec, frames, true).map((c) => ({
    ...c,
    gussets: gussetsFor(spec, c.name).reduce((n, g) => n + g.gusset.at.length, 0),
  }));
  const noteFor = new Map((spec.components ?? []).map((c) => [c.name, c.positionNote?.replace(/\s+/g, ' ').trim()]));

  const params: string[] = [];
  const wrappers: string[] = [];
  const calls: string[] = [];
  const reportNotes: string[] = [];

  const posExprs = new Map<string, [string, string, string]>();
  for (const c of components) {
    const note = noteFor.get(c.name);
    let noteUsed = false;
    const posExpr = AXES.map((axis, i) => {
      if (c.position[i] === 0) return '0';
      const pname = `${c.name}_pos_${axis}`;
      params.push(`${pname} = ${fmt(c.position[i])};${note && !noteUsed ? `   // ${note}` : ''}`);
      noteUsed = true;
      return pname;
    }) as [string, string, string];
    posExprs.set(c.name, posExpr);
  }

  const allCuts = matingCuts(spec, (a, b) => {
    reportNotes.push(`skipped mutual cut cycle between ${a} and ${b}`);
  });

  for (const c of components) {
    const note = noteFor.get(c.name);
    const posExpr = posExprs.get(c.name)!;

    if (note && !posExpr.some((p) => p !== '0')) calls.push(`    // ${c.name}: ${note}`);

    // Gussets the spec prescribes are generated here and unioned onto the
    // module in a wrapper, so the Drafter never has to place one.
    const gussets = gussetsFor(spec, c.name);
    let line: string;
    let wrapperCall: string | undefined;
    if (gussets.length > 0) {
      const wrapper = `${c.name}__braced`;
      wrappers.push(
        `module ${wrapper}() {   // ${c.name} + ${c.gussets} gusset(s) generated from stressPoints`,
        '    union() {',
        ...bracedBodyLines(c, gussets, '        '),
        '    }',
        '}'
      );
      wrapperCall = `${wrapper}();`;
    }

    const cuts = allCuts.filter(x => x.host === c.name);
    const cutLines: string[] = [];

    for (const cut of cuts) {
      const compB = components.find(x => x.name === cut.inserted);
      const specB = spec.components?.find(x => x.name === cut.inserted);
      if (!compB || !specB) {
        reportNotes.push(`skipped cut for ${cut.inserted} (missing component)`);
        continue;
      }
      if (!specB.localExtents || specB.localExtents.length < 3) {
        reportNotes.push(`skipped cut for ${cut.inserted} (no localExtents)`);
        continue;
      }
      const posBExpr = posExprs.get(cut.inserted) ?? AXES.map((_, i) => (compB.position[i] === 0 ? '0' : fmt(compB.position[i]))) as [string, string, string];
      const body = shapeScad(specB, cut.clearance, (reason) => {
        reportNotes.push(`cut for ${cut.inserted} fell back to box envelope (${reason})`);
      });
      cutLines.push(`        // cut for ${cut.inserted} with ${cut.clearance} mm clearance`);
      cutLines.push(`        ${placementCall(compB, posBExpr, body)}`);
    }

    const baseCall = wrapperCall ? placementCall(c, posExpr, wrapperCall) : placementCall(c, posExpr);
    
    if (cutLines.length > 0) {
      line = `    difference() {\n        ${baseCall.trimStart()}\n${cutLines.join('\n')}\n    }`;
    } else {
      line = `    ${baseCall}`;
    }
    
    if (!isZeroVec(c.correction)) {
      line += `   // local-frame correction: ${c.name} min corner measured at ${vec(c.localMin)}`;
    }
    calls.push(line);
  }

  const block = [
    '',
    GENERATED_HEADER,
    '// Placement is computed from the spec, not written by the model.',
    '// Edit the *_pos_* parameters to preview a move; change the spec to keep it.',
    ...(params.length ? ['/* [Assembly Placement] */', ...params] : []),
    ...wrappers,
    'union() {',
    ...calls,
    '}',
    '',
  ].join('\n');

  return {
    code: `${stripped.code.trimEnd()}\n${block}`,
    composed: true,
    report: { composed: true, removedStatements: stripped.removed, components, notes: reportNotes.length > 0 ? reportNotes : undefined },
  };
}

/**
 * Removes a previously generated placement block, returning the model-authored
 * modules alone.
 *
 * The repair loop needs this: handing a repair model code that already contains
 * a generated `union()` makes that block top-level geometry, so the next
 * compose() would decline as `model_wrote_assembly` and placement would quietly
 * stop being driven by the spec after the first repair. Stripping before the
 * repair and re-composing after keeps the spec authoritative for the whole run.
 */
export function stripGeneratedAssembly(code: string): string {
  const idx = code.indexOf(GENERATED_HEADER);
  if (idx === -1) return code;
  return code.slice(0, idx).trimEnd() + '\n';
}

/**
 * Instantiation strings for a pair of placed components, for the interference
 * probe. Returns null when either part has no module to call.
 *
 * This is the reason jointContracts carry partA/partB: without a placement the
 * check has nothing to intersect, which is why assembly interference could not
 * be wired into the graph before.
 */
export function instantiationFor(spec: AssemblySpec, componentName: string, frames: ModuleFrame[] = []): string | null {
  if (!spec.components?.some((x) => x.name === componentName)) return null;
  const components = buildPlacementComponents(spec, frames, true);
  const c = components.find((x) => x.name === componentName)!;
  const posExpr = AXES.map((_, i) => (c.position[i] === 0 ? '0' : fmt(c.position[i]))) as [string, string, string];
  const gussets = gussetsFor(spec, componentName);
  
  let baseCall: string;
  if (gussets.length === 0) {
    baseCall = placementCall(c, posExpr);
  } else {
    baseCall = placementCall(c, posExpr, `union() { ${bracedBodyLines(c, gussets, '').join(' ')} }`);
  }
  
  const cuts = matingCuts(spec).filter(x => x.host === componentName);
  if (cuts.length === 0) return baseCall;

  const cutLines: string[] = [];
  for (const cut of cuts) {
    const compB = components.find(x => x.name === cut.inserted);
    const specB = spec.components?.find(x => x.name === cut.inserted);
    if (!compB || !specB || !specB.localExtents || specB.localExtents.length < 3) continue;
    const posBExpr = AXES.map((_, i) => (compB.position[i] === 0 ? '0' : fmt(compB.position[i]))) as [string, string, string];
    const body = shapeScad(specB, cut.clearance);
    cutLines.push(placementCall(compB, posBExpr, body));
  }

  if (cutLines.length === 0) return baseCall;
  return `difference() {\n  ${baseCall}\n  ${cutLines.join('\n  ')}\n}`;
}
