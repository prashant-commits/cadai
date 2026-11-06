/**
 * Zero-API verification of the front half's CODE steps (resolve, normalise,
 * derived box, profile re-origin, dead-parameter lint, contact sink, sheet,
 * blockout), replayed over the Architect specs saved in eval/results.
 *
 * Each check compares the code against an independent answer, not against itself:
 *   idempotent   normalizeSpec(normalizeSpec(s)) == normalizeSpec(s)
 *   resolve      a re-resolve of the normalised spec gives the same numbers
 *   box          the derived boundingBox == impliedEnvelope of the components
 *   profile      every profile outline lies in [0..extent] on its plane
 *   lint         mutation test: bump each parameter, see whether geometry moves;
 *                flagged-dead must not move geometry (false positive) and
 *                not-flagged must move it (false negative)
 *   sheet        the concept sheet renders without throwing
 *   compile      (--compile) blockout + generated placement compiled by OpenSCAD:
 *                assembly bbox == derived box, nothing below z = 0, each module's
 *                measured size == its localExtents
 *
 * Usage: npx tsx eval/architect/verify-front.ts [--files <glob-prefix>] [--compile N] [--offset K]
 */
import fs from 'node:fs';
import path from 'node:path';
import { AssemblySpecSchema, type AssemblySpec } from '@/lib/agent/assembly-spec';
import { normalizeSpec } from '@/lib/agent/spec-normalize';
import { resolveSpec } from '@/lib/agent/spec-expr';
import { impliedEnvelope } from '@/lib/agent/spec-coherence';
import { auditSpecParameters } from '@/lib/agent/spec-param-lint';
import { renderVariantSheet } from '@/lib/spec-sheet/sheet-svg';
import { blockoutScad } from '@/lib/spec-sheet/blockout-scad';
import { composeAssembly } from '@/lib/design/compose-assembly';
import { contactSinks } from '@/lib/design/contact-sink';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const prefix = flag('--files') ?? 'architect-';
const compileN = Number(flag('--compile') ?? 0);
const offset = Number(flag('--offset') ?? 0);
const TOL = 0.05;

const dir = path.join(process.cwd(), 'eval', 'results');
const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json') && !f.includes('rescore'));
const specs: { id: string; spec: unknown }[] = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const [k, s] of Object.entries(j.specs ?? {})) specs.push({ id: `${f.replace(/\.json$/, '')}:${k}`, spec: s });
}

type Fail = { check: string; id: string; detail: string };
const fails: Fail[] = [];
const counts: Record<string, { ok: number; fail: number }> = {};
const tally = (check: string, ok: boolean, id: string, detail = '') => {
  counts[check] ??= { ok: 0, fail: 0 };
  counts[check][ok ? 'ok' : 'fail']++;
  if (!ok && fails.filter((x) => x.check === check).length < 8) fails.push({ check, id, detail });
};

const near = (a: number, b: number, t = TOL) => Math.abs(a - b) <= t;
/** Geometry fingerprint: every number code places or sizes (not names, not prose). */
function geometry(s: AssemblySpec): number[] {
  const out: number[] = [];
  for (const c of s.components ?? []) {
    out.push(...(c.localExtents ?? []), ...(c.position ?? []), ...(c.rotation ?? []));
    if (c.shape) out.push(c.shape.innerD ?? 0, c.shape.wall ?? 0, ...(c.shape.points ?? []).flat(), ...(c.shape.holes ?? []).flat(2));
    for (const h of c.holes ?? []) out.push(h.d, ...h.at, h.depth ?? -1);
  }
  for (const g of s.guides ?? []) out.push(...(g.localExtents ?? []), ...(g.position ?? []), ...(g.points ?? []).flat());
  return out as number[];
}
/** Normalised numbers are rounded to 0.01 mm, so compare at that resolution. */
const differs = (a: number[], b: number[]) => a.length !== b.length || a.some((x, i) => Math.abs(x - b[i]) > 0.011);

