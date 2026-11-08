import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/db';
import { isValidUuid, ownerKeyFrom } from '@/lib/owner';
import { ThreadStore } from '@/lib/persist/threads';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { MessageStore } from '@/lib/persist/messages';
import { DesignStore } from '@/lib/persist/designs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const { id } = await params;
  if (!isValidUuid(id)) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  const db = getDb();
  const thread = await ThreadStore.get(db, ownerKey, id);
  if (!thread) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  let activeRun: { id: string; status: string; lastSeq: number } | null = null;
  if (thread.activeRunId) {
    const run = await DbRunStore.get(db, thread.activeRunId);
    if (run) {
      activeRun = {
        id: run.id,
        status: run.status,
        lastSeq: run.lastSeq,
      };
    }
  }

  const rawMessages = await MessageStore.list(db, ownerKey, id);
  const messages = rawMessages.map((m) => {
    const msg: {
      id: string;
      seq: number;
      role: 'user' | 'assistant';
      kind: string;
      markdown: string;
      designVersion?: number;
      attachments: string[];
    } = {
      id: m.id,
      seq: m.seq,
      role: m.role,
      kind: m.kind,
      markdown: m.content,
      attachments: m.attachmentIds,
    };
    if (m.designVersion !== null && m.designVersion !== undefined) {
      msg.designVersion = m.designVersion;
    }
    return msg;
  });

  const rawDesigns = await DesignStore.list(db, ownerKey, id);
  const versions = rawDesigns.map((d) => ({
    version: d.version,
    parentVersion: d.parentVersion,
    origin: d.origin,
    summary: d.summary,
    flags: d.flags,
    body: d.body,
    preludeVersion: d.preludeVersion,
    stl: d.stlArtifact,
    step: d.stepArtifact,
    createdAt: d.createdAt,
  }));

  return NextResponse.json({
    id: thread.id,
    title: thread.title,
    activeRun,
    messages,
    versions,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const { id } = await params;
  if (!isValidUuid(id)) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Invalid JSON body' } },
      { status: 400 }
    );
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).title !== 'string'
  ) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Title must be a string' } },
      { status: 400 }
    );
  }

  const title = (body as { title: string }).title;
  const db = getDb();
  const updated = await ThreadStore.rename(db, ownerKey, id, title);
  if (!updated) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  return new Response(null, { status: 204 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  const { id } = await params;
  if (!isValidUuid(id)) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  const db = getDb();
  const archived = await db.transaction(async (q) => {
    return ThreadStore.archive(q, ownerKey, id);
  });

  if (!archived) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Thread not found' } },
      { status: 404 }
    );
  }

  return new Response(null, { status: 204 });
}
