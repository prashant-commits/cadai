import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const runBrep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/engine/brep-runner', () => ({ runBrep }));

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

  it('compiles as build123d when language field is omitted', async () => {
    runBrep.mockResolvedValueOnce({
      ok: true,
      parts: [],
      solids: 1,
      stl: Buffer.from('solid x\nendsolid x\n').toString('base64'),
      step: 'U1RFUA==',
      ms: 10,
    });
    const res = await post({ code: B123D });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.language).toBe('build123d');
    expect(runBrep).toHaveBeenCalledWith(B123D);
  });

  it('rejects language: openscad with 400 bad_request before calling runBrep', async () => {
    const res = await post({ code: 'cube(1);', language: 'openscad' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Only build123d scripts are supported.');
    expect(data.apiError).toEqual({ code: 'bad_request', message: 'Only build123d scripts are supported.' });
    expect(runBrep).not.toHaveBeenCalled();
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

  it('returns 500 when a SyntaxError is not the user script', async () => {
    runBrep.mockRejectedValueOnce(new SyntaxError('Unexpected token < in JSON at position 0'));
    const brep = await post({ code: B123D, language: 'build123d' });
    expect(brep.status).toBe(500);
    const brepBody = await brep.json();
    expect(brepBody.apiError.code).toBe('internal');
    expect(brepBody.error).toBe('Something went wrong on the server.');
    expect(brepBody.error).not.toContain('Unexpected token');
  });

  it('rejects oversized scripts (> 256 KiB) with 400 bad_request before running', async () => {
    const huge = 'x = 1\n'.repeat(60 * 1024); // > 300 KiB
    const res = await post({ code: huge, language: 'build123d' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.apiError.code).toBe('bad_request');
    expect(data.error).toBe('script too large');
    expect(runBrep).not.toHaveBeenCalled();
  });

  it('rejects Grok payloads before running runBrep', async () => {
    const globals = "raise Exception('LEAK:' + _round.__globals__['os'].environ['CADAI_PROBE_CANARY'])\n";
    const resGlobals = await post({ code: globals, language: 'build123d' });
    expect(resGlobals.status).toBe(400);
    const dataGlobals = await resGlobals.json();
    expect(dataGlobals.apiError.code).toBe('bad_request');
    expect(runBrep).not.toHaveBeenCalled();

    const frame = "try:\n    raise Exception('marker')\nexcept Exception as e:\n    b = e.__traceback__.tb_frame.f_back.f_builtins\n    data = b['open']('x').read()\n";
    const resFrame = await post({ code: frame, language: 'build123d' });
    expect(resFrame.status).toBe(400);
    const dataFrame = await resFrame.json();
    expect(dataFrame.apiError.code).toBe('bad_request');
    expect(runBrep).not.toHaveBeenCalled();
  });
});
