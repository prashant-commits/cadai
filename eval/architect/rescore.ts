/**
 * Re-scores every rendered Architect run without a model call:
 *  - intent: the hand-written labels, checked against each spec's geometry (intent.ts);
 *  - audits with the bounding box computed by code from the parts, beside the
 *    audits on the box the model declared, so the two are reported separately.
 *
 *   npm run eval:architect:rescore                       # every rendered run, intent + both audits
 *   npm run eval:architect:rescore -- --results r2- --intent-only
 *
 * By default reads eval/results/architect-renders/<run>/specs.json. With
 * --results <prefix> it reads the specs saved in every architect-<prefix>*.json
 * results file instead (no render needed). --intent-only skips the two audit
 * compiles, which dominate the run time. Writes
 * eval/results/architect-rescore-<timestamp>.json and prints one row per run.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { impliedEnvelope } from '@/lib/agent/spec-coherence';
import { blockoutScad } from '@/lib/spec-sheet/blockout-scad';
import { auditFixture } from '../placement/harness';
import { checkIntent, intentScore, type Fact, type FactResult } from './intent';

const RESULTS_DIR = path.join(__dirname, '..', 'results');
const RENDERS = path.join(RESULTS_DIR, 'architect-renders');
const LABEL_FILES = ['intent-labels.json', 'intent-labels-orientation.json'];

function loadLabels(): Record<string, Fact[]> {
  const out: Record<string, Fact[]> = {};
  for (const f of LABEL_FILES) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) Object.assign(out, JSON.parse(fs.readFileSync(p, 'utf8')).prompts);
  }
  return out;
}

/** The spec with boundingBox replaced by the envelope of its own parts: the box code would compute. */
export function withComputedBoundingBox(spec: AssemblySpec): AssemblySpec {
  const env = impliedEnvelope(spec);
  if (!env) return spec;
  return { ...spec, boundingBox: { width: env.size[0], length: env.size[1], height: env.size[2] } };
}

async function auditErrors(spec: AssemblySpec): Promise<string[]> {
  const audit = await auditFixture({ name: spec.assemblyName, intent: '', spec, code: blockoutScad(spec).code });
  return audit.violations.filter((v) => v.severity === 'error').map((v) => v.kind);
}

interface Row {
  run: string;
  id: string;
  prompt: string;
  variant: string;
  facts: FactResult[];
  allPass: boolean;
  passed: number;
  checked: number;
  declaredClean: boolean;
  computedClean: boolean;
}

async function main() {
  const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
  const only = flag('--only')?.split(',') ?? null;
  const prefix = flag('--results');
  const intentOnly = process.argv.includes('--intent-only');
  const labels = loadLabels();
  // run name -> its specs, from renders or straight from results files
  const sources = new Map<string, () => Record<string, AssemblySpec>>();
  if (prefix) {
    for (const f of fs.readdirSync(RESULTS_DIR).filter((x) => x.startsWith(`architect-${prefix}`) && x.endsWith('.json')).sort()) {
      const run = f.replace(/^architect-/, '').replace(/-\d+\.json$/, '');
      sources.set(run, () => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8')).specs ?? {});
    }
  } else {
    for (const d of fs.readdirSync(RENDERS).filter((x) => fs.existsSync(path.join(RENDERS, x, 'specs.json')))) {
      sources.set(d, () => JSON.parse(fs.readFileSync(path.join(RENDERS, d, 'specs.json'), 'utf8')).specs);
    }
  }
  const runs = [...sources.keys()].filter((r) => !only || only.includes(r));
  const rows: Row[] = [];
  for (const run of runs) {
    const specs = sources.get(run)!();
    for (const [id, spec] of Object.entries(specs)) {
      const m = id.match(/^(.*)-s(\d+)-([ABC])$/);
      if (!m || !labels[m[1]]) continue;
      const facts = checkIntent(spec, labels[m[1]]);
      const { passed, checked, allPass } = intentScore(facts);
      const declared = intentOnly ? null : await auditErrors(spec);
      const computed = intentOnly ? null : await auditErrors(withComputedBoundingBox(spec));
      rows.push({ run, id, prompt: m[1], variant: m[3], facts, allPass, passed, checked, declaredClean: declared?.length === 0, computedClean: computed?.length === 0 });
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
  console.log('run | specs | intent all-pass (A) | intent all-pass (any variant) | facts passed | audit-clean declared box | computed box');
  const summary: Record<string, unknown>[] = [];
  for (const run of runs) {
    const r = rows.filter((x) => x.run === run);
    const a = r.filter((x) => x.variant === 'A');
    const groups = new Map<string, boolean>();
    for (const x of r) {
      const key = x.id.replace(/-[ABC]$/, '');
      groups.set(key, (groups.get(key) ?? false) || x.allPass);
    }
    const anyPass = [...groups.values()].filter(Boolean).length;
    const passed = r.reduce((s, x) => s + x.passed, 0), checked = r.reduce((s, x) => s + x.checked, 0);
    const row = {
      run, specs: r.length,
      intentA: pct(a.filter((x) => x.allPass).length, a.length),
      intentAny: pct(anyPass, groups.size),
      facts: pct(passed, checked),
      declaredClean: intentOnly ? '-' : pct(r.filter((x) => x.declaredClean).length, r.length),
      computedClean: intentOnly ? '-' : pct(r.filter((x) => x.computedClean).length, r.length),
    };
    summary.push(row);
    console.log(Object.values(row).join(' | '));
  }
  const out = path.join(RESULTS_DIR, `architect-rescore-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  console.log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
