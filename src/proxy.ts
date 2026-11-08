import { randomUUID } from 'node:crypto';
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
