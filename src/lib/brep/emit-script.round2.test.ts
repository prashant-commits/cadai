import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import type { AgentStateType } from '@/lib/agent/graph';
import { makeBrepBuild } from '@/lib/agent/nodes/brep-build';
import { auditPlacement } from '@/lib/agent/placement-audit';
import { normalizeSpec } from '@/lib/agent/spec-normalize';
import { localChildEnv, localRunnerRefusal, type BrepResult } from '@/lib/engine/brep-runner';
import { blockoutScad } from '@/lib/spec-sheet/blockout-scad';
import { emitBrepScript } from './emit-script';
import { localOriginViolations, toModuleFrames, toPlacementReport } from './measurements';
import { geoPython, runGeoCliForTest } from './test-run';

const run = existsSync(geoPython()) ? it : it.skip;

const base = { sheet: '', assemblyName: 'a', assumptions: [], openQuestions: [] };
const param = (name: string, value: number) => ({ name, value, min: 0, max: 1000, unit: 'mm', description: `${name} doc` });
const comp = (name: string, extents: unknown[], position: unknown[], extra: Record<string, unknown> = {}) =>
  ({ name, description: '', localExtents: extents, position, ...extra });
const spec = (s: Record<string, unknown>) => normalizeSpec({ ...base, ...s } as unknown as AssemblySpec);

/** Runs the emitted script through this checkout's geo CLI and audits it the way validateBrep does. */
async function audit(s: AssemblySpec, bodies: Record<string, string> = {}) {
  const r = (await runGeoCliForTest(emitBrepScript(s, bodies).script)) as unknown as BrepResult;
  expect(r.ok, r.error).toBe(true);
  const frames = toModuleFrames(r);
  const local = toModuleFrames({ ...r, parts: r.local ?? [] });
  const violations = [
    ...auditPlacement(toPlacementReport(s, frames, local), r.bbox?.min ?? null, s),
    ...localOriginViolations(s, local),
  ];
  return violations.filter((v) => v.severity === 'error').map((v) => `${v.kind}:${v.field}`);
}

describe('own-frame size is exact for rotated non-box shapes (M1)', () => {
  run('a correct triangle profile rotated 30 degrees has no extents violation', async () => {
    const s = spec({
      components: [comp('tri', [40, 5, 40], [50, 0, 30], { rotation: [0, 30, 0], shape: { kind: 'profile', plane: 'xz', points: [[0, 0], [40, 0], [0, 40]] } })],
    });
    expect((await audit(s)).filter((v) => v.startsWith('extents'))).toEqual([]);
  }, 120_000);

  run('saved spec phone_stand-s0-B (rotated profile backrest) has no false extents violation', async () => {
    const raw = JSON.parse(readFileSync('src/lib/brep/__fixtures__/phone_stand-s0-B.spec.json', 'utf-8'));
    const s = normalizeSpec(raw as AssemblySpec);
    expect((await audit(s)).filter((v) => v.startsWith('extents'))).toEqual([]);
  }, 120_000);
});

describe('own-frame origin is checked (M2)', () => {
  const plate = () => spec({ components: [comp('plate', [40, 20, 10], [30, 30, 0])] });
  const turned = () => spec({ components: [comp('plate', [40, 20, 10], [30, 30, 0], { rotation: [0, 0, 45] })] });

  run('a correct body has no local_frame violation', async () => {
    expect(await audit(plate())).toEqual([]);
  }, 120_000);
  run('a body shifted 100 mm is reported', async () => {
    const v = await audit(plate(), { plate: 'return Pos(100, 0, 0) * Box(40, 20, 10, align=(Align.MIN, Align.MIN, Align.MIN))' });
    expect(v).toContain('local_frame:plate');
  }, 120_000);
  run('a body built with align=MAX on y is reported', async () => {
    const v = await audit(plate(), { plate: 'return Box(40, 20, 10, align=(Align.MIN, Align.MAX, Align.MIN))' });
    expect(v).toContain('local_frame:plate');
  }, 120_000);
  run('a centred body on a rotated part is reported', async () => {
    const v = await audit(turned(), { plate: 'return Box(40, 20, 10)' });
    expect(v).toContain('local_frame:plate');
  }, 120_000);
});

describe('one-argument min/max (M4)', () => {
  run('a derived max(w) runs', async () => {
    const s = spec({ parameters: [param('w', 12)], derived: [{ name: 'h', expr: 'max(w)' }, { name: 'k', expr: 'min(w) / 2' }], components: [comp('p', [10, 'k', 'h'], [0, 0, 0])] });
    const r = await runGeoCliForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    const p = r.parts.find((x) => x.label === 'p')!;
    expect(p.max[2] - p.min[2]).toBeCloseTo(12, 2);
    expect(p.max[1] - p.min[1]).toBeCloseTo(6, 2);
  }, 120_000);
});

