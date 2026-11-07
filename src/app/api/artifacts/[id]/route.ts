import { NextRequest } from 'next/server';
import { Readable } from 'stream';
import type { ArtifactRef } from '@/lib/contract/run-contract';
import { errorResponse } from '@/lib/runs/api-error';
import { getArtifactStore, isArtifactId } from '@/lib/runs/artifact-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<ArtifactRef['kind'], string> = {
  stl: 'model/stl',
  step: 'model/step',
  svg: 'image/svg+xml',
  png: 'image/png',
  scad: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
};

/** True when If-None-Match lists the ETag (or `*`). Weak validators match too. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v.replace(/^W\//, '') === etag;
  });
}

/**
 * GET /api/artifacts/:id - the bytes of an artifact referenced by a stream event.
 * Content-addressed, so the response is immutable and cacheable for a year.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isArtifactId(id)) return errorResponse('bad_request', 'Invalid artifact id.');
  const found = await getArtifactStore().get(id);
  if (!found) return errorResponse('not_found', `Artifact ${id} was not found.`);
  const { ref, stream } = found;

  const etag = `"${ref.sha256}"`;
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPES[ref.kind],
    ETag: etag,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };
  if (ref.kind === 'svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";

  if (etagMatches(req.headers.get('if-none-match'), etag)) {
    stream.destroy();
    return new Response(null, { status: 304, headers });
  }
  headers['Content-Length'] = String(ref.bytes);
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
}
