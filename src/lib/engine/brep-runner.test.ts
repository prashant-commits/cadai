import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runBrep } from './brep-runner';

// P1 Task 2 acceptance. Local backend: needs a build123d interpreter (CADAI_GEO_PYTHON
// or geo/.venv/bin/python) and the cadai_geo package (geo/ on the import path).
const py = process.env.CADAI_GEO_PYTHON ?? 'geo/.venv/bin/python';
const geoReady = existsSync(py) && existsSync('geo/cadai_geo/__main__.py');
const local = geoReady ? it : it.skip;
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

const TWO = `from build123d import *
a = Box(10, 20, 30, align=(Align.MIN, Align.MIN, Align.MIN)); a.label = 'base'
b = Pos(0, 0, 30) * Box(10, 20, 5, align=(Align.MIN, Align.MIN, Align.MIN)); b.label = 'lid'
result = Compound([a, b])
`;

describe('runBrep (local backend)', () => {
  local('runs a two-part script and returns labelled parts, STL and STEP', async () => {
    delete process.env.CADAI_GEO_URL;
    const r = await runBrep(TWO);
    expect(r.ok, r.error).toBe(true);
    expect(r.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(r.bbox?.max).toEqual([10, 20, 35]);
    expect(Buffer.from(r.step!, 'base64').subarray(0, 13).toString()).toBe('ISO-10303-21;');
    expect(r.stl && r.stl.length).toBeGreaterThan(0);
    expect(r.ms).toBeGreaterThan(0);
  }, 120_000);

  local('returns ok:false with the traceback tail', async () => {
    delete process.env.CADAI_GEO_URL;
    const r = await runBrep('from build123d import *\nresult = Cylinder(3, 10, axis=(1, 0, 0))\n');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/TypeError/);
  }, 120_000);

  local('kills a script that runs past timeoutMs', async () => {
    delete process.env.CADAI_GEO_URL;
    const r = await runBrep('import time\ntime.sleep(30)\n', { timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
  }, 60_000);
});

describe('runBrep (http backend)', () => {
  it('POSTs the script with the token and decodes the response', async () => {
    process.env.CADAI_GEO_URL = 'https://geo.example.test';
    process.env.CADAI_GEO_TOKEN = 'tok';
    const calls: { url: string; init: RequestInit }[] = [];
    const fake: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ ok: true, parts: [{ label: 'x', valid: true, volume: 1, min: [0, 0, 0], max: [1, 1, 1] }], solids: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, stl: 'c3Rs', step: 'c3RlcA==' }), { status: 200 });
    };
    const r = await runBrep('result = 1', { fetchImpl: fake });
    expect(calls[0].url).toBe('https://geo.example.test/run');
    expect((calls[0].init.headers as Record<string, string>)['x-cadai-geo-token']).toBe('tok');
    expect(JSON.parse(String(calls[0].init.body)).script).toBe('result = 1');
    expect(r.ok).toBe(true);
    expect(r.parts[0].label).toBe('x');
  });

  it('reports an unreachable service as ok:false, never throws', async () => {
    process.env.CADAI_GEO_URL = 'https://geo.example.test';
    const r = await runBrep('result = 1', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED|unreachable/);
  });
});