const relational: { id: string; spec: AssemblySpec }[] = [];
let parsed = 0;
for (const { id, spec } of specs) {
  const p = AssemblySpecSchema.safeParse(spec);
  if (!p.success) { tally('parse', false, id, p.error.issues[0]?.message ?? ''); continue; }
  parsed++;
  let n: AssemblySpec;
  try { n = normalizeSpec(p.data as AssemblySpec); } catch (e) { tally('normalize-throws', false, id, String(e)); continue; }
  tally('normalize-throws', true, id);
  const resolved = resolveSpec(p.data as AssemblySpec);
  const clean = resolved.errors.length === 0;

  // idempotent
  const n2 = normalizeSpec(n);
  tally('idempotent', !differs(geometry(n), geometry(n2)) && JSON.stringify(n.boundingBox) === JSON.stringify(n2.boundingBox), id);

  // resolve: re-resolving the normalised spec reproduces its numbers
  if (clean) {
    const r = resolveSpec(n);
    tally('resolve-stable', r.errors.length === 0 && !differs(geometry(n), geometry(r.spec)), id, r.errors[0] ?? 'numbers moved on re-resolve');
  }

  // derived box == implied envelope
  const env = impliedEnvelope(n);
  if (env && clean) {
    const bb = n.boundingBox!;
    tally('box', near(bb.width, env.size[0]) && near(bb.length, env.size[1]) && near(bb.height, env.size[2]), id,
      `box ${bb.width}x${bb.length}x${bb.height} vs parts ${env.size.map((x) => x.toFixed(2)).join('x')}`);
  }

  // profile outlines inside [0..extent]
  for (const c of n.components ?? []) {
    if (c.shape?.kind !== 'profile' || !c.shape.points?.length || !c.localExtents || !clean) continue;
    const [iu, iv] = c.shape.plane === 'xy' ? [0, 1] : c.shape.plane === 'xz' ? [0, 2] : [1, 2];
    const us = c.shape.points.map((q) => q[0]); const vs = c.shape.points.map((q) => q[1]);
    const ok = near(Math.min(...us), 0, 0.5) && near(Math.min(...vs), 0, 0.5) && near(Math.max(...us), c.localExtents[iu], 0.5) && near(Math.max(...vs), c.localExtents[iv], 0.5);
    tally('profile', ok, `${id}/${c.name}`, `u ${Math.min(...us)}..${Math.max(...us)} of ${c.localExtents[iu]}, v ${Math.min(...vs)}..${Math.max(...vs)} of ${c.localExtents[iv]}`);
  }

  // dead-parameter lint, mutation test
  if (clean && n.parameters?.length) {
    const dead = new Set(auditSpecParameters(p.data as AssemblySpec).map((v) => v.field.replace('parameters.', '')));
    const g0 = geometry(normalizeSpec(p.data as AssemblySpec));
    for (const prm of n.parameters) {
      const bumped = structuredClone(p.data) as AssemblySpec;
      const t = bumped.parameters!.find((x) => x.name === prm.name) ?? bumped.parameters!.find((x) => x.name.toLowerCase() === prm.name);
      if (!t) continue;
      t.value = t.value * 1.1 + 1;
      // Drop cached numbers so expressions are re-evaluated from source.
      const moved = differs(g0, geometry(normalizeSpec(bumped)));
      if (dead.has(prm.name)) tally('lint-no-false-positive', !moved, `${id}/${prm.name}`, 'flagged dead but bumping it moved geometry');
      else tally('lint-no-false-negative', moved, `${id}/${prm.name}`, 'not flagged but bumping it moved nothing');
    }
  }

  // sheet renders
  try { renderVariantSheet({ id: 'A', name: 'A', spec: n }); tally('sheet', true, id); }
  catch (e) { tally('sheet', false, id, String(e).slice(0, 120)); }

  if (clean && (n.parameters?.length ?? 0) > 0) relational.push({ id, spec: n });
}

async function compileChecks() {
  const { compileScad } = await import('@/lib/engine/scad-compiler');
  const { measureModuleFrames } = await import('@/lib/engine/module-frames');
  for (const { id, spec } of relational.slice(offset, offset + compileN)) {
    const block = blockoutScad(spec);
    const names = (spec.components ?? []).map((c) => c.name).filter((nm) => !block.skipped.some((s) => s.name === nm));
    const frames = await measureModuleFrames(block.code, names);
    for (const f of frames) {
      const c = spec.components!.find((x) => x.name === f.name);
      if (!c?.localExtents || !f.size) continue;
      tally('module-size', c.localExtents.every((e, i) => near(e, f.size![i], 0.1)), `${id}/${f.name}`, `measured ${f.size.map((x) => x.toFixed(2))} vs ${c.localExtents}`);
    }
    const composed = composeAssembly(block.code, spec, frames);
    if (!composed.composed) { tally('assembly-compiles', false, id, composed.reason ?? 'not composed'); continue; }
    const r = await compileScad(composed.code);
    const bb = r.summary?.boundingBox;
    tally('assembly-compiles', r.valid && !!bb, id, r.errors[0]?.message ?? 'no geometry');
    if (!bb) continue;
    const want = spec.boundingBox!;
    const sinkSlack = contactSinks(spec).size > 0 ? 0.1 : 0;
    tally('assembly-box', near(bb.size[0], want.width, 0.1 + sinkSlack) && near(bb.size[1], want.length, 0.1 + sinkSlack) && near(bb.size[2], want.height, 0.1 + sinkSlack), id,
      `compiled ${bb.size.map((x) => x.toFixed(2)).join('x')} vs derived ${want.width}x${want.length}x${want.height}`);
    tally('assembly-floor', bb.min[2] >= -0.011, id, `min z ${bb.min[2]}`);
  }
}

(async () => {
  if (compileN > 0) await compileChecks();
  console.log(`specs: ${specs.length} from ${files.length} files; parsed ${parsed}; relational+clean ${relational.length}`);
  for (const [k, v] of Object.entries(counts)) console.log(`${k.padEnd(24)} ok ${String(v.ok).padStart(5)}  fail ${v.fail}`);
  if (fails.length) { console.log('\nfirst failures:'); for (const f of fails) console.log(`  [${f.check}] ${f.id}: ${f.detail}`); }
})();
