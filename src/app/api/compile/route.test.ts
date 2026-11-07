import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getArtifactStore } from '@/lib/runs/artifact-store';
import { POST } from './route';

const VALID_CODE = `
cube([10, 10, 10]);
`;

const EMPTY_CODE = `   `;

const ERROR_CODE = `
cube([10, 10, 10]
`;

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

  it('returns 400 for empty code', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      body: JSON.stringify({ code: EMPTY_CODE }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it('compiles valid OpenSCAD code to STL', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      body: JSON.stringify({ code: VALID_CODE }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.stl).toContain('facet normal');
    expect(data.stl).toContain('endsolid');
  });

  it('returns error for invalid syntax', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      body: JSON.stringify({ code: ERROR_CODE }),
    });

    const res = await POST(req);
    // Even if openscad-wasm returns an empty STL or throws, we handle it
    const data = await res.json();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(data.error).toBeDefined();
  });
});
