import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { getArtifactStore } from '@/lib/runs/artifact-store';
import { GET } from './[id]/route';

const saved = { ...process.env };
let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-art-route-'));
  process.env.CADAI_RUN_DIR = dir;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (id: string, headers: Record<string, string> = {}) =>
  GET(new NextRequest(`http://localhost/api/artifacts/${id}`, { headers }), { params: Promise.resolve({ id }) });

describe('GET /api/artifacts/:id', () => {
  it.each([
    ['stl', 'model/stl'],
    ['step', 'model/step'],
    ['svg', 'image/svg+xml'],
    ['png', 'image/png'],
    ['scad', 'text/plain; charset=utf-8'],
    ['py', 'text/plain; charset=utf-8'],
  ] as const)('serves %s as %s with cache headers', async (kind, type) => {
    const ref = await getArtifactStore().put('r1', kind, `payload-${kind}`);
    const res = await get(ref.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.get('content-length')).toBe(String(`payload-${kind}`.length));
    expect(res.headers.get('etag')).toBe(`"${ref.sha256}"`);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(`payload-${kind}`);
  });

  it('streams a multi-MB body intact', async () => {
    const big = 'facet\n'.repeat(500_000);
    const ref = await getArtifactStore().put('r1', 'stl', big);
    const res = await get(ref.id);
    expect(res.headers.get('content-length')).toBe(String(big.length));
    expect((await res.text()).length).toBe(big.length);
  });

  it('locks svg down with a CSP; other kinds carry none', async () => {
    const svg = await getArtifactStore().put('r1', 'svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const stl = await getArtifactStore().put('r1', 'stl', 'solid');
    expect((await get(svg.id)).headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect((await get(stl.id)).headers.get('content-security-policy')).toBeNull();
  });

  it('answers If-None-Match with 304 and no body', async () => {
    const ref = await getArtifactStore().put('r1', 'stl', 'solid');
    const etag = `"${ref.sha256}"`;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const res = await get(ref.id, { 'If-None-Match': header });
      expect(res.status).toBe(304);
      expect(res.headers.get('etag')).toBe(etag);
      expect(await res.text()).toBe('');
    }
    expect((await get(ref.id, { 'If-None-Match': '"nope"' })).status).toBe(200);
  });

  it('unknown id is a 404 ErrorBody (not_found)', async () => {
    const res = await get('a'.repeat(32));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.apiError.code).toBe('not_found');
    expect(typeof body.error).toBe('string');
    expect(body.error).toBe(body.apiError.message);
  });

  it.each(['zzz', '..%2F..%2Fetc', 'A'.repeat(32), 'a'.repeat(64)])('invalid id %s is a 400 bad_request', async (id) => {
    const res = await get(id);
    expect(res.status).toBe(400);
    expect((await res.json()).apiError.code).toBe('bad_request');
  });
});
