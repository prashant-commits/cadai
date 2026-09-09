import { AssemblySpec } from '../agent/assembly-spec';

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

export type ComposeSkipReason =
  | 'no_spec'
  | 'no_placements'
  | 'model_wrote_assembly'
  | 'missing_modules';

export interface ComposeResult {
  code: string;
  composed: boolean;
  /** Why composition was declined; useful in traces when a run is not using it. */
  reason?: ComposeSkipReason;
  /** Spec components whose module the code never defined. */
  missing?: string[];
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

/** Trims float noise without dropping real precision. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

function vec(v: [number, number, number]): string {
  return `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`;
}

function isZero(v: [number, number, number]): boolean {
  return v[0] === 0 && v[1] === 0 && v[2] === 0;
}

/**
 * Appends a generated placement block to model-authored module definitions.
 *
 * `rotate` is emitted inside `translate`, so a component is rotated about its
 * own origin and then moved into place - the reading an engineer expects from
 * "position" and "rotation" on a part.
 */
export function composeAssembly(code: string, spec: AssemblySpec | null): ComposeResult {
  if (!spec?.components?.length) {
    return { code, composed: false, reason: 'no_spec' };
  }

  const placed = spec.components.filter(
    (c) => c.position !== undefined || c.rotation !== undefined
  );
  if (placed.length === 0) {
    return { code, composed: false, reason: 'no_placements' };
  }

  const analysis = analyzeTopLevel(code);
  if (analysis.hasTopLevelGeometry) {
    // The model built its own assembly. Replacing it would be guesswork, and
    // appending ours would double the geometry.
    return { code, composed: false, reason: 'model_wrote_assembly' };
  }

  const defined = new Set(analysis.moduleNames);
  const missing = spec.components.map((c) => c.name).filter((n) => !defined.has(n));
  if (missing.length > 0) {
    return { code, composed: false, reason: 'missing_modules', missing };
  }

  const calls = spec.components.map((c) => {
    const pos = (c.position ?? [0, 0, 0]) as [number, number, number];
    const rot = (c.rotation ?? [0, 0, 0]) as [number, number, number];

    let call = `${c.name}();`;
    if (!isZero(rot)) call = `rotate(${vec(rot)}) ${call}`;
    if (!isZero(pos)) call = `translate(${vec(pos)}) ${call}`;
    return `    ${call}`;
  });

  const block = [
    '',
    GENERATED_HEADER,
    '// Placement is computed from the spec, not written by the model.',
    '// To move a part, change its position/rotation in the spec.',
    'union() {',
    ...calls,
    '}',
    '',
  ].join('\n');

  return { code: `${code.trimEnd()}\n${block}`, composed: true };
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
export function instantiationFor(spec: AssemblySpec, componentName: string): string | null {
  const c = spec.components?.find((x) => x.name === componentName);
  if (!c) return null;

  const pos = (c.position ?? [0, 0, 0]) as [number, number, number];
  const rot = (c.rotation ?? [0, 0, 0]) as [number, number, number];

  let call = `${c.name}();`;
  if (!isZero(rot)) call = `rotate(${vec(rot)}) ${call}`;
  if (!isZero(pos)) call = `translate(${vec(pos)}) ${call}`;
  return call;
}
