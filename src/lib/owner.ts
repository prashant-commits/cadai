import { createHash } from 'node:crypto';

export const CADAI_OWNER_COOKIE = 'cadai_owner';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

export function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key === name) {
      return trimmed.slice(eqIdx + 1).trim();
    }
  }
  return null;
}

export function ownerKeyFrom(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  const cookieValue = parseCookie(cookieHeader, CADAI_OWNER_COOKIE);
  if (!cookieValue || !isValidUuid(cookieValue)) {
    return null;
  }
  return createHash('sha256').update(cookieValue).digest('hex');
}
