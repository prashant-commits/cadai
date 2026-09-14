# Deterministic Placement and Generation Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make assembly placement deterministic and measured so generated parts rest on the floor and on each other, and build an eval harness that proves it with before/after rates.

**Architecture:** The Architect emits positions (assembled pose, always); the Drafter authors one module per component at its local origin; TypeScript measures each module's bounding box with one wasm compile, strips any model-written top-level geometry, and emits the placement block with the spec's coordinates plus an origin correction. A placement audit computes floor and contact violations from per-part assembly-pose bounding boxes. An eval script runs 10 prompts through the real graph (gates auto-approved, repair off) and records rates locally and as Langfuse experiment scores.

**Tech Stack:** Next.js 16 (App Router, Node runtime), LangGraph 1.x, zod 4 (`z.toJSONSchema`), openscad-wasm (`compileScad` with `--summary`), vitest 4, tsx, Langfuse v5 (`@langfuse/langchain`, `@langfuse/otel`, plus new `@langfuse/client`).

**Spec:** `docs/superpowers/specs/2026-09-14-deterministic-placement-design.md`

## Global Constraints

- Prompt word budgets are enforced by `src/lib/agent/system-prompt.test.ts`: `CAD_AI_SYSTEM_PROMPT` 1300, `ARCHITECT_PREAMBLE` 520, `DRAFTER_PREAMBLE` 560, `DRAFTER_PLACEMENT_CONTRACT` 260, `CRITIC_PREAMBLE` 460, `REPAIR_PREAMBLE` 460. Current counts: 1297 / 443 / 549 / 194 / 398 / 395.
- Every fenced ```` ```openscad ```` block inside a prompt must compile to non-empty, manifold 3D geometry (same test file). Never `minkowski()`.
- The JSON Schema sent to the model must not contain `prefixItems`, `oneOf`, `not`, `additionalItems`, `$ref` (Gemini rejects them) and every `{"type":"number"}` must stay bounded by `boundNumbers` in `src/lib/agent/assembly-spec.ts`.
- Tests never call a real model: `src/vitest.setup.ts` injects placeholder keys and every graph suite mocks `@langchain/google-genai` and `@langchain/openai` (see `src/lib/agent/graph-placement.test.ts`). The wasm compiler is real in tests.
- Nothing raw from a model may reach the UI. Progress messages are one-line markdown sentences; never dump JSON or model text into a `message`.
- `/scripts/` is gitignored. The eval harness lives in `eval/` (committed). `/eval/results/` is gitignored.
- No commit touches `.env`, `.env.local`, or `.cadai/`.
- Repair loop and visual critic are parked: after Task 6 their env defaults are `CADAI_MAX_ATTEMPTS=1` and `CADAI_VISUAL_CRITIC` off. Do not improve repair prompts or the critic in this plan.
- Run the whole suite with `npm test` (vitest run). Wasm suites are slow; `testTimeout` is 30 s.
- Work on branch `feat/deterministic-placement` created from `main`. Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` as the last line of the message.
- Do not run the eval (Tasks 7 and 13) without printing the call estimate first; it spends model quota. Use `--model deepseek-v4-flash` unless the user says otherwise.

---

## Phase 0 — Measure first (no change to what the model generates)

### Task 1: `stripTopLevelGeometry` in compose-assembly

**Files:**
- Modify: `src/lib/design/compose-assembly.ts` (append after `analyzeTopLevel`)
- Test: `src/lib/design/compose-assembly.test.ts`

