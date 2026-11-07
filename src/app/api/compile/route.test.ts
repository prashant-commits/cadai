import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

const VALID_CODE = `
cube([10, 10, 10]);
`;

const EMPTY_CODE = `   `;

const ERROR_CODE = `
cube([10, 10, 10]
`;

describe('/api/compile API Route', () => {
  it('returns 400 for empty code', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      body: JSON.stringify({ code: EMPTY_CODE }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('OpenSCAD code is required.');
    expect(data.apiError).toEqual({ code: 'bad_request', message: 'OpenSCAD code is required.' });
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
    // OpenSCAD has no per-part measurement. `parts` is only on build123d responses.
    expect(data.parts).toBeUndefined();
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
    expect(data.apiError.message).toBe(data.error);
    if (res.status === 422) expect(data.apiError.code).toBe('compile_failed');
  });
});
