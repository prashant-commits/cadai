/**
 * Audit-coverage harness: does the audit layer actually catch a wrong transform?
 *
 * Every check in the pipeline is deterministic TypeScript over a WASM compile,
 * so audit coverage can be measured without a single model call. The method is
 * mutation testing pointed at the audits rather than at the code: start from a
 * fixture that is correct end to end, break exactly one thing, and see whether
 * any error-severity violation fires.
 *
 * Two tiers, because they fail for different reasons:
 *
 * - 'drafter' mutates the SCRIPT and leaves the spec alone. The audits compare
 *   compiled geometry against the spec, so these SHOULD be caught; anything
 *   missed is a genuine hole in the audit layer.
 * - 'architect' mutates the SPEC, and the composer faithfully compiles the new
 *   spec. Code and spec still agree, so consistency checks cannot fire by
 *   construction. Only intent-independent physical invariants (below the build
 *   plate, floating, shell count, interference) can catch these.
 *
 * A caught architect mutation is a real invariant doing work. A missed one is
 * a decision no downstream check can question - which is the class of failure
 * that reaches the user as "the output is bad".
 */
import { AssemblySpec } from '../../src/lib/agent/assembly-spec';
import { analyzeTopLevel, composeAssembly } from '../../src/lib/design/compose-assembly';
import { measureModuleFrames } from '../../src/lib/engine/module-frames';
import { validateOpenScadCode } from '../../src/lib/agent/code-validator';
import { analyzeStl } from '../../src/lib/engine/geometry-utils';
import { auditSpec, SpecViolation } from '../../src/lib/agent/spec-audit';
import { auditPlacement } from '../../src/lib/agent/placement-audit';
import { auditSpecCoherence } from '../../src/lib/agent/spec-coherence';
import { auditModuleGuards } from '../../src/lib/design/module-guards';
import { auditHoles } from '../../src/lib/agent/hole-audit';
import type { ModelInfo } from '../../src/types';
import type { Vec3 } from '../../src/lib/design/placement-geometry';

export interface Fixture {
  name: string;
  /** What the user asked for, in one line - the intent no audit can read today. */
  intent: string;
  spec: AssemblySpec;
  /** Module definitions only; placement is composed from the spec. */
  code: string;
}

export interface Mutation {
  name: string;
  tier: 'drafter' | 'architect';
  /** One line on what a user would see go wrong. */
  breaks: string;
  apply: (f: Fixture) => Fixture;
}

/**
 * 'neutralised' is not a weaker 'caught': it means the compiled solid is
 * geometrically identical to the clean fixture, so the pipeline absorbed the
 * mutation before it could reach the user. The composer's local-frame
 * correction does exactly this. Counting those as misses would understate the
 * audits; counting them as catches would overstate them.
 */
export type Outcome = 'caught' | 'missed' | 'neutralised';

export interface RunResult {
  mutation: string;
  tier: 'drafter' | 'architect';
  breaks: string;
  compiled: boolean;
  bbox: string;
  shells?: number;
  outcome: Outcome;
  kinds: string[];
}

/**
 * bbox, volume and centre of mass together. Volume alone cannot tell a moved
 * hole from an unmoved one, and a mirrored symmetric part matches on all
 * three - correctly, because it really is the same solid.
 */
export interface Signature {
  bbox: string;
  volumeMm3: number;
  com: string;
}

function signature(info: ModelInfo | null, bbox: string): Signature {
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    bbox,
    volumeMm3: info ? round(info.volumeMm3) : NaN,
    com: info?.centerOfMass ? info.centerOfMass.map(round).join(',') : 'unknown',
  };
}

