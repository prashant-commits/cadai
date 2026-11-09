import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'stream';
import { ownerKeyFrom } from '@/lib/owner';
import { openStream, type OwnerArtifactKind } from '@/lib/runs/owner-artifacts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<OwnerArtifactKind, string> = {
  stl: 'model/stl',
  step: 'model/step',
  image: 'image/png',
  topo: 'application/gzip',
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const { id } = await params;
  const found = await openStream(ownerKey, id);
  if (!found) {
    return NextResponse.json(
      { error: { code: 'not_found', message: `Artifact ${id} was not found.` } },
      { status: 404 }
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPES[found.row.kind] ?? 'application/octet-stream',
    'Content-Length': String(found.row.bytes),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  return new Response(Readable.toWeb(found.stream) as ReadableStream<Uint8Array>, { headers });
}
