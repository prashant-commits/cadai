import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { CADAI_OWNER_COOKIE, isValidUuid, parseCookie } from './lib/owner';

export const config = {
  matcher: ['/((?!_next/static|_next/image|.*\\..*$).*)'],
};

function isHttps(request: NextRequest): boolean {
  if (process.env.CADAI_TRUST_PROXY === '1') {
    const proto = request.headers.get('x-forwarded-proto');
    if (proto) {
      const firstProto = proto.split(',')[0].trim().toLowerCase();
      return firstProto === 'https';
    }
  }
  return request.nextUrl.protocol === 'https:';
}

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function setCookieInHeader(cookieHeader: string | null, name: string, value: string): string {
  if (!cookieHeader || !cookieHeader.trim()) {
    return `${name}=${value}`;
  }
  const parts = cookieHeader.split(';');
  let found = false;
  const updatedParts: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    const key = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
    if (key === name) {
      updatedParts.push(`${name}=${value}`);
      found = true;
    } else {
      updatedParts.push(trimmed);
    }
  }
  if (!found) {
    updatedParts.push(`${name}=${value}`);
  }
  return updatedParts.join('; ');
}

export function proxy(request: NextRequest): NextResponse {
  const rawToken = process.env.CADAI_ACCESS_TOKEN;
  const token = rawToken && rawToken.trim() !== '' ? rawToken.trim() : null;

  if (token) {
    const accessHmac = createHmac('sha256', token)
      .update('cadai-access-v1')
      .digest('base64url');

    const accessParam = request.nextUrl.searchParams.get('access');

    const unauthorizedResponse = (): NextResponse => {
      const isApi =
        request.nextUrl.pathname.startsWith('/api/') ||
        request.nextUrl.pathname === '/api';
      if (isApi) {
        return NextResponse.json(
          { error: { code: 'unauthorized', message: 'Unauthorized' } },
          { status: 401 }
        );
      }
      return new NextResponse('Unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    };

    if (accessParam !== null) {
      if (!constantTimeEqual(accessParam, token)) {
        return unauthorizedResponse();
      }

      const redirectUrl = new URL(request.url);
      redirectUrl.searchParams.delete('access');
      const redirectRes = NextResponse.redirect(redirectUrl, { status: 307 });

      const existingCookie =
        request.cookies.get(CADAI_OWNER_COOKIE)?.value ??
        parseCookie(request.headers.get('cookie'), CADAI_OWNER_COOKIE);

      const owner =
        existingCookie && isValidUuid(existingCookie) ? existingCookie : randomUUID();

      const secure = isHttps(request);

      redirectRes.cookies.set({
        name: 'cadai_access',
        value: accessHmac,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 34560000,
        secure,
      });

      redirectRes.cookies.set({
        name: CADAI_OWNER_COOKIE,
        value: owner,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 34560000,
        secure,
      });

      return redirectRes;
    }

    const accessCookie =
      request.cookies.get('cadai_access')?.value ??
      parseCookie(request.headers.get('cookie'), 'cadai_access');

    if (!accessCookie || !constantTimeEqual(accessCookie, accessHmac)) {
      return unauthorizedResponse();
    }
  }

  const existingCookie =
    request.cookies.get(CADAI_OWNER_COOKIE)?.value ??
    parseCookie(request.headers.get('cookie'), CADAI_OWNER_COOKIE);

  const owner =
    existingCookie && isValidUuid(existingCookie) ? existingCookie : randomUUID();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('x-cadai-owner');

  const rawCookie = requestHeaders.get('cookie');
  requestHeaders.set('cookie', setCookieInHeader(rawCookie, CADAI_OWNER_COOKIE, owner));

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.cookies.set({
    name: CADAI_OWNER_COOKIE,
    value: owner,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 34560000,
    secure: isHttps(request),
  });

  return response;
}
