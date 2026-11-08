import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ownerKeyFrom, CADAI_OWNER_COOKIE, isValidUuid } from './owner';

describe('ownerKeyFrom', () => {
  it('no owner → 401', () => {
    // 1. Missing cookie header
    const reqNoCookie = new Request('http://localhost/api/chat');
    expect(ownerKeyFrom(reqNoCookie)).toBeNull();

    // 2. Cookie header without cadai_owner
    const reqOtherCookie = new Request('http://localhost/api/chat', {
      headers: { cookie: 'other_cookie=hello' },
    });
    expect(ownerKeyFrom(reqOtherCookie)).toBeNull();

    // 3. Non-UUID cadai_owner cookie
    const reqNonUuid = new Request('http://localhost/api/chat', {
      headers: { cookie: `${CADAI_OWNER_COOKIE}=not-a-uuid` },
    });
    expect(ownerKeyFrom(reqNonUuid)).toBeNull();

    // 4. Route-style helper/usage mapping null to 401 response
    function routeHandler(req: Request): Response {
      const ownerKey = ownerKeyFrom(req);
      if (!ownerKey) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ownerKey }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    expect(routeHandler(reqNoCookie).status).toBe(401);
    expect(routeHandler(reqNonUuid).status).toBe(401);
    expect(routeHandler(reqOtherCookie).status).toBe(401);
  });

  it('valid UUID cookie returns lowercase sha256 hex', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const expectedHash = createHash('sha256').update(uuid).digest('hex');

    const req = new Request('http://localhost/api/chat', {
      headers: { cookie: `${CADAI_OWNER_COOKIE}=${uuid}` },
    });
    expect(ownerKeyFrom(req)).toBe(expectedHash);
  });

  it('ignores x-cadai-owner header and does not trust it', () => {
    const spoofedUuid = '550e8400-e29b-41d4-a716-446655440000';
    const req = new Request('http://localhost/api/chat', {
      headers: {
        'x-cadai-owner': spoofedUuid,
      },
    });
    expect(ownerKeyFrom(req)).toBeNull();
  });

  it('parses cadai_owner among multiple cookies', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const expectedHash = createHash('sha256').update(uuid).digest('hex');

    const req = new Request('http://localhost/api/chat', {
      headers: {
        cookie: `session=xyz; ${CADAI_OWNER_COOKIE}=${uuid}; theme=dark`,
      },
    });
    expect(ownerKeyFrom(req)).toBe(expectedHash);
  });

  it('validates UUID format correctly', () => {
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUuid('c7d9fcc0-191d-4c62-a04e-83e8a47c3c5a')).toBe(true);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('550e8400-e29b-41d4-a716-44665544000Z')).toBe(false);
    expect(isValidUuid('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});
