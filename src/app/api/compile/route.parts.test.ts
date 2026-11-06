import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const runBrep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/engine/brep-runner', () => ({ runBrep }));
vi.mock('@/lib/engine/scad-compiler', () => ({ compileScad: vi.fn() }));

import { POST } from './route';

const B123D = 'from build123d import Box\n';

beforeEach(() => {
  runBrep.mockReset();
});

function post(body: unknown) {
  return POST(new NextRequest('http://localhost:3000/api/compile', {
    method: 'POST',
    body: JSON.stringify(body),
  }));
}

describe('/api/compile build123d contract', () => {
  it('returns PartInfo from runBrep parts', async () => {
    runBrep.mockResolvedValue({
      ok: true,
      parts: [{ label: 'body', valid: true, volume: 12.5, min: [0, 0, 0], max: [10, 20, 30] }],
      solids: 1,
      stl: Buffer.from('solid x\nendsolid x\n').toString('base64'),
      step: 'U1RFUA==',
      ms: 15,
    });
    const res = await post({ code: B123D });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.language).toBe('build123d');
    expect(data.parts).toEqual([
      { label: 'body', valid: true, volume: 12.5, min: [0, 0, 0], max: [10, 20, 30] },
    ]);
  });

  it('maps a runBrep script failure to geometry_failed', async () => {
    runBrep.mockResolvedValue({ ok: false, error: 'SyntaxError: bad indent', parts: [], solids: 0, ms: 4 });
    const res = await post({ code: B123D, language: 'build123d' });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('SyntaxError: bad indent');
    expect(data.apiError).toEqual({ code: 'geometry_failed', message: 'SyntaxError: bad indent' });
  });

  it('maps an unreachable geometry service to retryable geometry_unavailable', async () => {
    runBrep.mockResolvedValue({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9', parts: [], solids: 0, ms: 1 });
    const res = await post({ code: B123D });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.apiError).toMatchObject({ code: 'geometry_unavailable', retryable: true });
    expect(data.error).toBe(data.apiError.message);
  });
});