const sameSolid = (a: Signature, b: Signature) =>
  a.bbox === b.bbox && a.com === b.com && Number.isFinite(a.volumeMm3) && a.volumeMm3 === b.volumeMm3;

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** The exact sequence graph.ts runs: placeAssembly -> validate -> measure -> audit. */
export async function auditFixture(f: Fixture): Promise<{
  violations: SpecViolation[];
  compiled: boolean;
  bbox: string;
  shells?: number;
  signature: Signature;
}> {
  const defined = new Set(analyzeTopLevel(f.code).moduleNames);
  const names = (f.spec.components ?? []).map((c) => c.name).filter((n) => defined.has(n));
  const frames = await measureModuleFrames(f.code, names);
  const composed = composeAssembly(f.code, f.spec, frames);

  const validation = await validateOpenScadCode(composed.code);

  let modelInfo: ModelInfo | null = null;
  if (validation.stl && validation.stl.includes('facet normal')) {
    modelInfo = analyzeStl(validation.stl);
    modelInfo.isManifold = validation.isManifold;
    modelInfo.shellCount = validation.shellCount;
    const kb = validation.summary?.boundingBox;
    if (kb && kb.size.every((n) => Number.isFinite(n))) {
      modelInfo.dimensions = { x: kb.size[0], y: kb.size[1], z: kb.size[2] };
      modelInfo.boundingBox = { min: [...kb.min], max: [...kb.max] };
    }
  }

  const violations = auditSpec(f.spec, modelInfo, validation, composed.code);
  const modelMin = validation.summary?.boundingBox?.min ?? modelInfo?.boundingBox.min ?? null;
  violations.push(...auditPlacement(composed.report, modelMin as Vec3 | null, f.spec));
  violations.push(...auditSpecCoherence(f.spec));
  violations.push(...auditModuleGuards(f.code, f.spec));
  if (validation.valid) violations.push(...(await auditHoles(f.code, f.spec, frames)));

  const size = validation.summary?.boundingBox?.size;
  const bbox = size ? size.map((n) => Math.round(n * 100) / 100).join(' x ') : 'none';
  return {
    violations,
    compiled: validation.valid,
    bbox,
    shells: validation.shellCount,
    signature: signature(modelInfo, bbox),
  };
}

export async function runMutations(
  f: Fixture,
  mutations: Mutation[],
  baseline: Signature
): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const m of mutations) {
    const mutated = m.apply(clone(f));
    // A mutation that changed nothing produces a clean audit for the honest
    // reason that nothing broke, and would be tallied as a blind spot. That is
    // the one wrong answer this harness can give, so it is a hard failure.
    if (JSON.stringify(mutated.spec) === JSON.stringify(f.spec) && mutated.code === f.code) {
      throw new Error(`mutation "${m.name}" left the fixture unchanged - it would be miscounted as a miss`);
    }
    const { violations, compiled, bbox, shells, signature: sig } = await auditFixture(mutated);
    const errors = violations.filter((v) => v.severity === 'error');
    out.push({
      mutation: m.name,
      tier: m.tier,
      breaks: m.breaks,
      compiled,
      bbox,
      shells,
      outcome: errors.length > 0 ? 'caught' : sameSolid(sig, baseline) ? 'neutralised' : 'missed',
      kinds: [...new Set(errors.map((v) => v.kind))],
    });
  }
  return out;
}

// ---- shared mutation builders -------------------------------------------

export function shiftPosition(name: string, axis: 0 | 1 | 2, mm: number): Mutation {
  const ax = 'xyz'[axis];
  return {
    name: `architect: ${name}.position.${ax} ${mm > 0 ? '+' : ''}${mm}`,
    tier: 'architect',
    breaks: `part lands ${Math.abs(mm)} mm ${mm > 0 ? 'past' : 'short of'} where it belongs on ${ax}`,
    apply: (f) => {
      const c = f.spec.components!.find((x) => x.name === name)!;
      const p = (c.position ?? [0, 0, 0]) as number[];
      p[axis] += mm;
      c.position = p;
      return f;
    },
  };
}

export function setRotation(name: string, rot: [number, number, number], why: string): Mutation {
  return {
    name: `architect: ${name}.rotation -> [${rot.join(', ')}]`,
    tier: 'architect',
    breaks: why,
    apply: (f) => {
      f.spec.components!.find((x) => x.name === name)!.rotation = rot;
      return f;
    },
  };
}

/**
 * Wraps a module's body in a transform the Drafter should never have written,
 * by matching braces rather than by regex - a regex that silently fails to
 * match would look exactly like an undetected mutation, which is the one
 * result this harness must never fabricate. Throws when the module is absent.
 */
export function wrapModuleBody(name: string, transform: string, label: string, breaks: string): Mutation {
  return {
    name: `drafter: ${label}`,
    tier: 'drafter',
    breaks,
    apply: (f) => {
      f.code = wrapBody(f.code, name, transform);
      return f;
    },
  };
}

/** `module name() { BODY }` -> `module name() { transform { BODY } }`. */
export function wrapBody(code: string, name: string, transform: string): string {
  const header = code.indexOf(`module ${name}(`);
  if (header === -1) throw new Error(`wrapBody: no module ${name}() in the fixture`);
  const open = code.indexOf('{', header);
  if (open === -1) throw new Error(`wrapBody: module ${name}() has no body`);
  let depth = 0;
  let close = -1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) throw new Error(`wrapBody: module ${name}() is never closed`);
  const body = code.slice(open + 1, close);
  return `${code.slice(0, open + 1)}\n  ${transform} {${body}}\n${code.slice(close)}`;
}
