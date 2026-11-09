import type { ChatRequest, MessageAttachmentRef } from '@/lib/persist/types';
import { BAD_ATTACHMENT, STALE_CLIENT } from '@/lib/persist/phrases';
import type { TranscriptSection } from '@/lib/agent/transcript';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isServerThreadId(id: string): boolean {
  return UUID_REGEX.test(id);
}

export interface ServerThreadSummary {
  id: string;
  title: string | null;
  updatedAt: number;
  activeRunId: string | null;
}

export interface ServerThreadAttachment {
  id: string;
  kind: 'markup' | 'reference';
}

export interface ServerThreadMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  kind: string;
  markdown: string;
  designVersion?: number;
  attachments: ServerThreadAttachment[];
  steps?: TranscriptSection[];
}

export interface ServerThreadVersion {
  version: number;
  parentVersion: number | null;
  origin: string;
  summary: string;
  flags: string[];
  body: string;
  preludeVersion: string;
  stl: string | null;
  step: string | null;
  topo?: string | null;
  createdAt: number;
  partLabels?: string[];
}

export interface ServerThreadDetail {
  id: string;
  title: string | null;
  activeRun: { id: string; status: string; lastSeq: number } | null;
  messages: ServerThreadMessage[];
  versions: ServerThreadVersion[];
}

export type SendChatResult =
  | { kind: 'stream'; runId: string; response: Response }
  | { kind: 'attach'; runId: string }
  | { kind: 'error'; message: string };

export function getLatestViewingVersion(versions?: { version: number }[] | null): number | null {
  if (!versions || versions.length === 0) return null;
  return Math.max(...versions.map((v) => v.version));
}

export function buildChatRequest(params: {
  threadId: string;
  clientMessageId?: string;
  text: string;
  viewingVersion: number | null;
  attachmentIds?: string[];
  attachments?: MessageAttachmentRef[];
  pinnedParams?: Record<string, number>;
  editedBody?: string;
  model?: string;
}): ChatRequest {
  const req: ChatRequest = {
    threadId: params.threadId,
    clientMessageId: params.clientMessageId ?? crypto.randomUUID(),
    text: params.text,
    viewingVersion: params.viewingVersion,
  };
  if (params.attachments !== undefined && params.attachments.length > 0) {
    req.attachments = params.attachments;
  } else if (params.attachmentIds !== undefined && params.attachmentIds.length > 0) {
    req.attachmentIds = params.attachmentIds;
  }
  if (params.pinnedParams !== undefined && Object.keys(params.pinnedParams).length > 0) {
    req.pinnedParams = params.pinnedParams;
  }
  if (params.editedBody !== undefined) {
    req.editedBody = params.editedBody;
  }
  if (params.model !== undefined) {
    req.model = params.model;
  }
  return req;
}

export async function listThreads(): Promise<ServerThreadSummary[]> {
  const res = await fetch('/api/threads');
  if (!res.ok) {
    throw new Error(`Failed to list threads: ${res.status}`);
  }
  const data = await res.json();
  return data.threads;
}

export async function getThread(id: string): Promise<ServerThreadDetail | null> {
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Failed to get thread: ${res.status}`);
  }
  return res.json();
}

export async function renameThread(id: string, title: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteThread(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function uploadAttachment(blob: Blob | File, signal?: AbortSignal): Promise<string> {
  const formData = new FormData();
  if (blob instanceof File) {
    formData.append('file', blob);
  } else {
    formData.append('file', blob, 'attachment.png');
  }

  const res = await fetch('/api/attachments', {
    method: 'POST',
    body: formData,
    signal,
  });

  if (!res.ok) {
    let msg = BAD_ATTACHMENT;
    try {
      const data = await res.json();
      if (data?.error?.message) msg = data.error.message;
    } catch {
      // Keep default
    }
    throw new Error(msg);
  }

  const data = await res.json();
  return data.artifactId;
}

export async function sendChat(req: ChatRequest): Promise<SendChatResult> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch {
    return { kind: 'error', message: STALE_CLIENT };
  }

  if (response.ok) {
    const runId = response.headers.get('X-Run-Id') ?? '';
    return { kind: 'stream', runId, response };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = await response.json();
  } catch {
    // Body is not JSON
  }

  if (response.status === 409) {
    const activeRunId = typeof body?.activeRunId === 'string' ? body.activeRunId : null;
    const runId = typeof body?.runId === 'string' ? body.runId : null;
    const targetRunId = activeRunId ?? runId;
    if (targetRunId) {
      return { kind: 'attach', runId: targetRunId };
    }
  }

  const errObj = body?.error;
  const message =
    errObj && typeof (errObj as Record<string, unknown>).message === 'string'
      ? ((errObj as Record<string, unknown>).message as string)
      : STALE_CLIENT;

  return { kind: 'error', message };
}

export async function tailRun(runId: string, after: number = 0): Promise<Response> {
  return fetch(`/api/runs/${encodeURIComponent(runId)}/events?after=${after}`);
}

export async function stopRun(runId: string): Promise<Response> {
  return fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
  });
}

export async function fetchArtifactText(id: string): Promise<string> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch artifact: ${res.status}`);
  }
  return res.text();
}
