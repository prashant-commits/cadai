import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { BrepResult } from '../../src/lib/engine/brep-runner';
import { renderStlViews, type RenderOptions, type ViewName } from '../../src/lib/engine/stl-renderer';
import { assignLetters, buildBlind, parseBlindArgs, writeBlind, type BlindDeps } from './blind';
import { SEED, type Arm, type RunRecord, type SetName } from './types';

const TMP = path.resolve('/home/claude/work/wt-ev-rep/.cadai/tasks/tmp');
const dirs: string[] = [];

const TRIANGLE = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 10 0 0
  vertex 0 10 5
 endloop
endfacet
endsolid t
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, 'blind-'));
  dirs.push(dir);
  return dir;
}

function writeRun(root: string, tag: string, arm: Arm, promptId: string, set: SetName, script: string): void {
  const dir = path.join(root, tag, arm);
  mkdirSync(dir, { recursive: true });
  const stlName = `${promptId}.stl`;
  writeFileSync(path.join(dir, stlName), TRIANGLE);
  const record: RunRecord = {
    tag,
    arm,
    promptId,
    set,
    sample: 0,
    model: 'test',
    startedAt: '2026-11-08T00:00:00Z',
    steps: [{
      step: 0,
      text: `A ${promptId} for the desk`,
      script,
      facts: null,
      stlPath: stlName,
      costUsd: 0.1,
      wallMs: 1000,
      turns: 1,
      reviewerFlags: [],
    }],
  };
  writeFileSync(path.join(dir, `${promptId}-s0.json`), JSON.stringify(record));
}

function casesFrom(html: string): Array<{ id: string; designs: Array<{ letter: string; missing: boolean; img: Record<string, string> }> }> {
  const match = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('page is missing its data');
  return JSON.parse(match[1]) as Array<{ id: string; designs: Array<{ letter: string; missing: boolean; img: Record<string, string> }> }>;
}

function visible(html: string): string {
  return html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, '');
}

describe('assignLetters', () => {
  it('is a stable permutation seeded by the prompt id', () => {
    expect(assignLetters('dock', 4)).toEqual(assignLetters('dock', 4));
    expect(assignLetters('dock', 4, SEED)).toEqual(assignLetters('dock', 4));
    expect([...assignLetters('dock', 3)].sort()).toEqual(['A', 'B', 'C']);
    const permutations = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => assignLetters(id, 4).join('')));
    expect(permutations.size).toBeGreaterThan(1);
    const base = assignLetters('dock', 5, SEED).join('');
    const changed = Array.from({ length: 30 }, (_, index) => assignLetters('dock', 5, index + 1).join('')).some((value) => value !== base);
    expect(changed).toBe(true);
  });
});

describe('renderStlViews', () => {
  it('returns grey png data uris for iso, back and front', () => {
    const views = renderStlViews(TRIANGLE, { views: ['iso', 'back_iso', 'front'], size: 16 });
    expect(views.map((view) => view.name)).toEqual(['iso', 'back_iso', 'front']);
    expect(views.every((view) => view.dataUrl.startsWith('data:image/png;base64,'))).toBe(true);
  });
});

