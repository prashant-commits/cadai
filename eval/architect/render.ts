/**
 * Renders every spec of an Architect eval run as iso + front PNGs of its
 * composed blockout, and saves the specs themselves.
 *
 *   npm run eval:architect:render -- --model claude-sonnet-5-5 --tag s55
 *
 * The specs come from the newest results file for that tag and model, which
 * holds them for every run since specs were saved (all gateway runs). Older
 * Anthropic runs fall back to their variant batch (id in the .state.json file),
 * downloaded again: results stay available for 29 days and are not billed.
 *
 * Output: eval/results/architect-renders/<tag>-<model>/<prompt>-s<k>-<V>-{iso,front}.png
 * and specs.json beside them.
 */
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
for (const f of ['.env', '.env.local']) {
  try { process.loadEnvFile(f); } catch { /* absent is fine */ }
}

import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { blockoutScad } from '@/lib/spec-sheet/blockout-scad';
import { analyzeTopLevel, composeAssembly } from '@/lib/design/compose-assembly';
import { measureModuleFrames } from '@/lib/engine/module-frames';
import { validateOpenScadCode } from '@/lib/agent/code-validator';
import { renderStlViews } from '@/lib/engine/stl-renderer';
import { parseSpec, type Outcome } from './parse';

const RESULTS_DIR = path.join(__dirname, '..', 'results');

function parseArgs(argv: string[]): { model: string; tag: string; only: string[] } {
  const a = { model: '', tag: '', only: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') a.model = argv[++i];
    else if (argv[i] === '--tag') a.tag = argv[++i];
    else if (argv[i] === '--only') a.only = argv[++i].split(',');
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!a.model || !a.tag) throw new Error('--model and --tag are required');
  return a;
}

/** Same composition as eval/placement's auditFixture, returning the STL instead of the audit. */
async function compileBlockout(spec: AssemblySpec): Promise<string | null> {
  const code = blockoutScad(spec).code;
  const defined = new Set(analyzeTopLevel(code).moduleNames);
  const names = (spec.components ?? []).map((c) => c.name).filter((n) => defined.has(n));
  const frames = await measureModuleFrames(code, names);
  const composed = composeAssembly(code, spec, frames);
  const validation = await validateOpenScadCode(composed.code);
  return validation.valid && validation.stl ? validation.stl : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.join(RESULTS_DIR, 'architect-renders', `${args.tag}-${args.model}`);
  fs.mkdirSync(outDir, { recursive: true });
  const keep = (id: string) => args.only.length === 0 || args.only.some((p) => id.startsWith(`${p}-`));

  let specs: Record<string, AssemblySpec> = {};
  const failed: Record<string, string> = {};
  let source: string;
  const results = fs.readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith(`architect-${args.tag}-${args.model}-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  const saved = results.length ? JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, results[0]), 'utf8')) : null;
  if (saved?.specs) {
    source = results[0];
    specs = Object.fromEntries(Object.entries(saved.specs as Record<string, AssemblySpec>).filter(([id]) => keep(id)));
    for (const v of saved.variants as { promptId: string; sample: number; variantId: string; failure: string | null }[]) {
      const id = `${v.promptId}-s${v.sample}-${v.variantId}`;
      if (v.failure && keep(id)) failed[id] = v.failure;
    }
  } else {
    const stateFile = path.join(RESULTS_DIR, `.architect-${args.tag}-${args.model}.state.json`);
    const batchId: string | undefined = JSON.parse(fs.readFileSync(stateFile, 'utf8')).variant;
    if (!batchId) throw new Error(`${stateFile} has no variant batch and no results file holds specs`);
    source = batchId;
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    const client = new Anthropic(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {});
    for await (const r of await client.messages.batches.results(batchId)) {
      if (!keep(r.custom_id)) continue;
      const outcome: Outcome = r.result.type === 'succeeded' ? { message: r.result.message } : { error: r.result.type };
      const { spec, failure } = parseSpec(outcome);
      if (spec) specs[r.custom_id] = spec;
      else failed[r.custom_id] = failure ?? 'unknown';
    }
  }
  fs.writeFileSync(path.join(outDir, 'specs.json'), JSON.stringify({ source, specs, failed }, null, 2));

  let rendered = 0;
  for (const [id, spec] of Object.entries(specs).sort(([a], [b]) => a.localeCompare(b))) {
    const stl = await compileBlockout(spec);
    if (!stl) {
      console.warn(`${id}: blockout did not compile, no render`);
      continue;
    }
    for (const view of renderStlViews(stl, { size: 512, views: ['iso', 'front'] })) {
      fs.writeFileSync(path.join(outDir, `${id}-${view.name}.png`), Buffer.from(view.dataUrl.split(',')[1], 'base64'));
    }
    rendered++;
  }
  console.log(`${rendered} rendered, ${Object.keys(failed).length} unparsed -> ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