describe('depth 0 means a through hole (L5)', () => {
  run('a depth: 0 hole cuts all the way through', async () => {
    const s = spec({ components: [comp('plate', [40, 40, 5], [0, 0, 0], { holes: [{ d: 6, at: [20, 20, 5], axis: 'z', depth: 0 }] })] });
    const r = await runGeoCliForTest(emitBrepScript(s).script);
    expect(r.ok, r.error).toBe(true);
    expect(r.parts[0].volume).toBeCloseTo(40 * 40 * 5 - Math.PI * 9 * 5, 0);
  }, 120_000);
});

describe('the emitter notes reach the validation report (M5)', () => {
  it('brepBuild keeps the skipped list on state and validateBrep reports each as a build warning', async () => {
    const raw = {
      ...base,
      parameters: [param('w', 10)],
      derived: [{ name: 'h', expr: 'w ** 2' }],
      components: [comp('plate', [10, 10, 5], [0, 0, 0])],
    } as unknown as AssemblySpec;
    const build = makeBrepBuild({ invoke: async () => new AIMessage('@body plate\nreturn Box(10, 10, 5, align=(Align.MIN, Align.MIN, Align.MIN))\n@end') });
    const state = { assemblySpec: raw, attemptCount: 0, currentCode: null, specViolations: [], gateAction: null, gateFeedback: null } as unknown as AgentStateType;
    const out = await build(state);
    expect(out.buildNotes?.map((n) => n.name)).toEqual(['h']);

    vi.resetModules();
    vi.doMock('@/lib/engine/brep-runner', () => ({
      runBrep: async () => ({ ok: true, parts: [{ label: 'plate', valid: true, volume: 500, min: [0, 0, 0], max: [10, 10, 5] }], solids: 1, ms: 1 }),
    }));
    const { validateBrep } = await import('@/lib/agent/nodes/validate-brep');
    const report = await validateBrep({ ...state, ...out, semanticFailures: 0, compileFailures: 0, modelInfo: null } as unknown as AgentStateType);
    const build123 = report.specViolations?.filter((v) => v.kind === 'build') ?? [];
    expect(build123.map((v) => [v.field, v.severity])).toEqual([['h', 'warning']]);
    vi.doUnmock('@/lib/engine/brep-runner');
  });
});

describe('the local runner without a sandbox (H1d)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  it('refuses under NODE_ENV=production unless CADAI_GEO_ALLOW_LOCAL=1', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CADAI_GEO_ALLOW_LOCAL', '');
    expect(localRunnerRefusal()).toMatch(/disabled in production/);
    vi.stubEnv('CADAI_GEO_ALLOW_LOCAL', '1');
    expect(localRunnerRefusal()).toBeNull();
    vi.unstubAllEnvs();
  });
  it('runs in development (with a one-time warning)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(localRunnerRefusal()).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('the local runner child env (N3)', () => {
  it('passes the interpreter and geometry settings, not keys or the token', () => {
    const env = localChildEnv({
      PATH: '/usr/bin', HOME: '/home/u', TMPDIR: '/tmp', LANG: 'C.UTF-8', LC_ALL: 'C', PYTHONPATH: '/x',
      CADAI_GEO_PYTHON: '/venv/bin/python', CADAI_GEO_TOKEN: 'secret', CADAI_GEO_TOKEN_FILE: '/run/token',
      ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk', DATABASE_URL: 'postgres://', NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    expect(Object.keys(env).sort()).toEqual(['CADAI_GEO_PYTHON', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'PYTHONPATH', 'TMPDIR']);
  });
});

describe('only a literal depth of 0 means through (N5)', () => {
  const blindAt = (dDefault: number) =>
    spec({
      parameters: [param('dd', dDefault)],
      components: [comp('plate', [40, 30, 10], [0, 0, 0], { holes: [{ d: 6, axis: 'z', at: [20, 15, 0], depth: 'dd' }] })],
    });
  run('a parametric depth that is 0 at its default stays blind and follows the parameter', async () => {
    const { script } = emitBrepScript(blindAt(0));
    expect(script).toContain('max(dd, 0)');
    const at0 = await runGeoCliForTest(script);
    expect(at0.ok, at0.error).toBe(true);
    expect(at0.parts[0].volume).toBeCloseTo(40 * 30 * 10, 0); // a 0 mm blind hole, not through
    const at4 = await runGeoCliForTest(script.replace(/^dd = 0\b/m, 'dd = 4'));
    expect(at4.parts[0].volume).toBeCloseTo(40 * 30 * 10 - Math.PI * 9 * 4, 0);
  }, 120_000);
  it('the OpenSCAD blockout keeps a parametric depth blind too', () => {
    const { code } = blockoutScad(blindAt(0));
    expect(code).toContain('max(dd, 0)');
    expect(code).toMatch(/blind hole of plate/);
  });
});