describe('blind page', () => {
  const POSE = 'width = 40\nlid_open_deg = 0  # [0:5:110] lid\nresult = Box(width, 10, 10)\n';
  const PLAIN = 'result = Box(1, 1, 1)\n';

  function deps(): { deps: BlindDeps; scripts: string[]; views: ViewName[][] } {
    const scripts: string[] = [];
    const views: ViewName[][] = [];
    const blindDeps: BlindDeps = {
      async runBrep(script) {
        scripts.push(script);
        const result: BrepResult = {
          ok: true,
          parts: [],
          solids: 1,
          ms: 1,
          stl: Buffer.from(TRIANGLE, 'utf8').toString('base64'),
        };
        return result;
      },
      renderStlViews(_stl, opts?: RenderOptions) {
        const names = opts?.views ?? [];
        views.push(names);
        return names.map((name) => ({ name, dataUrl: `data:image/png;base64,${Buffer.from(name).toString('base64')}` }));
      },
    };
    return { deps: blindDeps, scripts, views };
  }

  it('renders every arm, keeps the key out of the html, and stays seeded', async () => {
    const root = scratch();
    const results = path.join(root, 'results');
    const baselines = path.join(root, 'baselines');
    mkdirSync(baselines, { recursive: true });
    writeRun(results, 'ev-blind', 'designer', 'dock', 'open', POSE);
    writeRun(results, 'ev-blind', 'reviewer', 'dock', 'open', PLAIN);
    writeRun(results, 'ev-blind', 'designer', 'hinge', 'mechanism', PLAIN);
    writeFileSync(path.join(baselines, 'dock.stl'), TRIANGLE);
    writeFileSync(path.join(baselines, 'manifest.json'), JSON.stringify({
      dock: { source: 'pipeline-abv2', stlPath: 'dock.stl' },
    }));
    const { deps: blindDeps, scripts, views } = deps();
    const built = await buildBlind({
      tag: 'ev-blind',
      resultsDir: results,
      setName: 'open',
      withBaselines: true,
      baselinesDir: baselines,
      renderSize: 16,
    }, blindDeps);
    const again = await buildBlind({
      tag: 'ev-blind',
      resultsDir: results,
      setName: 'open',
      withBaselines: true,
      baselinesDir: baselines,
      renderSize: 16,
    }, deps().deps);
    expect(again.key).toEqual(built.key);

    const letters = assignLetters('dock', 3);
    expect(built.key.dock[letters[0]]).toMatchObject({ arm: 'designer', kind: 'run', sample: 0 });
    expect(built.key.dock[letters[1]]).toMatchObject({ arm: 'reviewer', kind: 'run', sample: 0 });
    expect(built.key.dock[letters[2]]).toMatchObject({ arm: 'pipeline-abv2', kind: 'baseline', source: 'pipeline-abv2' });
    expect(built.key.hinge).toBeUndefined();

    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('lid_open_deg = 110');
    expect(views[0]).toEqual(['iso', 'back_iso', 'front']);
    expect(views.some((names) => names.length === 1 && names[0] === 'iso')).toBe(true);

    const cases = casesFrom(built.html);
    expect(cases.map((item) => item.id)).toEqual(['dock']);
    const designer = cases[0].designs.find((design) => design.letter === letters[0]);
    const reviewer = cases[0].designs.find((design) => design.letter === letters[1]);
    expect(designer?.img.iso).toMatch(/^data:image\/png;base64,/);
    expect(designer?.img.back_iso).toMatch(/^data:image\/png;base64,/);
    expect(designer?.img.front).toMatch(/^data:image\/png;base64,/);
    expect(designer?.img.open).toMatch(/^data:image\/png;base64,/);
    expect(reviewer?.img.open).toBeUndefined();
    expect(cases[0].designs.every((design) => !('arm' in design))).toBe(true);

    const stripped = visible(built.html);
    expect(stripped).not.toMatch(/\bdesigner\b/);
    expect(stripped).not.toMatch(/\breviewer\b/);
    expect(stripped).not.toContain('pipeline-abv2');
    expect(built.html).toContain('--bg: #eef0ee');
    expect(built.html).toContain('prefers-color-scheme: dark');
    expect(built.html).toContain('minmax(230px, 1fr)');
    expect(built.html).toContain('data-theme="dark"');
    expect(built.html).toContain('Reveal which is which');
    expect(built.html).toContain('Copy picks as JSON');
    expect(built.html).toContain('window.cadaiSavePick?.(promptId, letter, arm)');
    expect(built.html).toMatch(/try \{[\s\S]*localStorage\.setItem[\s\S]*\} catch/);
    expect(built.html).toContain('navigator.clipboard');
    expect(built.html).toContain('Clipboard refused');

    const written = await writeBlind({
      tag: 'ev-blind',
      resultsDir: results,
      setName: 'open',
      withBaselines: true,
      baselinesDir: baselines,
      renderSize: 16,
    }, deps().deps);
    const html = visible(readFileSync(written.htmlPath, 'utf8'));
    expect(html).not.toContain('pipeline-abv2');
    expect(html).not.toMatch(/\bdesigner\b/);
    expect(JSON.parse(readFileSync(written.keyPath, 'utf8'))).toEqual(built.key);
  });

  it('leaves a failed render as a missing design and does not throw', async () => {
    const root = scratch();
    const results = path.join(root, 'results');
    const dir = path.join(results, 'ev-blind', 'designer');
    mkdirSync(dir, { recursive: true });
    const record: RunRecord = {
      tag: 'ev-blind',
      arm: 'designer',
      promptId: 'dock',
      set: 'open',
      sample: 0,
      model: 'test',
      startedAt: '2026-11-08T00:00:00Z',
      steps: [{
        step: 0,
        text: 'A dock for the desk',
        script: 'result = Box(1, 1, 1)\n',
        facts: null,
        costUsd: 0,
        wallMs: 0,
        turns: 1,
        reviewerFlags: [],
      }],
    };
    writeFileSync(path.join(dir, 'dock-s0.json'), JSON.stringify(record));
    let calls = 0;
    const built = await buildBlind({ tag: 'ev-blind', resultsDir: results, renderSize: 16 }, {
      async runBrep() {
        calls += 1;
        return { ok: false, error: 'nope', parts: [], solids: 0, ms: 1 };
      },
    });
    expect(calls).toBe(1);
    expect(casesFrom(built.html)[0].designs[0].missing).toBe(true);
  });
});

describe('parseBlindArgs', () => {
  it('reads the set filter and the baselines flag', () => {
    expect(parseBlindArgs(['--tag', 't', '--set', 'open', '--with-baselines'])).toMatchObject({
      tag: 't',
      setName: 'open',
      withBaselines: true,
    });
    expect(() => parseBlindArgs(['--set', 'open'])).toThrow(/--tag/);
    expect(() => parseBlindArgs(['--tag', 't', '--set', 'nope'])).toThrow(/Unknown set/);
  });
});
