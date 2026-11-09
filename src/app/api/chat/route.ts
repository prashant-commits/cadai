import { NextRequest, NextResponse } from 'next/server';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createDesignerAgent } from '@/lib/agent/designer/graph';
import { streamRun } from '@/lib/runs/stream-run';
import { getLangfuseCallbackHandler, getLangfuseSpanProcessor } from '@/lib/tracing/langfuse';
import { coerceRouteModel } from '@/lib/agent/models';
import { graphRecursionLimit } from '@/lib/agent/run-limits';
import { getDb } from '@/lib/db/db';
import { DbRunStore } from '@/lib/runs/db-run-store';
import { loadRunInput } from '@/lib/persist/run-input';
import { isValidUuid, ownerKeyFrom } from '@/lib/owner';
import { StoreError } from '@/lib/persist/types';
import {
  BAD_ATTACHMENT,
  BAD_EDIT,
  BAD_PIN,
  LEGACY,
  RUN_ACTIVE,
  STALE_CLIENT,
} from '@/lib/persist/phrases';
import { checkPythonScript } from '@/lib/brep/body-check';
import { withGeneratedPrelude, toBody } from '@/lib/brep/prelude';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ownerKey = ownerKeyFrom(req);
  if (!ownerKey) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Unauthorized' } },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Invalid JSON' } },
      { status: 400 }
    );
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'Request body must be an object' } },
      { status: 400 }
    );
  }

  const b = body as Record<string, unknown>;

  if (typeof b.text !== 'string') {
    return NextResponse.json(
      { error: { code: 'bad_request', message: 'text must be a string' } },
      { status: 400 }
    );
  }

  if (typeof b.threadId !== 'string' || !isValidUuid(b.threadId)) {
    return NextResponse.json(
      { error: { code: 'legacy', message: LEGACY } },
      { status: 400 }
    );
  }

  if (typeof b.clientMessageId !== 'string' || !isValidUuid(b.clientMessageId)) {
    return NextResponse.json(
      { error: { code: 'stale_client', message: STALE_CLIENT } },
      { status: 400 }
    );
  }

  if (
    b.viewingVersion !== undefined &&
    b.viewingVersion !== null &&
    (typeof b.viewingVersion !== 'number' || !Number.isInteger(b.viewingVersion))
  ) {
    return NextResponse.json(
      { error: { code: 'stale_client', message: STALE_CLIENT } },
      { status: 400 }
    );
  }

  const hasAttachmentIds = b.attachmentIds !== undefined && b.attachmentIds !== null;
  const hasAttachments = b.attachments !== undefined && b.attachments !== null;

  if (hasAttachmentIds && hasAttachments) {
    return NextResponse.json(
      { error: { code: 'bad_attachment', message: BAD_ATTACHMENT } },
      { status: 400 }
    );
  }

  if (hasAttachmentIds) {
    if (
      !Array.isArray(b.attachmentIds) ||
      b.attachmentIds.length > 4 ||
      !b.attachmentIds.every((id) => typeof id === 'string')
    ) {
      return NextResponse.json(
        { error: { code: 'bad_attachment', message: BAD_ATTACHMENT } },
        { status: 400 }
      );
    }
  }

  if (hasAttachments) {
    if (
      !Array.isArray(b.attachments) ||
      b.attachments.length > 4 ||
      !b.attachments.every(
        (att) =>
          att &&
          typeof att === 'object' &&
          typeof att.id === 'string' &&
          (att.kind === 'markup' || att.kind === 'reference')
      )
    ) {
      return NextResponse.json(
        { error: { code: 'bad_attachment', message: BAD_ATTACHMENT } },
        { status: 400 }
      );
    }
  }

  if (b.pinnedParams !== undefined && b.pinnedParams !== null) {
    if (typeof b.pinnedParams !== 'object' || Array.isArray(b.pinnedParams)) {
      return NextResponse.json(
        { error: { code: 'bad_pin', message: BAD_PIN } },
        { status: 400 }
      );
    }
    for (const [k, v] of Object.entries(b.pinnedParams as Record<string, unknown>)) {
      if (typeof k !== 'string' || typeof v !== 'number' || !Number.isFinite(v)) {
        return NextResponse.json(
          { error: { code: 'bad_pin', message: BAD_PIN } },
          { status: 400 }
        );
      }
    }
  }

  if (b.editedBody !== undefined && b.editedBody !== null) {
    if (typeof b.editedBody !== 'string') {
      return NextResponse.json(
        { error: { code: 'bad_edit', message: BAD_EDIT } },
        { status: 400 }
      );
    }
    const check = checkPythonScript(withGeneratedPrelude(toBody(b.editedBody)));
    if (!check.ok) {
      return NextResponse.json(
        { error: { code: 'bad_edit', message: BAD_EDIT } },
        { status: 400 }
      );
    }
  }

  const threadId = b.threadId as string;
  const clientMessageId = b.clientMessageId as string;
  const text = b.text as string;
  const viewingVersion =
    b.viewingVersion === undefined ? undefined : (b.viewingVersion as number | null);
  let normalizedAttachments: Array<{ id: string; kind: 'markup' | 'reference' }> | undefined = undefined;
  if (b.attachments !== undefined && b.attachments !== null) {
    normalizedAttachments = b.attachments as Array<{ id: string; kind: 'markup' | 'reference' }>;
  } else if (b.attachmentIds !== undefined && b.attachmentIds !== null) {
    normalizedAttachments = (b.attachmentIds as string[]).map((id) => ({ id, kind: 'reference' }));
  }
  const pinnedParams = (b.pinnedParams as Record<string, number> | undefined) ?? undefined;
  const editedBody = (b.editedBody as string | undefined) ?? undefined;
  const model = typeof b.model === 'string' ? b.model : undefined;

  const db = getDb();
  let r:
    | { replay: true; runId: string }
    | {
        replay: false;
        runId: string;
        threadId: string;
        baseVersion: number | null;
        userMessageId: string;
      };

  try {
    r = await db.transaction((q) =>
      DbRunStore.start(q, {
        ownerKey,
        threadId,
        clientMessageId,
        text,
        viewingVersion: viewingVersion as unknown as number | null,
        attachments: normalizedAttachments,
        pinnedParams,
        editedBody,
        model,
      })
    );
  } catch (err) {
    if (err instanceof StoreError) {
      if (err.status === 404) {
        return NextResponse.json(
          { error: { code: 'not_found', message: err.message } },
          { status: 404 }
        );
      }
      if (err.status === 409 && err.code === 'run_active') {
        return NextResponse.json(
          { error: { code: 'run_active', message: RUN_ACTIVE }, activeRunId: err.activeRunId },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status }
      );
    }
    throw err;
  }

  if (r.replay) {
    return NextResponse.json(
      { error: { code: 'duplicate_message' }, runId: r.runId },
      { status: 409 }
    );
  }

  try {
    const run = await DbRunStore.get(db, r.runId);
    if (!run) {
      throw new Error(`Run ${r.runId} not found after start`);
    }
    const deadlineAt = run.deadlineAt;

    const input = await loadRunInput(
      db,
      ownerKey,
      threadId,
      r.baseVersion,
      normalizedAttachments ?? []
    );

    const lcMessages = input.messages.map((m) =>
      m.role === 'user'
        ? new HumanMessage({ content: m.content })
        : new AIMessage({ content: m.content })
    );

    const graphInput = {
      messages: lcMessages,
      baseVersion: input.baseVersion,
      baseBody: input.baseBody,
      baseRequest: input.baseRequest,
      attachments: input.attachments,
      baseEdits: input.baseEdits,
    };

    const effectiveModel = coerceRouteModel(model);
    const langfuseHandler = getLangfuseCallbackHandler({
      sessionId: threadId,
      tags: ['cadai', effectiveModel],
      metadata: { model: effectiveModel },
    });

    const response = streamRun({
      runId: r.runId,
      threadId,
      ownerKey,
      deadlineAt,
      invoke: (signal) =>
        createDesignerAgent(effectiveModel).stream(graphInput, {
          configurable: { ownerKey, threadId, runId: r.runId, deadlineAt },
          recursionLimit: graphRecursionLimit(),
          streamMode: ['updates', 'messages', 'custom', 'tasks', 'values'],
          callbacks: langfuseHandler ? [langfuseHandler] : undefined,
          signal,
        }),
      onFinally: async () => {
        try {
          await getLangfuseSpanProcessor()?.forceFlush();
        } catch (e) {
          console.warn('Langfuse flush failed:', e);
        }
      },
    });

    response.headers.set('X-Run-Id', r.runId);
    return response;
  } catch (err) {
    try {
      await db.transaction((q) =>
        DbRunStore.terminate(q, r.runId, 'failed', 'internal')
      );
    } catch (termErr) {
      console.error('Failed to terminate run after setup error:', termErr);
    }
    console.error('Chat route setup error:', err);
    return NextResponse.json(
      { error: { code: 'internal', message: 'Internal server error' } },
      { status: 500 }
    );
  }
}
