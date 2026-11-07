import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const runBrep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/engine/brep-runner', () => ({ runBrep }));
vi.mock('@/lib/engine/scad-compiler', () => ({ compileScad: vi.fn() }));

import { compileScad } from '@/lib/engine/scad-compiler';
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
    runBrep.mockResolvedValue({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9', failure: 'unreachable', parts: [], solids: 0, ms: 1 });
    const res = await post({ code: B123D });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.apiError).toMatchObject({ code: 'geometry_unavailable', retryable: true });
    expect(data.apiError.message).toBe('The geometry service is unreachable.');
    expect(data.error).toBe(data.apiError.message);
  });

  it('returns 504 when the geometry service times out, and 422 when a script mentions timeout', async () => {
    runBrep.mockResolvedValueOnce({ ok: false, error: 'timeout', failure: 'timeout', parts: [], solids: 0, ms: 1 });
    const timedOut = await post({ code: B123D });
    expect(timedOut.status).toBe(504);
    const timedOutBody = await timedOut.json();
    expect(timedOutBody.apiError).toMatchObject({ code: 'geometry_unavailable', retryable: true });
    expect(timedOutBody.apiError.code).not.toBe('timeout');

    runBrep.mockResolvedValueOnce({
      ok: false,
      error: "NameError: name 'timeout' is not defined",
      parts: [],
      solids: 0,
      ms: 1,
    });
    const script = await post({ code: B123D });
    expect(script.status).toBe(422);
    const scriptBody = await script.json();
    expect(scriptBody.apiError).toEqual({
      code: 'geometry_failed',
      message: "NameError: name 'timeout' is not defined",
    });
  });

  it('uses the traceback exception line and strips paths', async () => {
    runBrep.mockResolvedValue({
      ok: false,
      failure: 'script',
      error: 'Traceback (most recent call last):\n  File "/tmp/cadai-brep-x/model.py", line 3, in <module>\nValueError: wall too thin',
      parts: [],
      solids: 0,
      ms: 4,
    });
    const res = await post({ code: B123D });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.apiError.message).toBe('ValueError: wall too thin');
    expect(data.apiError.detail).not.toContain('/tmp/');
    expect(data.error).toBe(data.apiError.message);
  });

  it('logs a malformed part once and returns the valid ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runBrep.mockResolvedValue({
      ok: true,
      parts: [
        { label: 'body', valid: true, volume: 1, min: [0, 0, 0], max: [1, 1, 1] },
        { label: 'bad' },
      ],
      solids: 1,
      ms: 3,
    });
    const res = await post({ code: B123D });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.parts).toEqual([{ label: 'body', valid: true, volume: 1, min: [0, 0, 0], max: [1, 1, 1] }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('returns 422 when the OpenSCAD compiler throws a script SyntaxError', async () => {
    vi.mocked(compileScad).mockRejectedValueOnce(new SyntaxError('bad indent in user script'));
    const res = await post({ code: 'cube(1);', language: 'openscad' });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.apiError.code).toBe('compile_failed');
    expect(data.apiError.code).not.toBe('bad_request');
    expect(data.error).toBe(data.apiError.message);
  });

  it('reports the first OpenSCAD ERROR line, not the generic last line', async () => {
    vi.mocked(compileScad).mockResolvedValueOnce({
      valid: false,
      error: "ERROR: Parser error: syntax error in file /in.scad, line 2\nCan't parse file '/in.scad'!",
      exitCode: 1,
      errors: [],
      warnings: [],
      compileTimeMs: 1,
      rawStderr: [],
    });
    const res = await post({ code: 'cube([1,2,3]', language: 'openscad' });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.apiError.code).toBe('compile_failed');
    expect(data.apiError.message).toBe('ERROR: Parser error: syntax error in file /in.scad, line 2');
    expect(data.error).toBe(data.apiError.message);
    expect(data.apiError.detail).toContain("Can't parse file '/in.scad'!");
  });

  it('returns 500 when a SyntaxError is not the user script', async () => {
    runBrep.mockRejectedValueOnce(new SyntaxError('Unexpected token < in JSON at position 0'));
    const brep = await post({ code: B123D, language: 'build123d' });
    expect(brep.status).toBe(500);
    const brepBody = await brep.json();
    expect(brepBody.apiError.code).toBe('internal');
    expect(brepBody.error).toBe('Something went wrong on the server.');
    expect(brepBody.error).not.toContain('Unexpected token');

    vi.mocked(compileScad).mockRejectedValueOnce(new SyntaxError('Unexpected token < in JSON at position 0'));
    const scad = await post({ code: 'cube(1);', language: 'openscad' });
    expect(scad.status).toBe(500);
    const scadBody = await scad.json();
    expect(scadBody.apiError.code).toBe('internal');
    expect(scadBody.apiError.code).not.toBe('compile_failed');
    expect(scadBody.apiError.code).not.toBe('bad_request');
  });
});
