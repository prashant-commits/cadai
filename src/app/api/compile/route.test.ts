import { describe, it, expect, vi, beforeEach } from 'vitest';
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
