import { describe, expect, it, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash, createHmac } from 'node:crypto';
import { unstable_doesMiddlewareMatch as unstable_doesProxyMatch } from 'next/experimental/testing/server';
import { proxy, config } from './proxy';
import { CADAI_OWNER_COOKIE, isValidUuid, ownerKeyFrom } from './lib/owner';

function forwardedHeadersFrom(response: Response): Headers {
  const headers = new Headers();
  const overrideHeaderList = response.headers.get('x-middleware-override-headers');
  if (overrideHeaderList) {
    for (const key of overrideHeaderList.split(',')) {
      const trimmedKey = key.trim();
      const val = response.headers.get(`x-middleware-request-${trimmedKey}`);
      if (val !== null) {
        headers.set(trimmedKey, val);
      }
    }
  }
  return headers;
}

describe('proxy', () => {
  const originalTrustProxy = process.env.CADAI_TRUST_PROXY;
  const originalAccessToken = process.env.CADAI_ACCESS_TOKEN;

  afterEach(() => {
    if (originalTrustProxy === undefined) {
      delete process.env.CADAI_TRUST_PROXY;
    } else {
      process.env.CADAI_TRUST_PROXY = originalTrustProxy;
    }
    if (originalAccessToken === undefined) {
      delete process.env.CADAI_ACCESS_TOKEN;
    } else {
      process.env.CADAI_ACCESS_TOKEN = originalAccessToken;
    }
  });

  it('the first request without a cookie: its own route reads the minted owner', () => {
    const req = new NextRequest('http://localhost/api/chat');
    const res = proxy(req);

    // Forwarded request headers carried by the response
    const forwardedHeaders = forwardedHeadersFrom(res);
    const forwardedReq = new Request('http://localhost/api/chat', { headers: forwardedHeaders });

    const ownerKey = ownerKeyFrom(forwardedReq);
    expect(ownerKey).not.toBeNull();

    const mintedUuid = res.cookies.get(CADAI_OWNER_COOKIE)?.value;
    expect(mintedUuid).toBeDefined();
    expect(isValidUuid(mintedUuid!)).toBe(true);

    const expectedHash = createHash('sha256').update(mintedUuid!).digest('hex');
    expect(ownerKey).toBe(expectedHash);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${CADAI_OWNER_COOKIE}=${mintedUuid}`);

    // Also assert that an existing valid UUID cookie is kept with the same value and its Max-Age refreshed
    const existingUuid = 'a0000000-0000-4000-8000-000000000001';
    const reqExisting = new NextRequest('http://localhost/api/chat', {
      headers: { cookie: `${CADAI_OWNER_COOKIE}=${existingUuid}` },
    });
    const resExisting = proxy(reqExisting);

    expect(resExisting.cookies.get(CADAI_OWNER_COOKIE)?.value).toBe(existingUuid);
    expect(resExisting.cookies.get(CADAI_OWNER_COOKIE)?.maxAge).toBe(34560000);

    const forwardedExisting = new Request('http://localhost/api/chat', {
      headers: forwardedHeadersFrom(resExisting),
    });
    expect(ownerKeyFrom(forwardedExisting)).toBe(
      createHash('sha256').update(existingUuid).digest('hex')
    );
  });

  it('a non-UUID cookie is re-minted', () => {
    const req = new NextRequest('http://localhost/api/chat', {
      headers: { cookie: `${CADAI_OWNER_COOKIE}=not-a-uuid` },
    });
    const res = proxy(req);

    const newUuid = res.cookies.get(CADAI_OWNER_COOKIE)?.value;
    expect(newUuid).toBeDefined();
    expect(isValidUuid(newUuid!)).toBe(true);
    expect(newUuid).not.toBe('not-a-uuid');

    const forwardedReq = new Request('http://localhost/api/chat', {
      headers: forwardedHeadersFrom(res),
    });
    expect(ownerKeyFrom(forwardedReq)).toBe(
      createHash('sha256').update(newUuid!).digest('hex')
    );
  });

  it('x-cadai-owner is stripped', () => {
    const req = new NextRequest('http://localhost/api/chat', {
      headers: {
        'x-cadai-owner': 'malicious-spoofed-owner',
      },
    });
    const res = proxy(req);

    const forwardedHeaders = forwardedHeadersFrom(res);
    expect(forwardedHeaders.get('x-cadai-owner')).toBeNull();
    expect(res.headers.get('x-middleware-request-x-cadai-owner')).toBeNull();

    const overrideHeaderList = res.headers.get('x-middleware-override-headers')?.split(',') ?? [];
    expect(overrideHeaderList.map((h) => h.trim().toLowerCase())).not.toContain('x-cadai-owner');
  });

  it('cookie attributes; Secure from x-forwarded-proto only with CADAI_TRUST_PROXY', () => {
    // 1. http request → no Secure, attributes check
    delete process.env.CADAI_TRUST_PROXY;
    const reqHttp = new NextRequest('http://localhost/api/chat');
    const resHttp = proxy(reqHttp);
    const cookie = resHttp.cookies.get(CADAI_OWNER_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.maxAge).toBe(34560000);
    expect(cookie?.secure).toBe(false);

    const setCookieHttp = resHttp.headers.get('set-cookie') ?? '';
    expect(setCookieHttp).toContain('HttpOnly');
    expect(setCookieHttp).toContain('SameSite=lax');
    expect(setCookieHttp).toContain('Path=/');
    expect(setCookieHttp).toContain('Max-Age=34560000');
    expect(setCookieHttp).not.toContain('Secure');

    // 2. x-forwarded-proto: https without CADAI_TRUST_PROXY on an http URL → no Secure
    delete process.env.CADAI_TRUST_PROXY;
    const reqProtoNoTrust = new NextRequest('http://localhost/api/chat', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const resProtoNoTrust = proxy(reqProtoNoTrust);
    expect(resProtoNoTrust.cookies.get(CADAI_OWNER_COOKIE)?.secure).toBe(false);
    expect(resProtoNoTrust.headers.get('set-cookie') ?? '').not.toContain('Secure');

    // 3. with CADAI_TRUST_PROXY=1 plus x-forwarded-proto: https → Secure
    process.env.CADAI_TRUST_PROXY = '1';
    const reqProtoTrust = new NextRequest('http://localhost/api/chat', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const resProtoTrust = proxy(reqProtoTrust);
    expect(resProtoTrust.cookies.get(CADAI_OWNER_COOKIE)?.secure).toBe(true);
    expect(resProtoTrust.headers.get('set-cookie') ?? '').toContain('Secure');

    // 4. an https:// URL without the env → Secure
    delete process.env.CADAI_TRUST_PROXY;
    const reqHttps = new NextRequest('https://example.com/api/chat');
    const resHttps = proxy(reqHttps);
    expect(resHttps.cookies.get(CADAI_OWNER_COOKIE)?.secure).toBe(true);
    expect(resHttps.headers.get('set-cookie') ?? '').toContain('Secure');
  });

  it('static assets get no Set-Cookie', () => {
    // Assets that do not match the proxy matcher
    expect(
      unstable_doesProxyMatch({
        config,
        url: 'http://localhost/_next/static/chunks/a.js',
      })
    ).toBe(false);

    expect(
      unstable_doesProxyMatch({
        config,
        url: 'http://localhost/_next/image?url=x',
      })
    ).toBe(false);

    expect(
      unstable_doesProxyMatch({
        config,
        url: 'http://localhost/favicon.ico',
      })
    ).toBe(false);

    expect(
      unstable_doesProxyMatch({
        config,
        url: 'http://localhost/logo.png',
      })
    ).toBe(false);

    // Routes that do match the proxy matcher
    expect(
      unstable_doesProxyMatch({
        config,
        url: 'http://localhost/',
      })
    ).toBe(true);

    expect(
      unstable_doesProxyMatch({
        config,
        url: 'http://localhost/api/chat',
      })
    ).toBe(true);

    expect(
      unstable_doesProxyMatch({
        config,
        url: 'http://localhost/api/runs/abc/events',
      })
    ).toBe(true);
  });

  it('401 without the token cookie (API → JSON, page → text)', async () => {
    process.env.CADAI_ACCESS_TOKEN = 'secret-token-123';

    // API route -> 401 JSON { error: { code: 'unauthorized', message: 'Unauthorized' } }
    const apiReq = new NextRequest('http://localhost/api/chat');
    const apiRes = proxy(apiReq);
    expect(apiRes.status).toBe(401);
    expect(apiRes.headers.get('content-type')).toContain('application/json');
    expect(await apiRes.json()).toEqual({
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    expect(apiRes.headers.get('set-cookie')).toBeNull();

    // Page route -> 401 text/plain body Unauthorized
    const pageReq = new NextRequest('http://localhost/');
    const pageRes = proxy(pageReq);
    expect(pageRes.status).toBe(401);
    expect(pageRes.headers.get('content-type')).toContain('text/plain');
    expect(await pageRes.text()).toBe('Unauthorized');
    expect(pageRes.headers.get('set-cookie')).toBeNull();
  });

  it('?access=<token> sets an httpOnly SameSite=Lax cadai_access cookie and redirects without the parameter', () => {
    process.env.CADAI_ACCESS_TOKEN = 'secret-token-123';
    const expectedHmac = createHmac('sha256', 'secret-token-123')
      .update('cadai-access-v1')
      .digest('base64url');

    // 1. http URL: redirect 307, Location has other params, no Secure
    const httpReq = new NextRequest('http://localhost/path?foo=bar&access=secret-token-123');
    const httpRes = proxy(httpReq);
    expect(httpRes.status).toBe(307);
    const location = httpRes.headers.get('location');
    expect(location).toBe('http://localhost/path?foo=bar');

    const accessCookie = httpRes.cookies.get('cadai_access');
    expect(accessCookie).toBeDefined();
    expect(accessCookie?.value).not.toBe('secret-token-123');
    expect(accessCookie?.value).toBe(expectedHmac);
    expect(accessCookie?.httpOnly).toBe(true);
    expect(accessCookie?.sameSite).toBe('lax');
    expect(accessCookie?.path).toBe('/');
    expect(accessCookie?.maxAge).toBe(34560000);
    expect(accessCookie?.secure).toBe(false);

    // Also assert owner cookie is set on redirect
    const ownerCookie = httpRes.cookies.get(CADAI_OWNER_COOKIE);
    expect(ownerCookie).toBeDefined();
    expect(isValidUuid(ownerCookie!.value)).toBe(true);

    // 2. https URL: Secure flag set
    const httpsReq = new NextRequest('https://example.com/path?access=secret-token-123');
    const httpsRes = proxy(httpsReq);
    expect(httpsRes.status).toBe(307);
    expect(httpsRes.cookies.get('cadai_access')?.secure).toBe(true);
  });

  it('a wrong ?access= is 401 and sets no cookie', async () => {
    process.env.CADAI_ACCESS_TOKEN = 'secret-token-123';

    // Same length wrong token
    const wrongSameLen = new NextRequest('http://localhost/api/chat?access=secret-token-999');
    const resSame = proxy(wrongSameLen);
    expect(resSame.status).toBe(401);
    expect(resSame.headers.get('set-cookie')).toBeNull();

    // Different length wrong token
    const wrongDiffLen = new NextRequest('http://localhost/?access=wrong');
    const resDiff = proxy(wrongDiffLen);
    expect(resDiff.status).toBe(401);
    expect(resDiff.headers.get('set-cookie')).toBeNull();
  });

  it('a valid cadai_access cookie passes and the owner cookie is still minted', () => {
    process.env.CADAI_ACCESS_TOKEN = 'secret-token-123';
    const validHmac = createHmac('sha256', 'secret-token-123')
      .update('cadai-access-v1')
      .digest('base64url');

    const req = new NextRequest('http://localhost/api/chat', {
      headers: { cookie: `cadai_access=${validHmac}` },
    });
    const res = proxy(req);
    expect(res.status).toBe(200);

    const ownerCookie = res.cookies.get(CADAI_OWNER_COOKIE);
    expect(ownerCookie).toBeDefined();
    expect(isValidUuid(ownerCookie!.value)).toBe(true);
  });

  it('a forged cookie (the raw token) is 401', () => {
    process.env.CADAI_ACCESS_TOKEN = 'secret-token-123';

    const req = new NextRequest('http://localhost/api/chat', {
      headers: { cookie: `cadai_access=secret-token-123` },
    });
    const res = proxy(req);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('no CADAI_ACCESS_TOKEN → no gate', () => {
    delete process.env.CADAI_ACCESS_TOKEN;

    const req = new NextRequest('http://localhost/api/chat');
    const res = proxy(req);
    expect(res.status).toBe(200);
    expect(res.cookies.get(CADAI_OWNER_COOKIE)).toBeDefined();
  });
});
