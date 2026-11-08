import { describe, it, expect, vi, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import * as crypto from 'crypto';
import * as brepRunner from '@/lib/engine/brep-runner';
import { withGeneratedPrelude } from '@/lib/brep/prelude';
import { getObjectStore } from '@/lib/storage/object-store';
import { getDb, closeDb } from '@/lib/db/db';
import { POST } from './route';

const TEST_OWNER_UUID = crypto.randomUUID();
const OWNER_COOKIE = `cadai_owner=${TEST_OWNER_UUID}`;

const VALID_CODE = `
from build123d import Box
result = Box(10, 10, 10)
`;

const EMPTY_CODE = `   `;

describe('/api/compile API Route', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('no owner cookie → 401', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      body: JSON.stringify({ code: VALID_CODE }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('compile writes no artifact', async () => {
    const objectStore = getObjectStore();
    const objectStoreSpy = vi.spyOn(objectStore, 'put');
    const db = getDb();
    const beforeCount = Number(
      (await db.query(`SELECT count(*)::int as c FROM artifacts`)).rows[0].c
    );

    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      headers: { cookie: OWNER_COOKIE },
      body: JSON.stringify({ code: VALID_CODE }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.stl).toContain('facet normal');
    expect(data.artifacts).toBeUndefined();
    expect(objectStoreSpy).not.toHaveBeenCalled();

    const afterCount = Number(
      (await db.query(`SELECT count(*)::int as c FROM artifacts`)).rows[0].c
    );
    expect(afterCount).toBe(beforeCount);
  });

  it('returns 400 for empty code defaulting to build123d', async () => {
    const req = new NextRequest('http://localhost:3000/api/compile', {
      method: 'POST',
      headers: { cookie: OWNER_COOKIE },
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
      headers: { cookie: OWNER_COOKIE },
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
      headers: {
        cookie: OWNER_COOKIE,
        'content-type': 'application/json',
      },
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
        headers: { cookie: OWNER_COOKIE },
        body: JSON.stringify({ code: body, preludeVersion: '1' }),
      });
      const res1 = await POST(req1);
      expect(res1.status).toBe(200);
      expect(spy).toHaveBeenLastCalledWith(withGeneratedPrelude(body, '1'));

      // 2. body-only request with no preludeVersion
      const req2 = new NextRequest('http://localhost:3000/api/compile', {
        method: 'POST',
        headers: { cookie: OWNER_COOKIE },
        body: JSON.stringify({ code: body }),
      });
      const res2 = await POST(req2);
      expect(res2.status).toBe(200);
      expect(spy).toHaveBeenLastCalledWith(withGeneratedPrelude(body, '1'));

      // 3. a script that already has the sentinel is passed through unchanged
      const sentinelScript = withGeneratedPrelude(body, '1');
      const req3 = new NextRequest('http://localhost:3000/api/compile', {
        method: 'POST',
        headers: { cookie: OWNER_COOKIE },
        body: JSON.stringify({ code: sentinelScript }),
      });
      const res3 = await POST(req3);
      expect(res3.status).toBe(200);
      expect(spy).toHaveBeenLastCalledWith(sentinelScript);

      // 4. preludeVersion: 'nope' -> 400 and runBrep not called
      spy.mockClear();
      const req4 = new NextRequest('http://localhost:3000/api/compile', {
        method: 'POST',
        headers: { cookie: OWNER_COOKIE },
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
