import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getArtifactStore } from '@/lib/runs/artifact-store';
import * as brepRunner from '@/lib/engine/brep-runner';
import { withGeneratedPrelude } from '@/lib/brep/prelude';
import { POST } from './route';

const VALID_CODE = `
from build123d import Box
result = Box(10, 10, 10)
`;

const EMPTY_CODE = `   `;

describe('/api/compile API Route', () => {
  it('returns inline stl AND artifact refs that resolve to the same bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-compile-'));
    process.env.CADAI_RUN_DIR = dir;
    try {
      const res = await POST(new NextRequest('http://localhost:3000/api/compile', { method: 'POST', body: JSON.stringify({ code: VALID_CODE }) }));
      const data = await res.json();
      expect(data.stl).toContain('facet normal');
      expect(data.artifacts.stl).toMatchObject({ kind: 'stl', bytes: Buffer.byteLength(data.stl) });
      const got = await getArtifactStore().get(data.artifacts.stl.id);
      const chunks: Buffer[] = [];
      for await (const c of got!.stream) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString('utf-8')).toBe(data.stl);
      // held by a synthetic compile-<sha> run, which the same code reuses
      const runs = fs.readdirSync(path.join(dir, 'artifacts', 'runs'));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatch(/^compile-[0-9a-f]{24}$/);
      const again = await (await POST(new NextRequest('http://localhost:3000/api/compile', { method: 'POST', body: JSON.stringify({ code: VALID_CODE }) }))).json();
      expect(again.artifacts.stl.id).toBe(data.artifacts.stl.id);
    } finally {
      delete process.env.CADAI_RUN_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2: the compile byte cap evicts the least recently used compile run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-compile-cap-'));
    process.env.CADAI_RUN_DIR = dir;
    try {
      const compile = async (code: string) => (await (await POST(new NextRequest('http://localhost:3000/api/compile', { method: 'POST', body: JSON.stringify({ code }) }))).json());
      const first = await compile('from build123d import Box\nresult = Box(1, 1, 1)\n');
      const firstBytes = (first.artifacts.stl?.bytes ?? 0) + (first.artifacts.step?.bytes ?? 0);
      process.env.CADAI_COMPILE_ARTIFACT_MAX_BYTES = String(firstBytes + 10); // room for one
      const second = await compile('from build123d import Box\nresult = Box(2, 2, 2)\n');
      expect(await getArtifactStore().get(second.artifacts.stl.id)).toBeDefined();
      expect(await getArtifactStore().get(first.artifacts.stl.id)).toBeUndefined();
      expect(second.stl).toContain('facet normal'); // inline is unaffected
    } finally {
      delete process.env.CADAI_RUN_DIR;
      delete process.env.CADAI_COMPILE_ARTIFACT_MAX_BYTES;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 400 for empty code defaulting to build123d', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      body: JSON.stringify({ code: EMPTY_CODE }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('build123d code is required.');
    expect(data.apiError).toEqual({ code: 'bad_request', message: 'build123d code is required.' });
  });

  it('asks for build123d code when that language is requested and the body is empty', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      body: JSON.stringify({ code: EMPTY_CODE, language: 'build123d' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('build123d code is required.');
    expect(data.apiError.code).toBe('bad_request');
  });

  it('returns 400 for a malformed JSON body', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      body: '{',
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.apiError.code).toBe('bad_request');
    expect(data.error).toBe(data.apiError.message);
  });

  it('/api/compile prepends the prelude of the given version when the sentinel is absent', async () => {
    const body = 'width = 10\nresult = Box(width, 10, 10)\n';
    const fakeBrepResult: brepRunner.BrepResult = {
      ok: true,
      solids: 1,
      parts: [{ label: 'part_1', valid: true, volume: 1000, min: [0, 0, 0], max: [10, 10, 10] }],
      stl: Buffer.from('solid m\nendsolid\n').toString('base64'),
      ms: 5,
    };
    const spy = vi.spyOn(brepRunner, 'runBrep').mockImplementation(async () => fakeBrepResult);

    try {
      // 1. body-only request with preludeVersion: '1'
      const req1 = new NextRequest('http://localhost:3000/api/compile', {
        method: 'POST',
        body: JSON.stringify({ code: body, preludeVersion: '1' }),
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);
      expect(spy).toHaveBeenLastCalledWith(withGeneratedPrelude(body, '1'));

      // 2. body-only request with no preludeVersion
      const req2 = new NextRequest('http://localhost:3000/api/compile', {
        method: 'POST',
        body: JSON.stringify({ code: body }),
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(200);
      expect(spy).toHaveBeenLastCalledWith(withGeneratedPrelude(body, '1'));

      // 3. a script that already has the sentinel is passed through unchanged
      const sentinelScript = withGeneratedPrelude(body, '1');
      const req3 = new NextRequest('http://localhost:3000/api/compile', {
        method: 'POST',
        body: JSON.stringify({ code: sentinelScript }),
      });
      const res3 = await POST(req3);
      expect(res3.status).toBe(200);
      expect(spy).toHaveBeenLastCalledWith(sentinelScript);

      // 4. preludeVersion: 'nope' -> 400 and runBrep not called
      spy.mockClear();
      const req4 = new NextRequest('http://localhost:3000/api/compile', {
        method: 'POST',
        body: JSON.stringify({ code: body, preludeVersion: 'nope' }),
      });
      const res4 = await POST(req4);
      expect(res4.status).toBe(400);
      const json4 = await res4.json();
      expect(json4.error).toBe('Unknown prelude version.');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