**Interfaces:**
- Produces: `export function stripTopLevelGeometry(code: string): { code: string; removed: number }` and `export function hasGeneratedAssembly(code: string): boolean`. `removed` counts depth-0 statements dropped. Declarations (`module`, `function`, assignments, `include`, `use`) and comments attached to them are kept verbatim.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/deterministic-placement main
```

- [ ] **Step 2: Write the failing tests**

Append to `src/lib/design/compose-assembly.test.ts` (add `stripTopLevelGeometry, hasGeneratedAssembly` to the existing import from `./compose-assembly`):

```ts
describe('stripTopLevelGeometry', () => {
  it('removes a bare call and reports how many statements went', () => {
    const r = stripTopLevelGeometry(`${MODULES}\nbase_plate();\n`);
    expect(r.removed).toBe(1);
    expect(r.code).not.toContain('base_plate();');
    expect(analyzeTopLevel(r.code).hasTopLevelGeometry).toBe(false);
    expect(analyzeTopLevel(r.code).moduleNames).toEqual(['base_plate', 'upright']);
  });

  it('removes transformed calls, CSG blocks and control flow with their bodies', () => {
    const authored = `${MODULES}
translate([0, 0, 6]) upright();
union() {
  base_plate();
  translate([0,0,6]) upright();
}
for (i = [0:2]) translate([i * 10, 0, 0]) upright();
if (true) { base_plate(); }
`;
    const r = stripTopLevelGeometry(authored);
    expect(r.removed).toBe(4);
    expect(r.code).not.toMatch(/translate|union\(\)|for \(|if \(/);
    expect(r.code).toContain('module base_plate()');
    expect(r.code).toContain('module upright()');
  });

  it('keeps assignments, functions, directives and comments that precede declarations', () => {
    const src = `include <x.scad>
$fn = 48;
wall_t = 2.4; // [1.6:5] wall
function area(x) = x * x;
// the base
module base_plate() { cube([60, 40, 6]); }
`;
    const r = stripTopLevelGeometry(src);
    expect(r.removed).toBe(0);
    expect(r.code).toBe(src);
  });

  it('is not fooled by braces in strings or comments', () => {
    const src = `label = "a { brace";
// translate([9,9,9]) base_plate();
/* union() { base_plate(); } */
module base_plate() { cube([1,1,1]); }
base_plate();
`;
    const r = stripTopLevelGeometry(src);
    expect(r.removed).toBe(1);
    expect(r.code).toContain('label = "a { brace";');
    expect(r.code).toContain('module base_plate()');
    expect(r.code).not.toMatch(/^base_plate\(\);/m);
  });

  it('compiles to empty after stripping, and to geometry once a call is appended', async () => {
    const { compileScad } = await import('../engine/scad-compiler');
    const r = stripTopLevelGeometry(`${MODULES}\nunion() { base_plate(); upright(); }`);
    const empty = await compileScad(r.code);
    expect(empty.valid).toBe(false);
    const withCall = await compileScad(`${r.code}\nbase_plate();`);
    expect(withCall.valid).toBe(true);
    expect(withCall.summary?.boundingBox?.size).toEqual([60, 40, 6]);
  });
});

describe('hasGeneratedAssembly', () => {
  it('detects the generated placement block', () => {
    const composed = composeAssembly(MODULES, spec([{ name: 'base_plate', description: 'b', position: [0, 0, 0] }]));
    expect(hasGeneratedAssembly(composed.code)).toBe(true);
    expect(hasGeneratedAssembly(MODULES)).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/design/compose-assembly.test.ts`
Expected: FAIL with `stripTopLevelGeometry is not a function` (or "does not provide an export named").

- [ ] **Step 4: Implement**

Append to `src/lib/design/compose-assembly.ts`, after `analyzeTopLevel`:

```ts
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
```

Note: `GENERATED_HEADER` is already declared above `analyzeTopLevel` in this file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/design/compose-assembly.test.ts`
Expected: PASS (all existing tests plus the 6 new ones). If the "keeps assignments" test fails on trailing whitespace only, compare with `expect(r.code.trim()).toBe(src.trim())` — that is acceptable.

- [ ] **Step 6: Commit**

```bash
git add src/lib/design/compose-assembly.ts src/lib/design/compose-assembly.test.ts
git commit -m "feat(design): strip model-written top-level geometry from OpenSCAD

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Placement geometry (rotation and placed bounds)

**Files:**
- Create: `src/lib/design/placement-geometry.ts`
- Test: `src/lib/design/placement-geometry.test.ts`

**Interfaces:**
- Produces:
  - `export type Vec3 = [number, number, number]`
  - `export interface Bounds { min: Vec3; max: Vec3 }`
  - `export const FRAME_EPS = 0.05` (mm; below this a coordinate counts as zero)
  - `export function isZeroVec(v: Vec3, eps?: number): boolean`
  - `export function rotatePoint(p: Vec3, degrees: Vec3): Vec3` — OpenSCAD `rotate([a,b,c])` semantics: rotate about X by a, then Y by b, then Z by c.
  - `export function placedBounds(local: Bounds, position: Vec3, rotation: Vec3, correction?: Vec3): Bounds` — axis-aligned bounds of the box after `translate(position) rotate(rotation) translate(correction)`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/design/placement-geometry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rotatePoint, placedBounds, isZeroVec, Vec3 } from './placement-geometry';

const near = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('rotatePoint (OpenSCAD rotate([x, y, z]) order)', () => {
  it('rotate([90,0,0]) sends +y to +z', () => near(rotatePoint([0, 1, 0], [90, 0, 0]), [0, 0, 1]));
  it('rotate([-90,0,0]) sends +y to -z (the inverted-support bug)', () =>
    near(rotatePoint([0, 1, 0], [-90, 0, 0]), [0, 0, -1]));
  it('rotate([0,90,0]) sends +z to +x', () => near(rotatePoint([0, 0, 1], [0, 90, 0]), [1, 0, 0]));
  it('rotate([0,0,90]) sends +x to +y', () => near(rotatePoint([1, 0, 0], [0, 0, 90]), [0, 1, 0]));
  it('applies X, then Y, then Z', () => {
    // [1,0,0] -> Rx(90): [1,0,0] -> Ry(90): [0,0,-1] -> Rz(90): [0,0,-1]
    near(rotatePoint([1, 0, 0], [90, 90, 90]), [0, 0, -1]);
  });
});

describe('placedBounds', () => {
  const box = { min: [0, 0, 0] as Vec3, max: [10, 20, 30] as Vec3 };

  it('translates an unrotated box', () => {
    const b = placedBounds(box, [5, 6, 7], [0, 0, 0]);
    near(b.min, [5, 6, 7]);
    near(b.max, [15, 26, 37]);
  });

  it('rotate([-90,0,0]) hangs the box below the floor', () => {
    const b = placedBounds(box, [0, 0, 0], [-90, 0, 0]);
    near(b.min, [0, 0, -20]);
    near(b.max, [10, 30, 0]);
  });

  it('applies the local-frame correction before rotating', () => {
    // A module authored from z=-30..0 gets correction +30, then rotates.
    const hanging = { min: [0, 0, -30] as Vec3, max: [10, 20, 0] as Vec3 };
    const b = placedBounds(hanging, [0, 0, 5], [0, 0, 90], [0, 0, 30]);
    near(b.min, [-20, 0, 5]);
    near(b.max, [0, 10, 35]);
  });
});

describe('isZeroVec', () => {
  it('treats sub-epsilon noise as zero', () => {
    expect(isZeroVec([0.01, -0.02, 0])).toBe(true);
    expect(isZeroVec([0.1, 0, 0])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/design/placement-geometry.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/lib/design/placement-geometry.ts`:

```ts
/**
 * Pure geometry for spec-driven placement: the same transform order OpenSCAD
 * applies to `translate(position) rotate(rotation) translate(correction) part();`.
 */

export type Vec3 = [number, number, number];
export interface Bounds { min: Vec3; max: Vec3 }

/** Below this many mm a coordinate is treated as zero (tessellation noise). */
export const FRAME_EPS = 0.05;

export function isZeroVec(v: Vec3, eps: number = FRAME_EPS): boolean {
  return v.every((n) => Math.abs(n) <= eps);
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const clean = (n: number) => (Math.abs(n) < 1e-9 ? 0 : n);

/**
 * OpenSCAD's rotate([a, b, c]) rotates about X by a, then Y by b, then Z by c
 * (right-hand rule). Written out per axis so the sign conventions are visible.
 */
export function rotatePoint(p: Vec3, degrees: Vec3): Vec3 {
  let [x, y, z] = p;
  {
    const c = Math.cos(rad(degrees[0])), s = Math.sin(rad(degrees[0]));
    const y2 = y * c - z * s, z2 = y * s + z * c;
    y = y2; z = z2;
  }
  {
    const c = Math.cos(rad(degrees[1])), s = Math.sin(rad(degrees[1]));
    const x2 = x * c + z * s, z2 = -x * s + z * c;
    x = x2; z = z2;
  }
  {
    const c = Math.cos(rad(degrees[2])), s = Math.sin(rad(degrees[2]));
    const x2 = x * c - y * s, y2 = x * s + y * c;
    x = x2; y = y2;
  }
  return [clean(x), clean(y), clean(z)];
}

/** Axis-aligned bounds of a local box after correction, rotation and translation. */
export function placedBounds(
  local: Bounds,
  position: Vec3,
  rotation: Vec3,
  correction: Vec3 = [0, 0, 0]
): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const cx of [local.min[0], local.max[0]])
    for (const cy of [local.min[1], local.max[1]])
      for (const cz of [local.min[2], local.max[2]]) {
        const corrected: Vec3 = [cx + correction[0], cy + correction[1], cz + correction[2]];
        const r = rotatePoint(corrected, rotation);
        for (let i = 0; i < 3; i++) {
          const v = r[i] + position[i];
          if (v < min[i]) min[i] = v;
          if (v > max[i]) max[i] = v;
        }
      }
  return { min: min.map(clean) as Vec3, max: max.map(clean) as Vec3 };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/design/placement-geometry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/design/placement-geometry.ts src/lib/design/placement-geometry.test.ts
git commit -m "feat(design): placement geometry with OpenSCAD rotation order

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Measure each module's local frame

**Files:**
- Create: `src/lib/engine/module-frames.ts`
- Test: `src/lib/engine/module-frames.test.ts`

**Interfaces:**
- Consumes: `compileScad` from `./scad-compiler`; `stripTopLevelGeometry` from `../design/compose-assembly`; `Vec3` from `../design/placement-geometry`.
- Produces:
  - `export interface ModuleFrame { name: string; valid: boolean; min: Vec3; max: Vec3; size: Vec3; error?: string }`
  - `export async function measureModuleFrames(code: string, moduleNames: string[]): Promise<ModuleFrame[]>` — one compile per name, sequential, order preserved. A module that compiles to nothing returns `valid: false` with zero vectors.

- [ ] **Step 1: Write the failing test**

Create `src/lib/engine/module-frames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { measureModuleFrames } from './module-frames';

const CODE = `
$fn = 24;
module at_origin() { cube([10, 20, 30]); }
module centred_cyl() { cylinder(d = 10, h = 5); }
module hanging() { rotate([-90, 0, 0]) linear_extrude(4) square([10, 20]); }
module nothing() { }
// The model placed things itself; measurement must ignore this.
union() { at_origin(); translate([50, 50, 50]) centred_cyl(); }
`;

describe('measureModuleFrames', () => {
  it('measures each module alone, ignoring top-level geometry', async () => {
    const frames = await measureModuleFrames(CODE, ['at_origin', 'centred_cyl', 'hanging', 'nothing']);
    expect(frames.map((f) => f.name)).toEqual(['at_origin', 'centred_cyl', 'hanging', 'nothing']);

    const [origin, cyl, hang, none] = frames;
    expect(origin.valid).toBe(true);
    expect(origin.min).toEqual([0, 0, 0]);
    expect(origin.size).toEqual([10, 20, 30]);

    // A cylinder is centred on its axis: min corner at [-r, -r, 0].
    expect(cyl.valid).toBe(true);
    expect(cyl.min[0]).toBeCloseTo(-5, 1);
    expect(cyl.min[1]).toBeCloseTo(-5, 1);
    expect(cyl.min[2]).toBeCloseTo(0, 3);

    // rotate([-90,0,0]) maps +y to -z: the part hangs from z=-20 to 0.
    expect(hang.valid).toBe(true);
    expect(hang.min[2]).toBeCloseTo(-20, 3);
    expect(hang.max[2]).toBeCloseTo(0, 3);
    expect(hang.max[1]).toBeCloseTo(4, 3);

    expect(none.valid).toBe(false);
  });

  it('returns an empty list for no names without compiling', async () => {
    expect(await measureModuleFrames(CODE, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/engine/module-frames.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/lib/engine/module-frames.ts`:

```ts
import { compileScad } from './scad-compiler';
import { stripTopLevelGeometry } from '../design/compose-assembly';
import type { Vec3 } from '../design/placement-geometry';

export interface ModuleFrame {
  name: string;
  /** False when the module compiled to nothing (empty, 2D, or errored). */
  valid: boolean;
  min: Vec3;
  max: Vec3;
  size: Vec3;
  error?: string;
}

const ZERO: Vec3 = [0, 0, 0];

/**
 * Compiles each named module ALONE and reads OpenSCAD's own bounding box for
 * it. This is what makes the "origin at the min corner" contract measurable
 * instead of hoped for: the min corner is the correction the composer applies,
 * and the size is what the extents audit compares to the spec.
 *
 * One wasm compile per module (about a second each), run sequentially so a
 * ten-part assembly does not spawn ten wasm instances at once.
 */
export async function measureModuleFrames(code: string, moduleNames: string[]): Promise<ModuleFrame[]> {
  if (moduleNames.length === 0) return [];
  const modules = stripTopLevelGeometry(code).code;
  const frames: ModuleFrame[] = [];

  for (const name of moduleNames) {
    const result = await compileScad(`${modules}\n${name}();\n`);
    const bb = result.summary?.boundingBox;
    const usable =
      result.valid && !!bb && [...bb.min, ...bb.max].every((n) => Number.isFinite(n));
    if (!usable) {
      frames.push({
        name,
        valid: false,
        min: ZERO,
        max: ZERO,
        size: ZERO,
        error: result.error ?? 'module produced no measurable 3D geometry',
      });
      continue;
    }
    const round = (n: number) => Math.round(n * 1000) / 1000;
    frames.push({
      name,
      valid: true,
      min: bb.min.map(round) as Vec3,
      max: bb.max.map(round) as Vec3,
      size: bb.size.map(round) as Vec3,
    });
  }
  return frames;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/engine/module-frames.test.ts`
Expected: PASS (takes a few seconds; 4 compiles).

- [ ] **Step 5: Commit**

```bash
git add src/lib/engine/module-frames.ts src/lib/engine/module-frames.test.ts
git commit -m "feat(engine): measure each component module's local bounding box

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Placement report and floor/contact audit

**Files:**
- Create: `src/lib/design/placement-report.ts`
- Create: `src/lib/agent/placement-audit.ts`
- Modify: `src/lib/agent/spec-audit.ts` (the `SpecViolation.kind` union, lines 5–20)
- Modify: `src/lib/agent/graph.ts` (`REPAIR_KIND_PRIORITY` and `REPAIR_HINTS`, lines 206–229)
- Test: `src/lib/design/placement-report.test.ts`, `src/lib/agent/placement-audit.test.ts`

**Interfaces:**
- Consumes: `ModuleFrame` (Task 3), `placedBounds`, `isZeroVec`, `Vec3`, `FRAME_EPS` (Task 2), `AssemblySpec`.
- Produces:
  - `export interface PlacementComponent { name: string; measured: boolean; localMin: Vec3; localMax: Vec3; size: Vec3; correction: Vec3; position: Vec3; rotation: Vec3; placedMin: Vec3; placedMax: Vec3 }`
  - `export interface PlacementReport { composed: boolean; removedStatements: number; components: PlacementComponent[] }`
  - `export function buildPlacementComponents(spec: AssemblySpec, frames: ModuleFrame[], correct: boolean): PlacementComponent[]` — `correct=true` sets `correction = -localMin` (so the placed box starts at `position`); `false` leaves correction zero.
  - `export function findFloating(components: PlacementComponent[], eps?: number): Array<{ name: string; gapMm: number }>`
  - `export function placementSummary(report: PlacementReport | null, modelMinZ: number | null): string` — one markdown sentence for the progress feed.
  - `export function auditPlacement(report: PlacementReport | null, modelMin: Vec3 | null, spec: AssemblySpec | null): SpecViolation[]` — kinds `floor` (error), `floating` (error, only when `report.composed`), `local_frame` (warning).
  - New `SpecViolation['kind']` members: `'floor' | 'floating' | 'local_frame' | 'extents'`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/design/placement-report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPlacementComponents, findFloating, placementSummary, PlacementComponent } from './placement-report';
import type { ModuleFrame } from '../engine/module-frames';
import type { AssemblySpec } from '../agent/assembly-spec';

const frame = (name: string, min: [number, number, number], max: [number, number, number]): ModuleFrame => ({
  name, valid: true, min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
});

const spec = (components: AssemblySpec['components']): AssemblySpec => ({
  assemblyName: 't', boundingBox: { width: 1, length: 1, height: 1 }, components,
  edgeTreatments: [], stressPoints: [], assumptions: [], openQuestions: [],
});

describe('buildPlacementComponents', () => {
  it('places a measured module at its spec position with an origin correction', () => {
    const s = spec([{ name: 'arm', description: 'a', position: [0, 0, 6] }]);
    const [c] = buildPlacementComponents(s, [frame('arm', [-5, -5, 0], [5, 5, 40])], true);
    expect(c.measured).toBe(true);
    expect(c.correction).toEqual([5, 5, 0]);
    expect(c.placedMin).toEqual([0, 0, 6]);
    expect(c.placedMax).toEqual([10, 10, 46]);
  });

  it('leaves correction at zero when asked not to correct', () => {
    const s = spec([{ name: 'arm', description: 'a', position: [0, 0, 6] }]);
    const [c] = buildPlacementComponents(s, [frame('arm', [-5, -5, 0], [5, 5, 40])], false);
    expect(c.correction).toEqual([0, 0, 0]);
    expect(c.placedMin).toEqual([-5, -5, 6]);
  });

  it('marks components without a usable frame as unmeasured', () => {
    const s = spec([{ name: 'ghost', description: 'g' }]);
    const [c] = buildPlacementComponents(s, [], true);
    expect(c.measured).toBe(false);
    expect(c.position).toEqual([0, 0, 0]);
  });
});

describe('findFloating', () => {
  const part = (name: string, min: [number, number, number], max: [number, number, number]): PlacementComponent => ({
    name, measured: true, localMin: [0, 0, 0], localMax: [0, 0, 0], size: [0, 0, 0], correction: [0, 0, 0],
    position: [0, 0, 0], rotation: [0, 0, 0], placedMin: min, placedMax: max,
  });

  it('accepts a part on the floor and a part resting on it', () => {
    const base = part('base', [0, 0, 0], [40, 40, 10]);
    const peg = part('peg', [10, 10, 10], [20, 20, 20]);
    expect(findFloating([base, peg])).toEqual([]);
  });

  it('flags a part hovering above another with the gap', () => {
    const base = part('base', [0, 0, 0], [40, 40, 10]);
    const peg = part('peg', [10, 10, 15], [20, 20, 25]);
    expect(findFloating([base, peg])).toEqual([{ name: 'peg', gapMm: 5 }]);
  });

  it('flags a part with nothing beneath it by its height above the floor', () => {
    const base = part('base', [0, 0, 0], [40, 40, 10]);
    const bar = part('bar', [100, 100, 150], [120, 120, 160]);
    expect(findFloating([base, bar])).toEqual([{ name: 'bar', gapMm: 150 }]);
  });

  it('propagates support through a stack', () => {
    const a = part('a', [0, 0, 0], [10, 10, 10]);
    const b = part('b', [0, 0, 10], [10, 10, 20]);
    const c = part('c', [0, 0, 20], [10, 10, 30]);
    expect(findFloating([c, b, a])).toEqual([]);
  });

  it('ignores unmeasured components', () => {
    const ghost = { ...part('ghost', [0, 0, 99], [1, 1, 100]), measured: false };
    expect(findFloating([ghost])).toEqual([]);
  });
});

describe('placementSummary', () => {
  it('is a single markdown sentence with no JSON', () => {
    const s = placementSummary(
      { composed: false, removedStatements: 0, components: [] },
      -150
    );
    expect(s).toMatch(/lowest point is at z = -150 mm/);
    expect(s).not.toContain('{');
    expect(s.split('\n')).toHaveLength(1);
  });
});
```

Create `src/lib/agent/placement-audit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { auditPlacement } from './placement-audit';
import type { PlacementReport, PlacementComponent } from '../design/placement-report';

const part = (name: string, min: [number, number, number], max: [number, number, number], localMin: [number, number, number] = [0, 0, 0]): PlacementComponent => ({
  name, measured: true, localMin, localMax: [10, 10, 10], size: [10, 10, 10], correction: [0, 0, 0],
  position: [0, 0, 0], rotation: [0, 0, 0], placedMin: min, placedMax: max,
});
const report = (components: PlacementComponent[], composed = true): PlacementReport => ({ composed, removedStatements: 0, components });
const kinds = (v: ReturnType<typeof auditPlacement>) => v.map((x) => `${x.severity}:${x.kind}`);

describe('auditPlacement', () => {
  it('is silent for a grounded assembly on the floor', () => {
    expect(auditPlacement(report([part('base', [0, 0, 0], [40, 40, 10])]), [0, 0, 0], null)).toEqual([]);
  });

  it('errors when the model hangs below or floats above the floor', () => {
    expect(kinds(auditPlacement(null, [0, 0, -13.5], null))).toEqual(['error:floor']);
    expect(kinds(auditPlacement(null, [0, 0, 5], null))).toEqual(['error:floor']);
    expect(auditPlacement(null, [0, 0, 0.01], null)).toEqual([]);
  });

  it('errors for each floating part, but only when placement was composed', () => {
    const r = report([part('base', [0, 0, 0], [40, 40, 10]), part('peg', [10, 10, 15], [20, 20, 25])]);
    const v = auditPlacement(r, [0, 0, 0], null);
    expect(kinds(v)).toEqual(['error:floating']);
    expect(v[0].message).toContain("'peg'");
    expect(v[0].message).toContain('5');
    expect(auditPlacement({ ...r, composed: false }, [0, 0, 0], null)).toEqual([]);
  });

  it('names the part that hangs below the plate, with its depth', () => {
    const r = report([part('base', [0, 0, 0], [40, 40, 10]), part('leg', [0, 0, -30], [10, 10, 0])]);
    const v = auditPlacement(r, [0, 0, -30], null);
    expect(kinds(v)).toEqual(['error:floor']);
    expect(v[0].field).toBe('leg');
    expect(v[0].message).toContain("'leg'");
    expect(v[0].message).toContain('30');
    expect(v[0].message).toMatch(/below the build plate/);
  });

  it('warns about a module whose min corner is off the origin', () => {
    const r = report([part('cyl', [0, 0, 0], [10, 10, 10], [-5, -5, 0])]);
    const v = auditPlacement(r, [0, 0, 0], null);
    expect(kinds(v)).toEqual(['warning:local_frame']);
    expect(v[0].message).toContain('cyl');
  });

  it('does not crash without a report or a model', () => {
    expect(auditPlacement(null, null, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/design/placement-report.test.ts src/lib/agent/placement-audit.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Extend the violation kinds**

In `src/lib/agent/spec-audit.ts`, inside the `kind:` union of `SpecViolation`, add these four members after `'standing'`:

```ts
    /** Whole-model min z is not 0: something hangs below or hovers above the floor. */
    | 'floor'
    /** A placed component does not rest on the floor or on any other component. */
    | 'floating'
    /** A module's min corner is not at its local origin (informational once corrected). */
    | 'local_frame'
    /** A module's measured size disagrees with the spec's localExtents. */
    | 'extents'
```

In `src/lib/agent/graph.ts`, change `REPAIR_KIND_PRIORITY` to:

```ts
const REPAIR_KIND_PRIORITY: SpecViolation['kind'][] = [
  'unknown_symbol', 'dimensionality', 'empty', 'manifold', 'shells', 'interference',
  'clearance', 'floating', 'floor', 'extents', 'bbox', 'standing', 'buildplate', 'compile', 'visual',
];
```

and add to `REPAIR_HINTS`:

```ts
  floating: 'A component does not rest on the floor or on any other component. Fix its spec position or its module\'s local origin; do not change its shape.',
  floor: 'The lowest point of the model is not at z = 0. Every part must sit on the floor or on another part.',
  extents: 'A module\'s measured size differs from the spec\'s localExtents. Resize the module; do not move it.',
```

- [ ] **Step 4: Implement the report**

Create `src/lib/design/placement-report.ts`:

```ts
import type { AssemblySpec } from '../agent/assembly-spec';
import type { ModuleFrame } from '../engine/module-frames';
import { FRAME_EPS, isZeroVec, placedBounds, Vec3 } from './placement-geometry';

/** One component's measured local frame and where the spec puts it. */
export interface PlacementComponent {
  name: string;
  /** False when the module could not be compiled alone; placed bounds are meaningless then. */
  measured: boolean;
  localMin: Vec3;
  localMax: Vec3;
  size: Vec3;
  /** translate() applied inside the placement so the module's min corner lands on its origin. */
  correction: Vec3;
  position: Vec3;
  rotation: Vec3;
  placedMin: Vec3;
  placedMax: Vec3;
}

export interface PlacementReport {
  /** True when the code carries the generated placement block. */
  composed: boolean;
  /** Model-written top-level statements the composer removed. */
  removedStatements: number;
  components: PlacementComponent[];
}

const ZERO: Vec3 = [0, 0, 0];
const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildPlacementComponents(
  spec: AssemblySpec,
  frames: ModuleFrame[],
  correct: boolean
): PlacementComponent[] {
  const byName = new Map(frames.map((f) => [f.name, f]));
  return (spec.components ?? []).map((c) => {
    const position = (c.position ?? ZERO) as Vec3;
    const rotation = (c.rotation ?? ZERO) as Vec3;
    const frame = byName.get(c.name);
    if (!frame?.valid) {
      return {
        name: c.name, measured: false, localMin: ZERO, localMax: ZERO, size: ZERO,
        correction: ZERO, position, rotation, placedMin: position, placedMax: position,
      };
    }
    const correction: Vec3 = correct
      ? (frame.min.map((v) => (Math.abs(v) <= FRAME_EPS ? 0 : -v)) as Vec3)
      : ZERO;
    const placed = placedBounds({ min: frame.min, max: frame.max }, position, rotation, correction);
    return {
      name: c.name, measured: true, localMin: frame.min, localMax: frame.max, size: frame.size,
      correction, position, rotation,
      placedMin: placed.min.map(round2) as Vec3, placedMax: placed.max.map(round2) as Vec3,
    };
  });
}

function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number, eps: number): boolean {
  return aMin <= bMax + eps && bMin <= aMax + eps;
}

function touches(a: PlacementComponent, b: PlacementComponent, eps: number): boolean {
  return [0, 1, 2].every((i) => overlap1d(a.placedMin[i], a.placedMax[i], b.placedMin[i], b.placedMax[i], eps));
}

/** Vertical gap from a part's underside to the nearest thing beneath it (floor or a part it overlaps in XY). */
function gapBelow(c: PlacementComponent, all: PlacementComponent[], eps: number): number {
  let gap = c.placedMin[2];
  for (const o of all) {
    if (o === c) continue;
    const xy =
      overlap1d(c.placedMin[0], c.placedMax[0], o.placedMin[0], o.placedMax[0], eps) &&
      overlap1d(c.placedMin[1], c.placedMax[1], o.placedMin[1], o.placedMax[1], eps);
    if (!xy) continue;
    const g = c.placedMin[2] - o.placedMax[2];
    if (g >= 0 && g < gap) gap = g;
  }
  return round2(gap);
}

/**
 * Support graph over axis-aligned boxes: a part is grounded when it sits on
 * the floor (min z <= eps) or touches a grounded part. Everything else floats.
 * Boxes over-approximate contact between concave parts, so this can miss a
 * gap between two L-shapes whose boxes overlap - but it never invents one.
 */
export function findFloating(
  components: PlacementComponent[],
  eps: number = FRAME_EPS
): Array<{ name: string; gapMm: number }> {
  const measured = components.filter((c) => c.measured);
  const grounded = new Set(measured.filter((c) => c.placedMin[2] <= eps).map((c) => c.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of measured) {
      if (grounded.has(c.name)) continue;
      if (measured.some((g) => grounded.has(g.name) && touches(c, g, eps))) {
        grounded.add(c.name);
        grew = true;
      }
    }
  }
  return measured
    .filter((c) => !grounded.has(c.name))
    .map((c) => ({ name: c.name, gapMm: gapBelow(c, measured, eps) }));
}

const vec = (v: Vec3) => `[${v.map(round2).join(', ')}]`;

/** One markdown sentence for the progress feed. Never JSON. */
export function placementSummary(report: PlacementReport | null, modelMinZ: number | null): string {
  const parts: string[] = [];
  if (report) {
    const measured = report.components.filter((c) => c.measured);
    parts.push(
      report.composed
        ? `placed ${report.components.length} component(s) from the spec`
        : 'placement was not composed from the spec'
    );
    if (report.removedStatements > 0) parts.push(`removed ${report.removedStatements} model-written top-level statement(s)`);
    const off = measured.filter((c) => !isZeroVec(c.localMin));
    if (off.length > 0) {
      parts.push(
        `modules off their origin: ${off.map((c) => `${c.name} ${vec(c.localMin)}`).join(', ')}` +
          (off.some((c) => !isZeroVec(c.correction)) ? ' (corrected)' : '')
      );
    }
    if (report.composed) {
      const floating = findFloating(report.components);
      if (floating.length > 0) parts.push(`floating: ${floating.map((f) => `${f.name} (${f.gapMm} mm gap)`).join(', ')}`);
    }
  }
  if (modelMinZ !== null) parts.push(`lowest point is at z = ${round2(modelMinZ)} mm`);
  return `Placement check: ${parts.join('; ') || 'nothing to measure'}.`;
}
```

- [ ] **Step 5: Implement the audit**

Create `src/lib/agent/placement-audit.ts`:

```ts
import type { AssemblySpec } from './assembly-spec';
import type { SpecViolation } from './spec-audit';
import { findFloating, PlacementReport } from '../design/placement-report';
import { FRAME_EPS, isZeroVec, Vec3 } from '../design/placement-geometry';

const vec = (v: Vec3) => `[${v.map((n) => Math.round(n * 100) / 100).join(', ')}]`;

/**
 * Turns the placement report and the compiled model's bounding box into
 * violations. `floor` is spec-independent (it only needs the model's min z);
 * `floating` needs composed placement, because only then do the per-part
 * boxes describe what was actually compiled.
 *
 * `spec` is reserved for the extents check added with localExtents.
 */
export function auditPlacement(
  report: PlacementReport | null,
  modelMin: Vec3 | null,
  spec: AssemblySpec | null
): SpecViolation[] {
  void spec;
  const violations: SpecViolation[] = [];
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Rule: nothing is ever below the build plate. Name each offending part when
  // the report knows them; fall back to the whole-model check otherwise.
  const below = (report?.components ?? []).filter((c) => c.measured && c.placedMin[2] < -FRAME_EPS);
  for (const c of below) {
    const depth = round2(-c.placedMin[2]);
    violations.push({
      kind: 'floor',
      field: c.name,
      expected: 'min z >= 0',
      measured: `${-depth} mm`,
      deltaMm: depth,
      severity: 'error',
      message:
        `'${c.name}' extends ${depth} mm below the build plate (z = 0). Nothing may ever be below the plate: ` +
        'raise its spec position or fix its module\'s local frame.',
    });
  }

  if (below.length === 0 && modelMin && Math.abs(modelMin[2]) > FRAME_EPS) {
    const z = round2(modelMin[2]);
    violations.push({
      kind: 'floor',
      field: 'boundingBox.min.z',
      expected: 0,
      measured: z,
      deltaMm: Math.abs(z),
      severity: 'error',
      message:
        z < 0
          ? `The compiled model extends ${-z} mm below the build plate (z = 0). Nothing may ever be below the plate.`
          : `The lowest point of the compiled model hovers ${z} mm above the build plate. The model must rest on z = 0.`,
    });
  }

  if (!report) return violations;

  for (const c of report.components) {
    if (!c.measured || isZeroVec(c.localMin)) continue;
    violations.push({
      kind: 'local_frame',
      field: c.name,
      expected: '[0, 0, 0]',
      measured: vec(c.localMin),
      severity: 'warning',
      message:
        `module ${c.name}() has its min corner at ${vec(c.localMin)} instead of the origin` +
        (isZeroVec(c.correction)
          ? '; its spec position lands the part offset by that much.'
          : `; placement corrected it by ${vec(c.correction)}.`),
    });
  }

  if (report.composed) {
    for (const f of findFloating(report.components)) {
      violations.push({
        kind: 'floating',
        field: f.name,
        expected: 'resting on the floor or on another component',
        measured: `${f.gapMm} mm gap below`,
        deltaMm: f.gapMm,
        severity: 'error',
        message:
          `'${f.name}' does not rest on the floor or on any other part (${f.gapMm} mm gap below it). ` +
          'Fix its spec position or its module\'s local frame.',
      });
    }
  }

  return violations;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/lib/design/placement-report.test.ts src/lib/agent/placement-audit.test.ts src/lib/agent/spec-audit.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add src/lib/design/placement-report.ts src/lib/design/placement-report.test.ts src/lib/agent/placement-audit.ts src/lib/agent/placement-audit.test.ts src/lib/agent/spec-audit.ts src/lib/agent/graph.ts
git commit -m "feat(agent): floor and contact audit over per-part placement bounds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Wire measurement into validateCode; fix the interference probe

**Files:**
- Modify: `src/lib/agent/graph.ts` — imports (lines 1–21), `AgentState` (lines 336–432), `checkAssemblyFit` (lines 92–130), `validateCode` (lines 684–798)
- Test: `src/lib/agent/graph-placement.test.ts`

**Interfaces:**
- Consumes: `measureModuleFrames` (Task 3), `buildPlacementComponents`, `placementSummary`, `PlacementReport` (Task 4), `auditPlacement` (Task 4), `stripTopLevelGeometry`, `hasGeneratedAssembly`, `analyzeTopLevel` (Task 1).
- Produces: state field `placementReport: PlacementReport | null` (reducer: last write wins, default null). `AgentStateType` gains it automatically. Task 11 replaces the measurement site; Task 7's metrics read `placementReport`.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe('deterministic assembly placement', ...)` in `src/lib/agent/graph-placement.test.ts`:

```ts
  describe('placement measurement (phase 0)', () => {
    it('records each module frame and flags a part hanging below the floor', async () => {
      // Drafter placed the parts itself AND authored the upright hanging downward.
      const authored = `
module base_plate() { cube([40, 40, 5]); }
module upright() { translate([0, 0, -30]) cube([5, 40, 30]); }
base_plate();
translate([0, 0, 5]) upright();
`;
      invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
      invokeMock.mockResolvedValueOnce(draft(authored));
      invokeMock.mockResolvedValue(draft(authored));

      const agent = createCadAgent('k', undefined, 'm');
      const config = { configurable: { thread_id: newKey() } };
      await runApproved(agent, config, 'a 40mm bracket');

      const state = (await agent.getState(config)).values;
      const report = state.placementReport;
      expect(report).not.toBeNull();
      const upright = report.components.find((c: any) => c.name === 'upright');
      expect(upright.measured).toBe(true);
      expect(upright.localMin[2]).toBeCloseTo(-30, 2);

      const kinds = state.specViolations.map((v: any) => v.kind);
      expect(kinds).toContain('floor');
      expect(kinds).toContain('local_frame');
    });

    it('does not report a phantom interference when the drafter placed parts itself', async () => {
      // Parts genuinely clear each other; the model's own top-level union used
      // to be unioned into the probe's intersection() and read as overlap.
      const authored = `
module base() { cube([40, 40, 10]); }
module peg() { cube([10, 10, 10]); }
union() { base(); translate([10, 10, 15]) peg(); }
`;
      invokeMock.mockResolvedValueOnce({
        assemblyName: 'fit', boundingBox: { width: 40, length: 40, height: 25 },
        components: [
          { name: 'base', description: 'base', position: [0, 0, 0] },
          { name: 'peg', description: 'peg', position: [10, 10, 15] },
        ],
        jointContracts: [{ type: 'dowel_stack', clearance: 0.2, partA: 'base', partB: 'peg' }],
        assumptions: [], openQuestions: [],
      });
      invokeMock.mockResolvedValueOnce(draft(authored));
      invokeMock.mockResolvedValue(draft(authored));

      const agent = createCadAgent('k', undefined, 'm');
      const config = { configurable: { thread_id: newKey() } };
      await runApproved(agent, config, 'a 40mm stack');

      const state = (await agent.getState(config)).values;
      expect(state.specViolations.some((v: any) => v.kind === 'interference')).toBe(false);
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/agent/graph-placement.test.ts`
Expected: the first new test fails (`placementReport` undefined); the second fails with an `interference` violation present.

- [ ] **Step 3: Implement**

In `src/lib/agent/graph.ts`:

Replace the import line for compose-assembly with:

```ts
import {
  composeAssembly,
  stripGeneratedAssembly,
  stripTopLevelGeometry,
  hasGeneratedAssembly,
  analyzeTopLevel,
  instantiationFor,
} from '../design/compose-assembly';
import { measureModuleFrames } from '../engine/module-frames';
import { buildPlacementComponents, placementSummary, PlacementReport } from '../design/placement-report';
import { auditPlacement } from './placement-audit';
```

Add to `AgentState` (after `specViolations`):

```ts
  placementReport: Annotation<PlacementReport | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
```

In `checkAssemblyFit`, replace `const modules = stripGeneratedAssembly(code);` with:

```ts
  // Module definitions only. OpenSCAD implicitly unions every top-level object,
  // so any model-written placement left in here would be unioned INTO the
  // probe's intersection() and read as a phantom overlap the size of the part.
  const modules = stripTopLevelGeometry(stripGeneratedAssembly(code)).code;
```

In `validateCode`, after the line `const specViolations = auditSpec(...)` and before the assembly-fit block, insert:

```ts
    // Placement measurement. Each spec component that has a module is compiled
    // alone to read its local frame; floor and contact are judged from those
    // frames and the spec's coordinates. Composition itself is unchanged here.
    let placementReport: PlacementReport | null = null;
    if (state.assemblySpec?.components?.length && state.currentCode) {
      const defined = new Set(analyzeTopLevel(state.currentCode).moduleNames);
      const names = state.assemblySpec.components.map((c) => c.name).filter((n) => defined.has(n));
      const frames = await measureModuleFrames(state.currentCode, names);
      placementReport = {
        composed: hasGeneratedAssembly(state.currentCode),
        removedStatements: 0,
        components: buildPlacementComponents(state.assemblySpec, frames, false),
      };
    }
    const modelMin = validation.summary?.boundingBox?.min ?? modelInfo?.boundingBox.min ?? null;
    specViolations.push(...auditPlacement(placementReport, modelMin, state.assemblySpec));
    if (placementReport || modelMin) {
      onProgress?.({
        type: 'validating',
        message: placementSummary(placementReport, modelMin ? modelMin[2] : null),
        timestamp: Date.now(),
      });
    }
```

In the `return` of `validateCode`, add `placementReport,` next to `specViolations,`.

- [ ] **Step 4: Run the full agent suites**

Run: `npx vitest run src/lib/agent`
Expected: PASS. If `graph-hil.test.ts` counts progress events exactly, the new `validating` event may shift an index; fix by filtering events by `type !== 'validating'` in that assertion, not by removing the event.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/graph.ts src/lib/agent/graph-placement.test.ts
git commit -m "feat(agent): measure module frames and audit floor/contact after every compile

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Park the repair loop and the visual critic

**Files:**
- Modify: `src/lib/agent/graph.ts:388-391` (`maxAttempts` default), `src/lib/agent/graph.ts:974` (`visualCritic` guard)
- Modify: `.env.example`
- Modify: `src/lib/agent/graph-hil.test.ts`, `src/lib/agent/graph-critic.test.ts`, `src/lib/agent/graph-placement.test.ts` (env in hooks)

**Interfaces:** none new. Env contract: `CADAI_MAX_ATTEMPTS` default `1`; `CADAI_VISUAL_CRITIC` runs only when `'on'`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/agent/graph-placement.test.ts` inside the top-level describe:

```ts
  it('does not repair automatically by default (repair loop is parked)', async () => {
    const saved = process.env.CADAI_MAX_ATTEMPTS;
    delete process.env.CADAI_MAX_ATTEMPTS;
    try {
      invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
      invokeMock.mockResolvedValueOnce(draft('module base_plate() { cube([40,40,5); }'));
      invokeMock.mockResolvedValue(draft(MODULES_ONLY));

      const agent = createCadAgent('k', undefined, 'm');
      const config = { configurable: { thread_id: newKey() } };
      const result = await runApproved(agent, config, 'a 40mm bracket');

      // One draft, no repair: the run pauses at the accept gate for a human.
      const state = (await agent.getState(config)).values;
      expect(state.attemptCount).toBe(1);
      expect(isInterrupted(result)).toBe(true);
    } finally {
      if (saved !== undefined) process.env.CADAI_MAX_ATTEMPTS = saved;
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/agent/graph-placement.test.ts -t "parked"`
Expected: FAIL (`attemptCount` is 2 or 3).

- [ ] **Step 3: Implement**

In `src/lib/agent/graph.ts` change the `maxAttempts` default to:

```ts
    // Parked: automatic repair is off by default while generation quality is
    // the focus. A human can still ask for a revision at the accept gate.
    default: () => Number(process.env.CADAI_MAX_ATTEMPTS ?? 1),
```

Change the first line of `visualCritic` to:

```ts
    if (process.env.CADAI_VISUAL_CRITIC !== 'on') return {};
```

In `.env.example` replace the `CADAI_MAX_ATTEMPTS` and `CADAI_VISUAL_CRITIC` blocks with:

```
# Optional: agent tuning
# Total LLM passes per run (1 draft + N repairs). Default 1: automatic repair is
# parked while first-draft generation quality is being measured. Set 3 to
# re-enable the repair loop.
CADAI_MAX_ATTEMPTS=1
# The Design Inspector renders the compiled part from 4 angles and asks a
# multimodal model whether it LOOKS like what was requested. Parked: off unless
# set to "on".
CADAI_VISUAL_CRITIC=off
```

Keep existing suites on their previous behaviour by setting env in their hooks:

- `src/lib/agent/graph-placement.test.ts`: in the existing `beforeEach` (the one that sets `CADAI_VISUAL_CRITIC = 'off'`) add `process.env.CADAI_MAX_ATTEMPTS = '3';`. In `afterAll` add `delete process.env.CADAI_MAX_ATTEMPTS;`.
- `src/lib/agent/graph-hil.test.ts`: in the `beforeEach` at line 103 add `process.env.CADAI_MAX_ATTEMPTS = '3';`; in the `afterAll` at line 108 add `delete process.env.CADAI_MAX_ATTEMPTS;`.
- `src/lib/agent/graph-critic.test.ts`: in the `beforeEach` at line 70 add `process.env.CADAI_VISUAL_CRITIC = 'on'; process.env.CADAI_MAX_ATTEMPTS = '3';`. The test near line 174 that sets `'off'` for one case stays as is. In the `afterAll` at line 40 add `delete process.env.CADAI_MAX_ATTEMPTS;` (it already deletes `CADAI_VISUAL_CRITIC` at line 72 — keep that).

- [ ] **Step 4: Run all agent suites**

Run: `npx vitest run src/lib/agent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/graph.ts .env.example src/lib/agent/graph-hil.test.ts src/lib/agent/graph-critic.test.ts src/lib/agent/graph-placement.test.ts
git commit -m "chore(agent): park automatic repair and the visual critic behind env flags

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Generation eval harness with Langfuse scoring, then the baseline run

**Files:**
- Create: `eval/generation/prompts.json`, `eval/generation/metrics.ts`, `eval/generation/metrics.test.ts`, `eval/generation/run.ts`
- Modify: `package.json` (scripts + devDependencies), `.gitignore`, `README.md`

**Interfaces:**
- Consumes: `createCadAgent`, `AgentStateType` from `@/lib/agent/graph`; `runCheckpointKey`, `getCheckpointer` from `@/lib/agent/checkpointer`; `getLangfuseCallbackHandler`, `getLangfuseSpanProcessor` from `@/lib/tracing/langfuse`; `placementReport` state (Task 5).
- Produces:
  - `export interface GenerationMetrics { id: string; model: string; specOk: boolean; composed: boolean; compileOk: boolean; floorOk: boolean | null; floatingCount: number | null; localFrameOk: boolean | null; extentsOk: boolean | null; shellsOk: boolean | null; errorKinds: string[]; attempts: number; wallMs: number }`
  - `export function metricsFromState(id: string, model: string, state: Partial<AgentStateType>, wallMs: number): GenerationMetrics`
  - `export function summarize(rows: GenerationMetrics[]): Record<string, string>` — e.g. `{ composed: '3/10', floorOk: '1/10', ... }` where the denominator excludes nulls.
  - `export function scoresFor(m: GenerationMetrics): Array<{ name: string; value: number; dataType: 'BOOLEAN' | 'NUMERIC' }>`
  - npm script `eval:generation`; CLI flags `--model <slug>` (default `deepseek-v4-flash`), `--tag <name>` (default `run`), `--limit <n>`, `--no-langfuse`, `--seed-dataset`.

- [ ] **Step 1: Install dependencies**

```bash
npm install --save-dev tsx@4 @langfuse/client@5.11.1
```

Expected: `package.json` devDependencies gain both; `package-lock.json` updates. (`tsx` was previously only reachable through the npx cache; `npm run mcp` already depends on it.)

- [ ] **Step 2: Add the prompt set**

Create `eval/generation/prompts.json`:

```json
[
  { "id": "laptop_stand_30", "prompt": "Create a laptop stand with a 30 degree tilt: two side supports and a cross bar joining them at the rear." },
  { "id": "hair_dryer_holder", "prompt": "A wall-mounted hair dryer holder: a backplate with two screw holes and a cup ring of 90 mm inner diameter attached to it." },
  { "id": "cable_clip", "prompt": "A desk cable clip: a base plate 40 x 20 mm with a snap-on clip arm that holds a 6 mm cable." },
  { "id": "hinged_box", "prompt": "A two-part box 80 x 60 x 40 mm with a separate lid that sits on top of the body." },
  { "id": "pen_holder", "prompt": "A pen holder: a square base 80 x 80 mm with four upright tubes of 20 mm inner diameter, 100 mm tall, standing on the base." },
  { "id": "phone_stand", "prompt": "A phone stand with a flat base plate and a backrest leaning at 65 degrees that slots into the base." },
  { "id": "shelf_bracket", "prompt": "A shelf bracket: a 150 mm wall plate, a 150 mm shelf arm at right angles to it, and a diagonal gusset between them." },
  { "id": "pi_case", "prompt": "A Raspberry Pi 4 case: a bottom tray with four standoffs and a lid that sits on the tray." },
  { "id": "spool_holder", "prompt": "A filament spool holder: two A-frame end supports joined by a 60 mm long axle rod of 20 mm diameter." },
  { "id": "drawer_unit", "prompt": "A small desk drawer unit: an outer shell 100 x 80 x 60 mm and a sliding drawer with a pull tab that fits inside it." }
]
```

- [ ] **Step 3: Write the failing metrics test**

Create `eval/generation/metrics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { metricsFromState, summarize, scoresFor } from './metrics';

const violation = (kind: string, severity: 'error' | 'warning' = 'error') =>
  ({ kind, severity, field: '', expected: '', measured: '', message: '' }) as any;

describe('metricsFromState', () => {
  it('reads composition, floor, floating and local-frame from state', () => {
    const m = metricsFromState('p1', 'deepseek-v4-flash', {
      assemblySpec: { assemblyName: 'a', boundingBox: { width: 1, length: 1, height: 1 }, components: [{ name: 'x', description: '' }] } as any,
      currentCode: 'module x() {}',
      isValid: false,
      attemptCount: 1,
      validation: { valid: true } as any,
      modelInfo: { boundingBox: { min: [0, 0, -5], max: [1, 1, 1] } } as any,
      specViolations: [violation('floor'), violation('floating'), violation('local_frame', 'warning')],
      placementReport: {
        composed: true, removedStatements: 2,
        components: [{ name: 'x', measured: true, localMin: [0, 0, -5], localMax: [1, 1, 1], size: [1, 1, 6], correction: [0, 0, 5], position: [0, 0, 0], rotation: [0, 0, 0], placedMin: [0, 0, 0], placedMax: [1, 1, 6] }],
      },
    }, 1234);
    expect(m).toMatchObject({
      id: 'p1', specOk: true, composed: true, compileOk: true, floorOk: false,
      floatingCount: 1, localFrameOk: false, shellsOk: true, attempts: 1, wallMs: 1234,
    });
    expect(m.errorKinds).toEqual(['floor', 'floating']);
  });

  it('returns nulls for measurements that could not be taken', () => {
    const m = metricsFromState('p2', 'm', { assemblySpec: null, currentCode: '', isValid: false, attemptCount: 0, validation: null, modelInfo: null, specViolations: [], placementReport: null }, 1);
    expect(m.specOk).toBe(false);
    expect(m.compileOk).toBe(false);
    expect(m.floorOk).toBeNull();
    expect(m.floatingCount).toBeNull();
    expect(m.localFrameOk).toBeNull();
  });
});

describe('summarize', () => {
  it('reports rates over non-null values', () => {
    const rows = [
      { id: 'a', model: 'm', specOk: true, composed: true, compileOk: true, floorOk: true, floatingCount: 0, localFrameOk: true, extentsOk: null, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 10 },
      { id: 'b', model: 'm', specOk: true, composed: false, compileOk: true, floorOk: false, floatingCount: null, localFrameOk: null, extentsOk: null, shellsOk: false, errorKinds: ['floor'], attempts: 1, wallMs: 20 },
    ];
    const s = summarize(rows);
    expect(s.composed).toBe('1/2');
    expect(s.floorOk).toBe('1/2');
    expect(s.noFloating).toBe('1/1');
    expect(s.localFrameOk).toBe('1/1');
    expect(s.extentsOk).toBe('0/0');
    expect(s.meanWallMs).toBe('15');
  });
});

describe('scoresFor', () => {
  it('emits boolean scores and skips unmeasured ones', () => {
    const names = scoresFor({ id: 'a', model: 'm', specOk: true, composed: true, compileOk: true, floorOk: null, floatingCount: null, localFrameOk: true, extentsOk: null, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 10 }).map((s) => s.name);
    expect(names).toEqual(['spec_ok', 'composed', 'compile_ok', 'local_frame_ok', 'shells_ok', 'wall_ms']);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run eval/generation/metrics.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement metrics**

Create `eval/generation/metrics.ts`:

```ts
import type { AgentStateType } from '@/lib/agent/graph';
import { isZeroVec } from '@/lib/design/placement-geometry';

export interface GenerationMetrics {
  id: string;
  model: string;
  specOk: boolean;
  composed: boolean;
  compileOk: boolean;
  floorOk: boolean | null;
  floatingCount: number | null;
  localFrameOk: boolean | null;
  extentsOk: boolean | null;
  shellsOk: boolean | null;
  errorKinds: string[];
  attempts: number;
  wallMs: number;
}

export function metricsFromState(
  id: string,
  model: string,
  state: Partial<AgentStateType>,
  wallMs: number
): GenerationMetrics {
  const violations = state.specViolations ?? [];
  const errors = violations.filter((v) => v.severity === 'error');
  const has = (kind: string) => errors.some((v) => v.kind === kind);
  const report = state.placementReport ?? null;
  const measured = report?.components.filter((c) => c.measured) ?? [];
  const hasModel = !!state.modelInfo;
  const specHasExtents = !!state.assemblySpec?.components?.some((c) => (c as { localExtents?: unknown }).localExtents);

  return {
    id,
    model,
    specOk: !!state.assemblySpec,
    composed: report?.composed ?? false,
    compileOk: !!state.validation?.valid,
    floorOk: hasModel ? !has('floor') : null,
    floatingCount: report?.composed ? errors.filter((v) => v.kind === 'floating').length : null,
    localFrameOk: measured.length ? measured.every((c) => isZeroVec(c.localMin)) : null,
    extentsOk: specHasExtents && measured.length ? !has('extents') : null,
    shellsOk: hasModel ? !has('shells') : null,
    errorKinds: [...new Set(errors.map((v) => v.kind))],
    attempts: state.attemptCount ?? 0,
    wallMs,
  };
}

function rate(rows: GenerationMetrics[], pick: (m: GenerationMetrics) => boolean | null): string {
  const vals = rows.map(pick).filter((v): v is boolean => v !== null);
  return `${vals.filter(Boolean).length}/${vals.length}`;
}

export function summarize(rows: GenerationMetrics[]): Record<string, string> {
  const mean = rows.length ? Math.round(rows.reduce((a, m) => a + m.wallMs, 0) / rows.length) : 0;
  return {
    n: String(rows.length),
    specOk: rate(rows, (m) => m.specOk),
    composed: rate(rows, (m) => m.composed),
    compileOk: rate(rows, (m) => m.compileOk),
    floorOk: rate(rows, (m) => m.floorOk),
    noFloating: rate(rows, (m) => (m.floatingCount === null ? null : m.floatingCount === 0)),
    localFrameOk: rate(rows, (m) => m.localFrameOk),
    extentsOk: rate(rows, (m) => m.extentsOk),
    shellsOk: rate(rows, (m) => m.shellsOk),
    meanWallMs: String(mean),
  };
}

export function scoresFor(m: GenerationMetrics): Array<{ name: string; value: number; dataType: 'BOOLEAN' | 'NUMERIC' }> {
  const out: Array<{ name: string; value: number; dataType: 'BOOLEAN' | 'NUMERIC' }> = [];
  const bool = (name: string, v: boolean | null) => {
    if (v !== null) out.push({ name, value: v ? 1 : 0, dataType: 'BOOLEAN' });
  };
  bool('spec_ok', m.specOk);
  bool('composed', m.composed);
  bool('compile_ok', m.compileOk);
  bool('floor_ok', m.floorOk);
  if (m.floatingCount !== null) out.push({ name: 'floating_count', value: m.floatingCount, dataType: 'NUMERIC' });
  bool('local_frame_ok', m.localFrameOk);
  bool('extents_ok', m.extentsOk);
  bool('shells_ok', m.shellsOk);
  out.push({ name: 'wall_ms', value: m.wallMs, dataType: 'NUMERIC' });
  return out;
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run eval/generation/metrics.test.ts`
Expected: PASS.

- [ ] **Step 7: Implement the runner**

Create `eval/generation/run.ts`:

```ts
/**
 * Generation eval: runs each prompt through the real agent graph with gates
 * auto-approved and automatic repair off, then reports first-draft quality.
 *
 *   npm run eval:generation -- --model deepseek-v4-flash --tag baseline
 *   npm run eval:generation -- --seed-dataset          # once, creates the Langfuse dataset
 *   npm run eval:generation -- --no-langfuse --limit 2 # local only
 *
 * Results land in eval/results/<tag>-<model>-<timestamp>.json and, when
 * LANGFUSE_* keys are set, as a Langfuse experiment run on dataset
 * "cadai-generation" with one score per metric.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { HumanMessage } from '@langchain/core/messages';
import { Command, isInterrupted } from '@langchain/langgraph';

for (const f of ['.env', '.env.local']) {
  try { process.loadEnvFile(f); } catch { /* absent is fine */ }
}
// Eval defaults: no automatic repair, no critic. Explicit env still wins.
process.env.CADAI_MAX_ATTEMPTS ??= '1';
process.env.CADAI_VISUAL_CRITIC ??= 'off';

import { createCadAgent, type AgentStateType } from '@/lib/agent/graph';
import { getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor } from '@/lib/tracing/langfuse';
import { GenerationMetrics, metricsFromState, scoresFor, summarize } from './metrics';

const DATASET = 'cadai-generation';

interface Args { model: string; tag: string; limit: number; langfuse: boolean; seed: boolean }
function parseArgs(argv: string[]): Args {
  const a: Args = { model: 'deepseek-v4-flash', tag: 'run', limit: Infinity, langfuse: true, seed: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--model') a.model = argv[++i];
    else if (v === '--tag') a.tag = argv[++i];
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v === '--no-langfuse') a.langfuse = false;
    else if (v === '--seed-dataset') a.seed = true;
  }
  return a;
}

interface PromptItem { id: string; prompt: string }
const prompts: PromptItem[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'));

function gitSha(): string {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'unknown'; }
}

async function runOne(item: PromptItem, args: Args): Promise<GenerationMetrics> {
  const handler = getLangfuseCallbackHandler({
    tags: ['cadai', 'eval', args.model],
    metadata: { model: args.model, tag: args.tag, promptId: item.id },
  });
  const agent = createCadAgent(undefined, undefined, args.model);
  const key = runCheckpointKey(`eval-${args.tag}`, `${item.id}-${Date.now()}`);
  const config = { configurable: { thread_id: key }, callbacks: handler ? [handler] : undefined };

  const t0 = Date.now();
  let result = await agent.invoke({ messages: [new HumanMessage(item.prompt)] }, config);
  for (let i = 0; i < 4 && isInterrupted(result); i++) {
    result = await agent.invoke(new Command({ resume: { action: 'approve' } }), config);
  }
  const state = (await agent.getState(config)).values as AgentStateType;
  await getCheckpointer().deleteThread(key);

  const m = metricsFromState(item.id, args.model, state, Date.now() - t0);
  console.log(`${item.id}: composed=${m.composed} floor=${m.floorOk} floating=${m.floatingCount} localFrame=${m.localFrameOk} errors=[${m.errorKinds.join(',')}] ${m.wallMs} ms`);
  return m;
}

async function seedDataset(): Promise<void> {
  const { LangfuseClient } = await import('@langfuse/client');
  const langfuse = new LangfuseClient();
  try {
    await langfuse.api.datasets.create({ name: DATASET, description: 'Multi-part prompts for first-draft generation quality.' });
  } catch (e) {
    console.log(`dataset ${DATASET} exists or could not be created: ${(e as Error).message}`);
  }
  for (const p of prompts) {
    // A fixed id makes this an upsert, so re-seeding never duplicates items.
    await langfuse.api.datasetItems.create({ datasetName: DATASET, id: `cadai-gen-${p.id}`, input: p });
  }
  console.log(`seeded ${prompts.length} items into ${DATASET}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keysPresent = !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
  const useLangfuse = args.langfuse && keysPresent;
  if (args.langfuse && !keysPresent) console.log('LANGFUSE_* keys not set: running locally only.');

  if (args.seed) {
    if (!keysPresent) throw new Error('--seed-dataset needs LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
    await seedDataset();
    return;
  }

  const items = prompts.slice(0, args.limit);
  console.log(`Eval: ${items.length} prompt(s) on ${args.model}, tag "${args.tag}". ` +
    `Expect roughly ${items.length * 2}-${items.length * 5} model calls (architect retries + drafter tool round). Starting in 5 s, Ctrl+C to abort.`);
  await new Promise((r) => setTimeout(r, 5000));

  let rows: GenerationMetrics[] = [];
  if (useLangfuse) {
    const { LangfuseClient } = await import('@langfuse/client');
    const langfuse = new LangfuseClient();
    const dataset = await langfuse.dataset.get(DATASET);
    const wanted = new Set(items.map((p) => p.id));
    const data = dataset.items.filter((it) => wanted.has((it.input as PromptItem).id));
    const result = await dataset.runExperiment({
      name: 'cadai-generation',
      runName: `${args.tag}-${args.model}-${new Date().toISOString().slice(0, 16)}`,
      metadata: { model: args.model, tag: args.tag, gitSha: gitSha() },
      data,
      // One at a time: each run drives a wasm compiler and spends model quota.
      maxConcurrency: 1,
      task: async ({ input }) => runOne(input as PromptItem, args),
      evaluators: [async ({ output }) => scoresFor(output as GenerationMetrics)],
    } as Parameters<typeof dataset.runExperiment>[0]);
    rows = result.itemResults.map((r) => r.output as GenerationMetrics);
    await langfuse.flush();
    if (result.datasetRunUrl) console.log(`Langfuse run: ${result.datasetRunUrl}`);
  } else {
    for (const item of items) rows.push(await runOne(item, args));
  }

  const summary = summarize(rows);
  console.table(summary);
  const outDir = path.join(__dirname, '..', 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${args.tag}-${args.model}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ args, gitSha: gitSha(), summary, rows }, null, 2));
  console.log(`wrote ${file}`);

  await getLangfuseSpanProcessor()?.forceFlush();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

If `tsc` complains about `process.loadEnvFile`, add `// @ts-expect-error Node 20.12+ API` above that line (the runtime is Node 24).

- [ ] **Step 8: Register the script and ignore results**

In `package.json` scripts add:

```json
    "eval:generation": "tsx eval/generation/run.ts"
```

Append to `.gitignore`:

```
# generation eval outputs
/eval/results/
```

Append to `README.md`:

```markdown
## Evaluating generation quality

`npm run eval:generation -- --model deepseek-v4-flash --tag baseline` runs the prompts in
`eval/generation/prompts.json` through the real agent graph (spec and accept gates
auto-approved, automatic repair off) and prints first-draft rates: spec produced,
placement composed from the spec, compiled, lowest point on the floor, no floating
parts, module origins correct, extents matching. Results are written to
`eval/results/` and, when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set, recorded
as a Langfuse experiment run on the `cadai-generation` dataset with one score per metric
(seed the dataset once with `--seed-dataset`). Each run costs roughly 2 to 5 model calls
per prompt. Use `--limit 2 --no-langfuse` for a quick local smoke test.
```

- [ ] **Step 9: Smoke-test the harness without spending quota**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `npm run eval:generation -- --limit 0 --no-langfuse`
Expected: prints the "Eval: 0 prompt(s)" line, waits 5 s, prints an all-zero summary table and writes a results file. Delete that file afterwards (`eval/results/` is ignored anyway).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json .gitignore README.md eval/generation/prompts.json eval/generation/metrics.ts eval/generation/metrics.test.ts eval/generation/run.ts
git commit -m "feat(eval): generation eval harness with Langfuse experiment scoring

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 11: CHECKPOINT — run the baseline (spends model quota; confirm with the user first)**

Tell the user: "Baseline eval: 10 prompts on deepseek-v4-flash, roughly 20 to 50 model calls. Proceed?" Only after a yes:

```bash
npm run eval:generation -- --seed-dataset
npm run eval:generation -- --model deepseek-v4-flash --tag baseline
```

Record the printed summary table in `docs/superpowers/plans/2026-09-14-deterministic-placement-generation-eval.md` under a new heading `## Baseline (Phase 0)` at the end of the file, and commit that edit:

```bash
git add docs/superpowers/plans/2026-09-14-deterministic-placement-generation-eval.md
git commit -m "docs(eval): record generation baseline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 1 — Generation fixes

### Task 8: Spec schema — localExtents, positionNote, required placement, snake_case normalisation

**Files:**
- Modify: `src/lib/agent/assembly-spec.ts` (components object at lines 88–115; `assemblySpecRequestSchema` at lines 166–170)
- Create: `src/lib/agent/spec-normalize.ts`
- Modify: `src/lib/agent/placement-audit.ts` (extents rule)
- Test: `src/lib/agent/assembly-spec.test.ts`, `src/lib/agent/spec-normalize.test.ts`, `src/lib/agent/placement-audit.test.ts`

**Interfaces:**
- Produces:
  - Component fields: `form?: 'box' | 'cylinder' | 'profile_extrude' | 'revolve' | 'shell' | 'other'`, `localExtents?: [x, y, z]`, `positionNote?: string`, `useModules?: string[]`. Component `dimensions` is removed (joint `dimensions` stays).
  - Request schema marks `position` and `localExtents` required on components; zod validation still accepts their absence.
  - `export function toSnakeCase(name: string): string`
  - `export function normalizeSpec(spec: AssemblySpec): AssemblySpec` — snake_case component names (renaming references in jointContracts, edgeTreatments, stressPoints), `position` defaulted to `[0,0,0]`, unknown `useModules` keys dropped, duplicate names suffixed `_2`, `_3`.
  - `auditPlacement` adds kind `extents` (error when the per-axis delta exceeds 1.0 mm on an approved spec, or 5 mm and 20 % otherwise; warning when over 1.0 mm but within the unapproved band).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/agent/assembly-spec.test.ts`:

```ts
describe('placement and extents fields', () => {
  it('accepts form, localExtents, positionNote and useModules, and tolerates their absence', () => {
    const spec = AssemblySpecSchema.parse({
      ...minimal,
      components: [
        { name: 'base', description: 'b', form: 'box', localExtents: [40, 30, 6], position: [0, 0, 0] },
        { name: 'arm', description: 'a', localExtents: [6, 30, 25], position: [0, 0, 6], positionNote: 'z = top of base (localExtents z = 6)', useModules: ['structural_ribs_gussets'] },
      ],
    });
    expect(spec.components?.[0].form).toBe('box');
    expect(spec.components?.[1].positionNote).toContain('top of base');
    expect(AssemblySpecSchema.safeParse(minimal).success).toBe(true);
  });

  it('marks position and localExtents required in the REQUEST schema only', () => {
    const json = assemblySpecRequestSchema() as any;
    const items = json.properties.components.items;
    expect(items.required).toEqual(expect.arrayContaining(['name', 'description', 'position', 'localExtents']));
    // Validation stays lenient: a component without them still parses.
    expect(AssemblySpecSchema.safeParse(minimal).success).toBe(true);
  });

  it('no longer carries a dimensions object on components', () => {
    const json = assemblySpecRequestSchema() as any;
    expect(json.properties.components.items.properties.dimensions).toBeUndefined();
    expect(json.properties.jointContracts.items.properties.dimensions).toBeDefined();
  });
});
```

Create `src/lib/agent/spec-normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeSpec, toSnakeCase } from './spec-normalize';
import { AssemblySpecSchema } from './assembly-spec';

describe('toSnakeCase', () => {
  it('turns free-text names into valid module identifiers', () => {
    expect(toSnakeCase('Wall Mount Backplate')).toBe('wall_mount_backplate');
    expect(toSnakeCase('Cup Receptacle (88mm)')).toBe('cup_receptacle_88mm');
    expect(toSnakeCase('laptopCradle')).toBe('laptop_cradle');
    expect(toSnakeCase('base_plate')).toBe('base_plate');
    expect(toSnakeCase('2nd tier')).toBe('part_2nd_tier');
  });
});

describe('normalizeSpec', () => {
  it('renames components and every reference to them, defaults position, drops unknown modules', () => {
    const spec = AssemblySpecSchema.parse({
      assemblyName: 'holder',
      boundingBox: { width: 100, length: 120, height: 80 },
      components: [
        { name: 'Wall Mount Backplate', description: 'b', useModules: ['fastener_hardware', 'nope'] },
        { name: 'Cup Receptacle', description: 'c', position: [0, 5, 0] },
      ],
      jointContracts: [{ type: 'cantilever_gusset', clearance: 0, partA: 'Wall Mount Backplate', partB: 'Cup Receptacle' }],
      edgeTreatments: [{ component: 'Cup Receptacle', location: 'rim', category: 'printability', kind: 'chamfer', sizeMm: 0.4 }],
      stressPoints: [{ component: 'Wall Mount Backplate', location: 'screw holes', loadCase: '20 N', risk: 'low', mitigation: 'none' }],
    });
    const n = normalizeSpec(spec);
    expect(n.components?.map((c) => c.name)).toEqual(['wall_mount_backplate', 'cup_receptacle']);
    expect(n.components?.[0].position).toEqual([0, 0, 0]);
    expect(n.components?.[0].useModules).toEqual(['fastener_hardware']);
    expect(n.components?.[1].position).toEqual([0, 5, 0]);
    expect(n.jointContracts?.[0]).toMatchObject({ partA: 'wall_mount_backplate', partB: 'cup_receptacle' });
    expect(n.edgeTreatments[0].component).toBe('cup_receptacle');
    expect(n.stressPoints[0].component).toBe('wall_mount_backplate');
  });

  it('keeps names unique after normalisation', () => {
    const spec = AssemblySpecSchema.parse({
      assemblyName: 'x', boundingBox: { width: 1, length: 1, height: 1 },
      components: [{ name: 'Leg', description: '' }, { name: 'leg', description: '' }, { name: 'LEG', description: '' }],
    });
    expect(normalizeSpec(spec).components?.map((c) => c.name)).toEqual(['leg', 'leg_2', 'leg_3']);
  });
});
```

Append to `src/lib/agent/placement-audit.test.ts`:

```ts
describe('extents', () => {
  const specWith = (approved: boolean) => ({
    assemblyName: 't', boundingBox: { width: 1, length: 1, height: 1 },
    components: [{ name: 'base', description: '', localExtents: [40, 40, 10] }],
    edgeTreatments: [], stressPoints: [], assumptions: [], openQuestions: [],
    ...(approved ? { specApprovedAt: 1 } : {}),
  }) as any;
  const measuredBase = (size: [number, number, number]) =>
    report([{ ...part('base', [0, 0, 0], [size[0], size[1], size[2]]), size }]);

  it('is silent when the measured size matches', () => {
    expect(auditPlacement(measuredBase([40, 40, 10]), [0, 0, 0], specWith(true))).toEqual([]);
  });

  it('errors on an approved spec past 1 mm and warns on an unapproved one within the loose band', () => {
    expect(kinds(auditPlacement(measuredBase([40, 40, 12]), [0, 0, 0], specWith(true)))).toEqual(['error:extents']);
    expect(kinds(auditPlacement(measuredBase([40, 40, 12]), [0, 0, 0], specWith(false)))).toEqual(['warning:extents']);
    expect(kinds(auditPlacement(measuredBase([40, 40, 20]), [0, 0, 0], specWith(false)))).toEqual(['error:extents']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/agent/assembly-spec.test.ts src/lib/agent/spec-normalize.test.ts src/lib/agent/placement-audit.test.ts`
Expected: FAIL (unknown fields stripped, module not found, no extents violations).

- [ ] **Step 3: Implement the schema**

In `src/lib/agent/assembly-spec.ts`, replace the `components:` entry of `AssemblySpecSchema` with:

```ts
  components: z.array(z.object({
    /** snake_case; becomes `module <name>()` verbatim. Normalised after parsing by spec-normalize.ts. */
    name: z.string(),
    description: z.string(),
    /** Dominant construction of the part; a hint for the drafter, not a constraint. */
    form: z.enum(['box', 'cylinder', 'profile_extrude', 'revolve', 'shell', 'other']).optional(),
    /**
     * The module's exact size in its own frame, [x, y, z] mm. Required in the
     * request schema; measured after every compile and audited as `extents`.
     * Replaces the old optional length/width/height/depth object, which never
     * said which axis was which.
     */
    localExtents: Vec3.optional(),
    /**
     * Where this component's local origin (its min corner) lands in assembly
     * coordinates, in mm, ALWAYS in the assembled pose. Required in the request
     * schema; defaults to the origin on validation. Emitted as translate() by
     * deterministic code rather than written by the model.
     */
    position: Vec3.optional(),
    /** Rotation about the component's own origin, in degrees [X, Y, Z]. */
    rotation: Vec3.optional(),
    /**
     * One line deriving the non-zero coordinates from other components, e.g.
     * "z = top of base_plate (localExtents z = 6.4)". Emitted as the comment on
     * the generated placement parameter so a later parametric rewrite is a
     * one-token edit.
     */
    positionNote: z.string().optional(),
    /** Engineering registry keys the drafter must fetch for this part. */
    useModules: z.array(z.string()).optional(),
    bedFace: BedFaceSchema.optional(),
    matingFaces: z.array(z.string()).optional(),
  })).optional(),
```

Replace `assemblySpecRequestSchema` with:

```ts
/** Adds fields to a component's `required` list in the REQUEST schema only. */
function requireComponentFields(json: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const props = json.properties as Record<string, any> | undefined;
  const items = props?.components?.items;
  if (!items?.properties) return json;
  items.required = [...new Set<string>([...(items.required ?? []), ...fields])];
  return json;
}

export function assemblySpecRequestSchema(): Record<string, unknown> {
  const json = z.toJSONSchema(AssemblySpecSchema) as Record<string, unknown>;
  delete json.$schema;
  // The decoder must emit a placement and extents for every component; the
  // zod schema stays lenient so a model that still omits them degrades to
  // [0,0,0] / unmeasured instead of failing the whole spec.
  return boundNumbers(requireComponentFields(json, ['position', 'localExtents'])) as Record<string, unknown>;
}
```

- [ ] **Step 4: Implement normalisation**

Create `src/lib/agent/spec-normalize.ts`:

```ts
import type { AssemblySpec } from './assembly-spec';
import { ENGINEERING_MODULE_REGISTRY } from './engineering-tools';

/** "Wall Mount Backplate" -> "wall_mount_backplate"; always a valid OpenSCAD identifier. */
export function toSnakeCase(name: string): string {
  const s = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  if (!s) return 'part';
  return /^[a-z]/.test(s) ? s : `part_${s}`;
}

/**
 * Makes a parsed spec usable by deterministic code: component names become
 * module identifiers (with every reference renamed to match), every component
 * has a position, and useModules only names registry keys that exist. Applied
 * to what the Architect returns and to what the client sends back from the
 * spec gate, so downstream code never sees "Cup Receptacle".
 */
export function normalizeSpec(spec: AssemblySpec): AssemblySpec {
  const rename = new Map<string, string>();
  const used = new Set<string>();

  const components = (spec.components ?? []).map((c) => {
    const base = toSnakeCase(c.name);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    rename.set(c.name, name);
    return {
      ...c,
      name,
      position: c.position ?? [0, 0, 0],
      useModules: c.useModules?.filter((k) => k in ENGINEERING_MODULE_REGISTRY),
    };
  });

  const ref = (x?: string) => (x === undefined ? undefined : rename.get(x) ?? x);

  return {
    ...spec,
    components,
    jointContracts: spec.jointContracts?.map((j) => ({ ...j, partA: ref(j.partA), partB: ref(j.partB) })),
    edgeTreatments: spec.edgeTreatments.map((e) => ({ ...e, component: ref(e.component) })),
    stressPoints: spec.stressPoints.map((s) => ({ ...s, component: ref(s.component) })),
  };
}
```

- [ ] **Step 5: Add the extents rule**

In `src/lib/agent/placement-audit.ts`, delete the `void spec;` line and insert before `if (!report) return violations;`:

```ts
  if (report && spec?.components) {
    const approved = !!spec.specApprovedAt;
    const absTol = approved ? 1.0 : 5.0;
    const byName = new Map(report.components.map((c) => [c.name, c]));
    for (const sc of spec.components) {
      const ext = sc.localExtents as Vec3 | undefined;
      const c = byName.get(sc.name);
      if (!ext || !c?.measured) continue;
      (['x', 'y', 'z'] as const).forEach((axis, i) => {
        const delta = Math.abs(ext[i] - c.size[i]);
        if (delta <= 1.0) return;
        const relative = ext[i] > 0 ? delta / ext[i] : Infinity;
        const gross = approved || delta > absTol || relative > 0.2;
        violations.push({
          kind: 'extents',
          field: `${sc.name}.${axis}`,
          expected: ext[i],
          measured: c.size[i],
          deltaMm: Math.round(delta * 100) / 100,
          tolerance: approved ? 1.0 : absTol,
          severity: gross ? 'error' : 'warning',
          message:
            `module ${sc.name}() measures ${c.size[i]} mm along ${axis} but the spec's localExtents say ${ext[i]} mm ` +
            `(delta ${delta.toFixed(2)} mm). Resize the module; do not move it.`,
        });
      });
    }
  }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/agent/assembly-spec.test.ts src/lib/agent/spec-normalize.test.ts src/lib/agent/placement-audit.test.ts src/lib/agent/graph-hil.test.ts`
Expected: PASS. Then `npx tsc --noEmit -p tsconfig.json` — expected clean (nothing else read `component.dimensions`; if the compiler finds a reader, delete that read).

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent/assembly-spec.ts src/lib/agent/assembly-spec.test.ts src/lib/agent/spec-normalize.ts src/lib/agent/spec-normalize.test.ts src/lib/agent/placement-audit.ts src/lib/agent/placement-audit.test.ts
git commit -m "feat(agent): localExtents, positionNote, required placement and snake_case spec normalisation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Composer v2 — enforce, correct, and keep parametric intent

**Files:**
- Modify: `src/lib/design/compose-assembly.ts` (`ComposeSkipReason`, `ComposeResult`, `composeAssembly`, `instantiationFor`)
- Test: `src/lib/design/compose-assembly.test.ts`

**Interfaces:**
- Consumes: `ModuleFrame` (Task 3), `buildPlacementComponents`, `PlacementReport`, `PlacementComponent` (Task 4), `isZeroVec`, `Vec3` (Task 2).
- Produces:
  - `export type ComposeSkipReason = 'no_spec' | 'missing_modules'`
  - `export interface ComposeResult { code: string; composed: boolean; reason?: ComposeSkipReason; missing?: string[]; report: PlacementReport | null }`
  - `export function composeAssembly(code: string, spec: AssemblySpec | null, frames?: ModuleFrame[]): ComposeResult` — strips model top-level geometry, emits `/* [Assembly Placement] */` params `<name>_pos_<axis> = v;` for non-zero axes (first one carries `// <positionNote>`), and the call `translate([...]) rotate([...]) translate(correction) name();`.
  - `export function instantiationFor(spec: AssemblySpec, componentName: string, frames?: ModuleFrame[]): string | null` — same transform with literals, for the probe.
  - `stripGeneratedAssembly` unchanged.

- [ ] **Step 1: Update the tests**

In `src/lib/design/compose-assembly.test.ts`, replace the tests `'leaves the model in charge when it wrote its own assembly'` and `'declines when no component declares a placement'` with:

```ts
  it('strips a model-written assembly and places from the spec instead', () => {
    const authored = `${MODULES}\nunion() { base_plate(); translate([0,0,99]) upright(); }`;
    const result = composeAssembly(
      authored,
      spec([
        { name: 'base_plate', description: 'b', position: [0, 0, 0] },
        { name: 'upright', description: 'u', position: [0, 0, 6] },
      ])
    );
    expect(result.composed).toBe(true);
    expect(result.report?.removedStatements).toBe(1);
    expect(result.code).not.toContain('translate([0,0,99])');
    expect(result.code).toContain('translate([0, 0, upright_pos_z]) upright();');
    // Exactly one top-level union: the generated one.
    expect(result.code.match(/union\(\)/g)).toHaveLength(1);
  });

  it('places every component at the origin when the spec gives no coordinates', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b' },
        { name: 'upright', description: 'u' },
      ])
    );
    expect(result.composed).toBe(true);
    expect(result.code).toContain('    base_plate();');
    expect(result.code).toContain('    upright();');
  });
```

Update the first test `'emits the placement block the model never wrote'`: change the last expectation to `expect(result.code).toContain('translate([0, 0, upright_pos_z]) rotate([0, 0, 90]) upright();');` and add `expect(result.code).toContain('upright_pos_z = 6;');`.

Update `'trims float noise out of emitted vectors'`: expect `'base_plate_pos_x = 0.3;'`, `'base_plate_pos_y = 0.333;'`, `'base_plate_pos_z = 2;'` and `'translate([base_plate_pos_x, base_plate_pos_y, base_plate_pos_z]) base_plate();'`.

Update `'places an unpositioned component at the origin alongside positioned ones'`: change `expect(result.code).toContain('translate([0, 0, 6]) upright();')` to `expect(result.code).toContain('translate([0, 0, upright_pos_z]) upright();')` and add `expect(result.code).toContain('upright_pos_z = 6;')`.

Then append:

```ts
describe('composeAssembly with measured frames', () => {
  const frames = [
    { name: 'base_plate', valid: true, min: [0, 0, 0] as [number, number, number], max: [60, 40, 6] as [number, number, number], size: [60, 40, 6] as [number, number, number] },
    { name: 'upright', valid: true, min: [-3, 0, -45] as [number, number, number], max: [3, 40, 0] as [number, number, number], size: [6, 40, 45] as [number, number, number] },
  ];

  it('corrects a module whose min corner is off the origin, inside the rotation', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b', position: [0, 0, 0] },
        { name: 'upright', description: 'u', position: [0, 0, 6], rotation: [0, 0, 90] },
      ]),
      frames
    );
    expect(result.code).toContain(
      'translate([0, 0, upright_pos_z]) rotate([0, 0, 90]) translate([3, 0, 45]) upright();'
    );
    expect(result.code).toMatch(/local-frame correction.*upright.*\[-3, 0, -45\]/);
    const up = result.report?.components.find((c) => c.name === 'upright');
    expect(up?.correction).toEqual([3, 0, 45]);
    expect(up?.placedMin).toEqual([-40, 0, 6]);
  });

  it('writes the position note beside the first emitted parameter', () => {
    const result = composeAssembly(
      MODULES,
      spec([
        { name: 'base_plate', description: 'b', position: [0, 0, 0] },
        { name: 'upright', description: 'u', position: [0, 10, 6], positionNote: 'z = top of base_plate (localExtents z = 6)' },
      ]),
      frames
    );
    expect(result.code).toContain('/* [Assembly Placement] */');
    expect(result.code).toContain('upright_pos_y = 10;   // z = top of base_plate (localExtents z = 6)');
    expect(result.code).toContain('upright_pos_z = 6;');
  });

  it('puts a note above the call when every coordinate is zero', () => {
    const result = composeAssembly(
      MODULES,
      spec([{ name: 'base_plate', description: 'b', position: [0, 0, 0], positionNote: 'sits on the floor' }]),
      frames
    );
    expect(result.code).toContain('    // base_plate: sits on the floor\n    base_plate();');
  });

  it('round-trips through stripGeneratedAssembly and re-composes identically', () => {
    const s = spec([{ name: 'upright', description: 'u', position: [0, 0, 6] }, { name: 'base_plate', description: 'b' }]);
    const once = composeAssembly(MODULES, s, frames).code;
    const twice = composeAssembly(stripGeneratedAssembly(once), s, frames).code;
    expect(twice).toBe(once);
  });
});
```

Also extend the `instantiationFor` test:

```ts
  it('applies the same local-frame correction as the placement block', () => {
    const s = spec([{ name: 'lid', description: 'l', position: [0, 0, 20] }]);
    const frames = [{ name: 'lid', valid: true, min: [-10, -10, 0] as [number, number, number], max: [10, 10, 4] as [number, number, number], size: [20, 20, 4] as [number, number, number] }];
    expect(instantiationFor(s, 'lid', frames)).toBe('translate([0, 0, 20]) translate([10, 10, 0]) lid();');
  });
```

Add `stripGeneratedAssembly` to the import at the top of the test file.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/design/compose-assembly.test.ts`
Expected: the updated and new tests FAIL.

- [ ] **Step 3: Implement**

In `src/lib/design/compose-assembly.ts`, add imports at the top:

```ts
import type { ModuleFrame } from '../engine/module-frames';
import { buildPlacementComponents, PlacementComponent, PlacementReport } from './placement-report';
import { isZeroVec, Vec3 } from './placement-geometry';
```

Replace `ComposeSkipReason`, `ComposeResult`, `composeAssembly` and `instantiationFor` with:

```ts
export type ComposeSkipReason = 'no_spec' | 'missing_modules';

export interface ComposeResult {
  code: string;
  composed: boolean;
  reason?: ComposeSkipReason;
  /** Spec components whose module the code never defined. */
  missing?: string[];
  report: PlacementReport | null;
}

const AXES = ['x', 'y', 'z'] as const;

/** `translate(P) rotate(R) translate(C) name();` with P given per axis (literal or parameter name). */
function placementCall(c: PlacementComponent, posExpr: [string, string, string]): string {
  let call = `${c.name}();`;
  if (!isZeroVec(c.correction)) call = `translate(${vec(c.correction)}) ${call}`;
  if (!isZeroVec(c.rotation)) call = `rotate(${vec(c.rotation)}) ${call}`;
  if (posExpr.some((e) => e !== '0')) call = `translate([${posExpr.join(', ')}]) ${call}`;
  return call;
}

/**
 * Enforces the placement contract. Model-written top-level geometry is
 * stripped, every component is placed from the spec, and each module's
 * measured min corner is corrected so its origin lands where the Architect
 * meant. Only two things stop it: no spec, or a spec component with no module
 * (then the code is returned exactly as authored, since stripping it would
 * leave nothing to render).
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
  const components = buildPlacementComponents(spec, frames, true);
  const noteFor = new Map((spec.components ?? []).map((c) => [c.name, c.positionNote?.replace(/\s+/g, ' ').trim()]));

  const params: string[] = [];
  const calls: string[] = [];
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

    if (note && !noteUsed) calls.push(`    // ${c.name}: ${note}`);
    let line = `    ${placementCall(c, posExpr)}`;
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
    'union() {',
    ...calls,
    '}',
    '',
  ].join('\n');

  return {
    code: `${stripped.code.trimEnd()}\n${block}`,
    composed: true,
    report: { composed: true, removedStatements: stripped.removed, components },
  };
}

/**
 * Instantiation string for one placed component with literal coordinates and
 * the same local-frame correction the placement block applies, so the
 * interference probe tests exactly what was compiled.
 */
export function instantiationFor(spec: AssemblySpec, componentName: string, frames: ModuleFrame[] = []): string | null {
  if (!spec.components?.some((x) => x.name === componentName)) return null;
  const c = buildPlacementComponents(spec, frames, true).find((x) => x.name === componentName)!;
  const posExpr = AXES.map((_, i) => (c.position[i] === 0 ? '0' : fmt(c.position[i]))) as [string, string, string];
  return placementCall(c, posExpr);
}
```

Keep the existing `fmt`, `vec`, `isZero` helpers (delete `isZero` if unused after this change) and `stripGeneratedAssembly` as they are. `vec` must accept `Vec3`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/design`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/design/compose-assembly.ts src/lib/design/compose-assembly.test.ts
git commit -m "feat(design): enforce spec placement, correct module origins, keep parametric intent in comments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Prompts — one pose rule, localExtents, positionNote, useModules

**Files:**
- Modify: `src/lib/agent/system-prompt.ts`
- Test: `src/lib/agent/system-prompt.test.ts`

**Interfaces:** the exported prompt constants keep their names. Budgets: see Global Constraints. The word-budget test is the oracle: after each edit run it.

- [ ] **Step 1: Add the failing assertions**

In `src/lib/agent/system-prompt.test.ts`, inside the test `'teaches every node the spec fields...'`, append:

```ts
    // One pose rule: nobody is told to author in print pose any more.
    for (const [name, text] of Object.entries(PROMPTS)) {
      expect(text, `${name} still talks about PRINT pose authoring`).not.toMatch(/PRINT pose/);
      expect(text, `${name} still offers a print layout`).not.toMatch(/print layout/i);
    }
    for (const field of ['localExtents', 'positionNote', 'useModules']) {
      expect(ARCHITECT_PREAMBLE).toContain(field);
    }
    expect(CAD_AI_SYSTEM_PROMPT).toMatch(/build plate; nothing is ever below it/);
    expect(ARCHITECT_PREAMBLE).toMatch(/below z = 0/);
    expect(DRAFTER_PREAMBLE).toMatch(/below z = 0/);
    expect(DRAFTER_PREAMBLE).toContain('localExtents');
    expect(DRAFTER_PLACEMENT_CONTRACT).toContain('localExtents');
    expect(REPAIR_PREAMBLE).toContain('floating');
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/agent/system-prompt.test.ts`
Expected: FAIL on `PRINT pose` / `print layout` / missing fields.

- [ ] **Step 3: Edit CAD_AI_SYSTEM_PROMPT**

Replace the whole `## LOCAL FRAME` section (the heading and its one paragraph) with:

```text
## LOCAL FRAME
Every module is authored in ASSEMBLY pose: origin at its min-x/min-y/min-z corner, geometry in +x/+y/+z. z = 0 is the build plate; nothing is ever below it. Code measures each module, corrects its origin and applies the spec's rotation and position. Never rotate or offset a module into print pose; bedFace is for print preparation only.
```

That paragraph is 56 words against the old 51, and the system prompt has 3 words of headroom, so also make these two cuts in `CAD_AI_SYSTEM_PROMPT`:

- In the FLAT FACES bullet, replace `It is feature-free, > 10 mm2 (what isFlatPackable measures) and ideally >= 25 % of the footprint;` with `It is feature-free, > 10 mm2 and ideally >= 25 % of the footprint;` (saves 3 words).
- In the FORMAT example, change the line `base_plate();   // single-part scripts only` to `base_plate();   // placement code replaces this` (same word count; the example must still compile to geometry).

- [ ] **Step 4: Edit ARCHITECT_PREAMBLE**

Replace the paragraph starting `PLACEMENT IS YOUR JOB, NOT THE DRAFTER'S.` with:

```text
PLACEMENT IS YOUR JOB, NOT THE DRAFTER'S. Give every component, including the one at [0, 0, 0], a position [x, y, z] - where its local origin (its min corner) lands in assembly coordinates - and, when not axis-aligned, a rotation [rx, ry, rz] about that origin, applied before the translation. Positions are ALWAYS the assembled pose, never a print arrangement, and never put any part below z = 0. Parts that touch share a face; parts that clear are separated by exactly the joint clearance. positionNote: one line deriving each non-zero coordinate from other parts, e.g. "z = top of base_plate (localExtents z = 6.4)". Check the arithmetic: these numbers are compiled verbatim; code measures the result and reports any part that floats or hangs below z = 0.
```

In `PER COMPONENT:` replace the line `- dimensions in mm; bedFace by the FLAT FACES rules ('-Z' preferred); matingFaces: every datum or mating face that must stay flat.` with:

```text
- localExtents [x, y, z]: the module's exact size in its own frame, in mm - the drafter must hit these and code measures them; form: box | cylinder | profile_extrude | revolve | shell | other; useModules: registry keys (see the drafter's tool list) the part needs.
- bedFace by the FLAT FACES rules ('-Z' preferred); matingFaces: every datum or mating face that must stay flat.
```

Replace the `OUTPUT CHECKLIST:` line with:

```text
OUTPUT CHECKLIST: assemblyName; boundingBox {width, length, height}; components[] each with name (snake_case), description, form, localExtents, bedFace, matingFaces, position, positionNote (+ rotation when not axis-aligned), useModules; jointContracts[] with partA and partB; edgeTreatments[]; stressPoints[] with sized mitigations; assumptions[]; openQuestions[].
```

- [ ] **Step 5: Edit DRAFTER_PREAMBLE**

Replace the bullet starting `- bedFace: make that face planar and feature-free` with:

```text
- bedFace: make that face planar and feature-free (only the elephant-foot chamfer touches its perimeter). Author every module in ASSEMBLY pose at its local origin; never rotate or offset it into print pose.
- localExtents: each module's measured size must equal the spec's localExtents exactly; no geometry below z = 0, ever.
```

In the `OUTPUT CHECKLIST:` line, replace `extents match the spec bounding box;` with `each module's extents equal its localExtents;`.

- [ ] **Step 6: Edit DRAFTER_PLACEMENT_CONTRACT**

Replace item 2 with:

```text
2. Author every module in its own local frame - origin at its min corner, geometry in +x/+y/+z - in ASSEMBLY pose, sized exactly to its localExtents. Do not offset a part to where it belongs and do not rotate it into print pose; code measures each module and applies the spec's rotation and position.
```

Replace the final paragraph (`If you place parts yourself, ...`) with:

```text
If you place parts yourself, that placement is deleted and the spec's coordinates are used, so follow this exactly.
```

- [ ] **Step 7: Edit REPAIR_PREAMBLE**

In the `READ THE MEASURED LINE.` paragraph replace `re-orient onto the bedFace (rotate inside the module for a single part), add a D-flat, or chamfer/roof the face at >= 50 deg. Never model supports. With placements the numbers describe the assembly pose; judge each component by its own bedFace.` with:

```text
add a D-flat or chamfer/roof the face at >= 50 deg; never rotate a module into print pose and never model supports. The numbers describe the assembly pose.
```

In `FIX BY KIND.` append before `buildplate: resize or re-orient.`:

```text
floor or floating: a part hangs below z = 0 or does not touch a grounded part - fix its module's origin or the spec position, not its shape. extents: resize the module to the spec's localExtents. local_frame: informational; code already corrected it.
```

- [ ] **Step 8: Run the prompt tests (the budget test is the oracle)**

Run: `npx vitest run src/lib/agent/system-prompt.test.ts`
Expected: PASS. If a budget assertion fails, trim words from the paragraph you edited in that prompt (never from the fenced examples) until it passes; do not raise a budget.

- [ ] **Step 9: Commit**

```bash
git add src/lib/agent/system-prompt.ts src/lib/agent/system-prompt.test.ts
git commit -m "feat(agent): one pose rule, localExtents and positionNote in the prompts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Graph wiring v2 — measure before composing, normalise specs

**Files:**
- Modify: `src/lib/agent/graph.ts` — `specHasPlacements` (line 55), `applyPlacement` (lines 66–76), `checkAssemblyFit` (probe uses frames), `architectNode` (after parse), `drafterNode` (compose site), `fixCode` (compose site), `validateCode` (reuse the report), `specGate` (normalise client edits)
- Test: `src/lib/agent/graph-placement.test.ts`

**Interfaces:**
- Consumes: `composeAssembly(code, spec, frames)` and `instantiationFor(spec, name, frames)` (Task 9), `normalizeSpec` (Task 8), `measureModuleFrames` (Task 3), `placementSummary` (Task 4).
- Produces: `async function placeAssembly(code: string, spec: AssemblySpec | null): Promise<{ code: string; report: PlacementReport | null; frames: ModuleFrame[] }>` (module-private). State `placementReport` now set by drafter/fixCode and only audited in validateCode.

- [ ] **Step 1: Update the tests**

In `src/lib/agent/graph-placement.test.ts`:

Replace the test `'tells the drafter to stop placing parts, but only when the spec has coordinates'` with:

```ts
  it('imposes the placement contract whenever the spec has components', async () => {
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      components: [{ name: 'base_plate', description: 'base' }, { name: 'upright', description: 'arm' }],
    });
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent('k', undefined, 'm');
    await runApproved(agent, { configurable: { thread_id: newKey() } }, 'a 40mm bracket');

    const drafterSystem = String((invokeMock.mock.calls[1][0] as any[])[0].content);
    expect(drafterSystem).toContain('PLACEMENT CONTRACT');
  });
```

Replace the test `'leaves a model-authored assembly alone rather than doubling it'` with:

```ts
  it('replaces a model-authored assembly with the spec placement', async () => {
    // The drafter ignored the contract and put the upright 99mm up.
    const authored = `${MODULES_ONLY}\nunion() { base_plate(); translate([0,0,99]) upright(); }`;
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    invokeMock.mockResolvedValueOnce(draft(authored));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    expect(state.currentCode).toContain('Assembly placement (generated');
    expect(state.currentCode).not.toContain('translate([0,0,99])');
    expect(state.placementReport.removedStatements).toBe(1);
    expect(state.isValid).toBe(true);
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
  });

  it('corrects a module authored off its origin so the part lands where the spec says', async () => {
    const hanging = `
module base_plate() { cube([40, 40, 5]); }
module upright() { translate([-2.5, 0, -30]) cube([5, 40, 30]); }
`;
    invokeMock.mockResolvedValueOnce(TWO_PART_SPEC);
    invokeMock.mockResolvedValueOnce(draft(hanging));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    expect(state.currentCode).toContain('translate([2.5, 0, 30]) upright();');
    expect(state.modelInfo.boundingBox.min[2]).toBeCloseTo(0, 2);
    expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
    expect(state.specViolations.some((v: any) => v.kind === 'floor')).toBe(false);
    expect(state.specViolations.some((v: any) => v.kind === 'floating')).toBe(false);
    expect(state.specViolations.some((v: any) => v.kind === 'local_frame')).toBe(true);
  });

  it('reports a part the spec leaves hovering', async () => {
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      boundingBox: { width: 40, length: 40, height: 45 },
      components: [
        { name: 'base_plate', description: 'base', position: [0, 0, 0] },
        { name: 'upright', description: 'arm', position: [0, 0, 15] },
      ],
    });
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    const floating = state.specViolations.filter((v: any) => v.kind === 'floating');
    expect(floating).toHaveLength(1);
    expect(floating[0].message).toContain("'upright'");
    expect(floating[0].deltaMm).toBeCloseTo(10, 1);
  });

  it('normalises free-text component names before drafting', async () => {
    invokeMock.mockResolvedValueOnce({
      ...TWO_PART_SPEC,
      components: [
        { name: 'Base Plate', description: 'base', position: [0, 0, 0] },
        { name: 'Upright', description: 'arm', position: [0, 0, 5] },
      ],
    });
    invokeMock.mockResolvedValueOnce(draft(MODULES_ONLY));

    const agent = createCadAgent('k', undefined, 'm');
    const config = { configurable: { thread_id: newKey() } };
    await runApproved(agent, config, 'a 40mm bracket');

    const state = (await agent.getState(config)).values;
    expect(state.assemblySpec.components.map((c: any) => c.name)).toEqual(['base_plate', 'upright']);
    expect(state.currentCode).toContain('translate([0, 0, upright_pos_z]) upright();');
  });
```

Update `'compiles placed geometry that the model never positioned itself'`: change `expect(state.currentCode).toContain('translate([0, 0, 5]) upright();')` to `expect(state.currentCode).toContain('translate([0, 0, upright_pos_z]) upright();')` and add `expect(state.currentCode).toContain('upright_pos_z = 5;')`.

Update `'keeps placement spec-driven across a repair'` the same way (`upright_pos_z`).

The Phase-0 test `'records each module frame and flags a part hanging below the floor'` now composes (the model-written placement is stripped and the hanging upright is corrected), so change its expectations to:

```ts
      expect(upright.localMin[2]).toBeCloseTo(-30, 2);
      const kinds = state.specViolations.map((v: any) => v.kind);
      expect(kinds).not.toContain('floor');
      expect(kinds).toContain('local_frame');
      expect(state.modelInfo.dimensions.z).toBeCloseTo(35, 1);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/agent/graph-placement.test.ts`
Expected: the new and updated tests FAIL.

- [ ] **Step 3: Implement**

In `src/lib/agent/graph.ts`:

Add `import { normalizeSpec } from './spec-normalize';` and `import type { ModuleFrame } from '../engine/module-frames';` (keep the value import of `measureModuleFrames`).

Replace `specHasPlacements` with:

```ts
/** True when the spec names at least one component: placement is then always code-driven. */
function specHasComponents(spec: AssemblySpec | null): boolean {
  return !!spec?.components?.length;
}
```

and update its two call sites (`drafterNode`'s `drafterSystem`) to `specHasComponents(state.assemblySpec)`.

Replace `applyPlacement` with:

```ts
/**
 * Measures each component module, then hands placement to deterministic code.
 * Every outcome except a clean compose leaves the model's script untouched.
 */
async function placeAssembly(
  code: string,
  spec: AssemblySpec | null,
  onProgress?: (event: StreamEventPayload) => void
): Promise<{ code: string; report: PlacementReport | null; frames: ModuleFrame[] }> {
  if (!code || !spec?.components?.length) return { code, report: null, frames: [] };

  const defined = new Set(analyzeTopLevel(code).moduleNames);
  const names = spec.components.map((c) => c.name).filter((n) => defined.has(n));
  const frames = await measureModuleFrames(code, names);
  const result = composeAssembly(code, spec, frames);

  if (result.reason === 'missing_modules') {
    onProgress?.({
      type: 'validating',
      message: `Placement skipped: the script defines no module for ${result.missing?.join(', ')}; the model's own layout is compiled as written.`,
      timestamp: Date.now(),
    });
    return { code: result.code, report: null, frames };
  }
  onProgress?.({ type: 'validating', message: placementSummary(result.report, null), timestamp: Date.now() });
  return { code: result.code, report: result.report, frames };
}
```

(`placeAssembly` must be declared inside `createCadAgent` or take `onProgress` as shown; it is shown taking it as a parameter so it can stay module-level.)

In `checkAssemblyFit`, add a `frames: ModuleFrame[]` parameter and pass it to both `instantiationFor(spec, joint.partA!, frames)` and `instantiationFor(spec, joint.partB!, frames)`. At its call site in `validateCode`, compute frames from the report: `const frames = (state.placementReport?.components ?? []).filter((c) => c.measured).map((c) => ({ name: c.name, valid: true, min: c.localMin, max: c.localMax, size: c.size }));` and pass them.

In `architectNode`, change `spec = parsed.data;` to `spec = normalizeSpec(parsed.data);`.

In `specGate`, change `if (parsed.success) approvedSpec = parsed.data;` to `if (parsed.success) approvedSpec = normalizeSpec(parsed.data);`.

In `drafterNode`, replace `const placed = applyPlacement(extracted.code || '', state.assemblySpec);` with `const placed = await placeAssembly(extracted.code || '', state.assemblySpec, onProgress);` and in its return use `currentCode: placed.code,` and add `placementReport: placed.report,`.

In `fixCode`, replace the `currentCode:` line with:

```ts
      currentCode: repaired ? repaired.code : state.currentCode,
      placementReport: repaired ? repaired.report : state.placementReport,
```

after computing, just above the `return`:

```ts
    const repaired = extracted.code ? await placeAssembly(extracted.code, state.assemblySpec, onProgress) : null;
```

In `validateCode`, replace the Phase-0 measurement block (from `let placementReport` through the `onProgress` call) with:

```ts
    // Placement was measured and composed before this compile (placeAssembly);
    // here it is only audited against the compiled model's bounding box.
    const placementReport = state.placementReport ?? null;
    const modelMin = validation.summary?.boundingBox?.min ?? modelInfo?.boundingBox.min ?? null;
    specViolations.push(...auditPlacement(placementReport, modelMin, state.assemblySpec));
    if (modelMin) {
      onProgress?.({
        type: 'validating',
        message: placementSummary(placementReport, modelMin[2]),
        timestamp: Date.now(),
      });
    }
```

and keep `placementReport,` in the node's return.

- [ ] **Step 4: Run every agent suite and the type check**

Run: `npx vitest run src/lib/agent && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors. `graph-hil.test.ts` assertions on the number of `invokeMock` calls are unaffected (measurement uses wasm, not the model).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/graph.ts src/lib/agent/graph-placement.test.ts
git commit -m "feat(agent): measure modules before composing and normalise specs at every entry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Orientation idioms in the engineering registry

**Files:**
- Modify: `src/lib/agent/engineering-tools.ts` (`category` union at line 7; registry; tool description and `moduleKey` enum at lines 519–548)
- Test: `src/lib/agent/engineering-tools.test.ts`

**Interfaces:**
- Produces: registry key `orientation_idioms` with category `'orientation'`; modules `profile_extrude_y(profile, thickness)`, `profile_extrude_x(profile, thickness)`, `cylinder_along_x(d, len)`, `cylinder_along_y(d, len)`, `box_at_origin(size)`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/agent/engineering-tools.test.ts`:

```ts
describe('orientation idioms', () => {
  it('is registered and listed in the tool', async () => {
    expect(ENGINEERING_MODULE_REGISTRY.orientation_idioms.category).toBe('orientation');
    const raw = await getFunctionalCadModuleTool.invoke({ moduleKey: 'orientation_idioms' });
    expect(JSON.parse(raw).codeTemplate).toContain('module profile_extrude_y');
  });

  // The test is the oracle for the sign conventions: every idiom must compile
  // and land its min corner exactly on the origin.
  it.each([
    ['profile_extrude_y([[0,0],[30,0],[0,20]], 4);', [30, 4, 20]],
    ['profile_extrude_x([[0,0],[30,0],[0,20]], 4);', [4, 30, 20]],
    ['cylinder_along_x(10, 50);', [50, 10, 10]],
    ['cylinder_along_y(10, 50);', [10, 50, 10]],
    ['box_at_origin([10, 20, 30]);', [10, 20, 30]],
  ])('%s sits at the origin with the documented extents', async (call, size) => {
    const { compileScad } = await import('../engine/scad-compiler');
    const template = ENGINEERING_MODULE_REGISTRY.orientation_idioms.codeTemplate;
    const r = await compileScad(`$fn = 32;\n${template}\n${call}\n`);
    expect(r.valid, r.error).toBe(true);
    const bb = r.summary!.boundingBox!;
    bb.min.forEach((v) => expect(Math.abs(v)).toBeLessThan(0.05));
    bb.size.forEach((v, i) => expect(v).toBeCloseTo(size[i], 1));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/agent/engineering-tools.test.ts`
Expected: FAIL (`orientation_idioms` undefined).

- [ ] **Step 3: Implement**

In `src/lib/agent/engineering-tools.ts` add `'orientation'` to the `category` union. Add this entry to `ENGINEERING_MODULE_REGISTRY` (before the closing `};`):

```ts
  orientation_idioms: {
    id: 'orientation_idioms',
    name: 'Orientation Idioms - Extrusions and Cylinders Along Any Axis, Min Corner at the Origin',
    category: 'orientation',
    description: 'Verified transforms for laying a 2D profile in the XZ or YZ plane and running a cylinder along X or Y, each with its min corner exactly at the origin so spec placement lands where the Architect meant.',
    engineeringParameters: [
      'profile: 2D points [[x, y], ...] with min x = 0 and min y = 0; y becomes the vertical (Z) axis',
      'thickness: extrusion length along the axis the profile is NOT in, in mm',
      'd, len: cylinder diameter and length along its axis, in mm',
      'size: [x, y, z] box size',
    ],
    designRules: [
      'cube(size) with no center sits at the origin; center = true moves the min corner to -size/2 and breaks placement.',
      'cylinder() is centred on its axis: after rotating it sideways, translate by +d/2 in the two cross axes.',
      'rotate([90,0,0]) maps +y to +z (up). rotate([-90,0,0]) maps +y to -z (DOWN) - the classic inverted-part mistake.',
      'rotate([0,90,0]) maps +z to +x; the extrusion must start at z = 0 for the result to start at x = 0.',
      'Keep every module\'s min corner at [0,0,0]; code measures it and reports any offset.',
    ],
    codeTemplate: `// --- Orientation idioms: min corner at the origin, geometry in +x/+y/+z ---
// Profile drawn in the XZ plane (profile x -> X, profile y -> Z), extruded along +Y.
module profile_extrude_y(profile, thickness) {
    rotate([90, 0, 0]) translate([0, 0, -thickness]) linear_extrude(thickness) polygon(profile);
}

// Profile drawn in the YZ plane (profile x -> Y, profile y -> Z), extruded along +X.
module profile_extrude_x(profile, thickness) {
    rotate([90, 0, 90]) linear_extrude(thickness) polygon(profile);
}

// Cylinder lying along +X, occupying [0..len] x [0..d] x [0..d].
module cylinder_along_x(d, len) {
    translate([0, d / 2, d / 2]) rotate([0, 90, 0]) cylinder(d = d, h = len);
}

// Cylinder lying along +Y, occupying [0..d] x [0..len] x [0..d].
module cylinder_along_y(d, len) {
    translate([d / 2, 0, d / 2]) rotate([-90, 0, 0]) cylinder(d = d, h = len);
}

// A box with its min corner at the origin (never use center = true for placed parts).
module box_at_origin(size) {
    cube(size);
}`,
  },
```

In the tool description add the line:

```text
- 'orientation_idioms': Profile extrusions along X or Y and cylinders along X or Y, each with its min corner at the origin.
```

and add `'orientation_idioms'` to the `z.enum([...])` list.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/agent/engineering-tools.test.ts`
Expected: PASS. If an idiom fails the min-corner assertion, the sign in that idiom's `rotate`/`translate` is wrong: flip it using the design rules above (e.g. `[90,0,0]` vs `[-90,0,0]`, or add/remove the `translate([0,0,-thickness])`) until the measured min corner is the origin, then re-run. Do not loosen the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/engineering-tools.ts src/lib/agent/engineering-tools.test.ts
git commit -m "feat(tools): test-guarded orientation idioms with min corner at the origin

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: After-eval and comparison

**Files:**
- Modify: `docs/superpowers/plans/2026-09-14-deterministic-placement-generation-eval.md` (append results)

- [ ] **Step 1: Full suite and type check**

Run: `npm test && npx tsc --noEmit -p tsconfig.json`
Expected: all green.

- [ ] **Step 2: CHECKPOINT — run the after eval (spends model quota; confirm with the user first)**

Tell the user: "After eval: same 10 prompts on deepseek-v4-flash, roughly 20 to 50 model calls. Proceed?" Only after a yes:

```bash
npm run eval:generation -- --model deepseek-v4-flash --tag after
```

- [ ] **Step 3: Record the comparison**

Append to this plan file under a heading `## Results` a two-column table (baseline vs after) with the rows `specOk, composed, compileOk, floorOk, noFloating, localFrameOk, extentsOk, shellsOk, meanWallMs`, taken from the two printed summaries, and the Langfuse run URLs printed by each run. State the sample size (10) next to the table; do not describe a change as "fixed" — describe it as a rate.

```bash
git add docs/superpowers/plans/2026-09-14-deterministic-placement-generation-eval.md
git commit -m "docs(eval): record before/after generation rates

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Hand off**

Report to the user: the rates table, which prompts still fail and on which metric, and the branch name. Do not merge; the user decides.

---

## Self-review notes

- Spec coverage: decisions 1 (Task 8, 10), 2 (Task 9), 3 (Tasks 3, 9, 11), 4 (Task 10), 5 (Tasks 4, 8), 6 (Task 9), 7 (Task 8), 8 (Task 6), 9 (Tasks 5, 11), 10 (Task 12), 11 (Tasks 7, 13).
- Type consistency: `stripTopLevelGeometry` returns `{ code, removed }` everywhere; `composeAssembly(code, spec, frames?)` and `instantiationFor(spec, name, frames?)` match between Tasks 9 and 11; `placementReport` state field name is the same in Tasks 5, 7, 11; `ModuleFrame` fields `{ name, valid, min, max, size }` are what Task 11 reconstructs from `PlacementComponent`.
- Known approximation: AABB contact (Task 4). Documented in the spec as parked.
