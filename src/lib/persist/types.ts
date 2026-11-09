import {
  BAD_PIN,
  RUN_ACTIVE,
  STALE_CLIENT,
  type TerminateCode,
} from './phrases';
import type { TranscriptSection } from '../agent/transcript';

export interface DesignDraft {
  parentVersion: number | null;
  origin: 'designer';
  baseRequest: string;
  edits: unknown[];
  body: string;
  preludeVersion: string;
  summary: string;
  facts: unknown | null;
  flags: string[];
}

export type ReplyKind = 'result' | 'answer' | 'error' | 'cancelled' | 'nochange';
export type UserKind = 'request' | 'edit' | 'question' | 'unknown';

export interface RunOutcome {
  replyKind: ReplyKind;
  replyMarkdown: string;
  userKind: UserKind;
  design?: DesignDraft & { stl?: string; step?: string };
  costUsd: number;
  wallMs: number;
  turns: number;
}

export type CommitPlan = Omit<RunOutcome, 'design'> & {
  design?: DesignDraft & { stlArtifact?: string; stepArtifact?: string };
};

export interface MessageAttachmentRef {
  id: string;
  kind: 'markup' | 'reference';
}

export interface ChatRequest {
  threadId: string;
  clientMessageId: string;
  text: string;
  viewingVersion: number | null;
  attachmentIds?: string[];
  attachments?: MessageAttachmentRef[];
  pinnedParams?: Record<string, number>;
  editedBody?: string;
  model?: string;
}

export type StartInput = ChatRequest & { ownerKey: string };

export interface GraphInput {
  messages: { role: 'user' | 'assistant'; kind: string; content: string }[];
  baseVersion: number | null;
  baseBody: string | null;
  baseRequest: string | null;
  attachments: { mediaType: 'image/png'; base64: string; kind: 'markup' | 'reference' }[];
}

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface EndEvent {
  t: 'end';
  seq: number;
  status: Exclude<RunStatus, 'running'>;
  reply: { messageId: string; kind: ReplyKind; markdown: string };
  designVersion?: number;
}

export interface ThreadRow {
  id: string;
  ownerKey: string;
  title: string | null;
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface RunRow {
  id: string;
  threadId: string;
  status: RunStatus;
  model: string | null;
  baseVersion: number | null;
  createdAt: number;
  updatedAt: number;
  heartbeatAt: number;
  deadlineAt: number;
  lastSeq: number;
  error: { code: TerminateCode } | null;
  costUsd: number;
  wallMs: number | null;
  turns: number | null;
  designVersion: number | null;
  endedAt: number | null;
}

export interface MessageRow {
  id: string;
  threadId: string;
  seq: number;
  role: 'user' | 'assistant';
  kind: string;
  content: string;
  runId: string | null;
  designVersion: number | null;
  clientMessageId: string | null;
  createdAt: number;
  attachmentIds: string[];
  attachments: MessageAttachmentRef[];
  steps?: TranscriptSection[];
}

export interface DesignRow {
  threadId: string;
  version: number;
  parentVersion: number | null;
  origin: 'designer' | 'user_edit';
  runId: string | null;
  baseRequest: string;
  edits: unknown[];
  body: string;
  preludeVersion: string;
  summary: string;
  facts: unknown | null;
  flags: string[];
  stlArtifact: string | null;
  stepArtifact: string | null;
  createdAt: number;
}

export interface ArtifactRow {
  id: string;
  ownerKey: string;
  threadId: string | null;
  runId: string | null;
  kind: 'stl' | 'step' | 'image';
  bytes: number;
  objectKey: string;
  createdAt: number;
}

export type StoreErrorCode =
  | 'not_found'
  | 'run_active'
  | 'stale_client'
  | 'bad_pin'
  | 'duplicate_message'
  | 'busy'
  | 'budget';

export class StoreError extends Error {
  readonly status: 400 | 404 | 409 | 429;
  readonly code: StoreErrorCode;
  readonly activeRunId?: string;

  constructor(
    status: 400 | 404 | 409 | 429,
    code: StoreErrorCode,
    message: string,
    activeRunId?: string
  ) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
    if (activeRunId !== undefined) {
      this.activeRunId = activeRunId;
    }
  }
}

export function notFound(): StoreError {
  return new StoreError(404, 'not_found', 'Not found.');
}

export function runActive(activeRunId: string): StoreError {
  return new StoreError(409, 'run_active', RUN_ACTIVE, activeRunId);
}

export function staleClient(): StoreError {
  return new StoreError(400, 'stale_client', STALE_CLIENT);
}

export function badPin(): StoreError {
  return new StoreError(400, 'bad_pin', BAD_PIN);
}

function parseJsonField<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

export function rowToThread(row: Record<string, unknown>): ThreadRow {
  return {
    id: String(row.id),
    ownerKey: String(row.owner_key ?? row.ownerKey),
    title: (row.title as string | null) ?? null,
    activeRunId: ((row.active_run_id ?? row.activeRunId) as string | null) ?? null,
    createdAt: Number(row.created_at ?? row.createdAt),
    updatedAt: Number(row.updated_at ?? row.updatedAt),
    archivedAt: ((row.archived_at ?? row.archivedAt) as number | null) ?? null,
  };
}

export function rowToRun(row: Record<string, unknown>): RunRow {
  return {
    id: String(row.id),
    threadId: String(row.thread_id ?? row.threadId),
    status: row.status as RunStatus,
    model: (row.model as string | null) ?? null,
    baseVersion: ((row.base_version ?? row.baseVersion) as number | null) ?? null,
    createdAt: Number(row.created_at ?? row.createdAt),
    updatedAt: Number(row.updated_at ?? row.updatedAt),
    heartbeatAt: Number(row.heartbeat_at ?? row.heartbeatAt),
    deadlineAt: Number(row.deadline_at ?? row.deadlineAt),
    lastSeq: Number(row.last_seq ?? row.lastSeq),
    error: parseJsonField<{ code: TerminateCode } | null>(row.error, null),
    costUsd: Number(row.cost_usd ?? row.costUsd ?? 0),
    wallMs: ((row.wall_ms ?? row.wallMs) as number | null) ?? null,
    turns: ((row.turns) as number | null) ?? null,
    designVersion: ((row.design_version ?? row.designVersion) as number | null) ?? null,
    endedAt: ((row.ended_at ?? row.endedAt) as number | null) ?? null,
  };
}

export function rowToMessage(
  row: Record<string, unknown>,
  attachments?: MessageAttachmentRef[] | string[]
): MessageRow {
  const rawAtts =
    attachments ??
    parseJsonField<unknown[]>(row.attachments ?? row.attachment_ids ?? row.attachmentIds, []);

  const parsedAttachments: MessageAttachmentRef[] = Array.isArray(rawAtts)
    ? rawAtts.map((item) => {
        if (typeof item === 'string') {
          return { id: item, kind: 'reference' };
        }
        if (item && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          return {
            id: String(rec.id),
            kind: rec.kind === 'markup' ? 'markup' : 'reference',
          };
        }
        return { id: String(item), kind: 'reference' };
      })
    : [];

  const attachmentIds = parsedAttachments.map((a) => a.id);
  const role = row.role as 'user' | 'assistant';

  let steps: TranscriptSection[] | undefined;
  if (role === 'assistant') {
    steps = parseJsonField<TranscriptSection[]>(row.steps, []);
  }

  return {
    id: String(row.id),
    threadId: String(row.thread_id ?? row.threadId),
    seq: Number(row.seq),
    role,
    kind: String(row.kind),
    content: String(row.content),
    runId: ((row.run_id ?? row.runId) as string | null) ?? null,
    designVersion: ((row.design_version ?? row.designVersion) as number | null) ?? null,
    clientMessageId: ((row.client_message_id ?? row.clientMessageId) as string | null) ?? null,
    createdAt: Number(row.created_at ?? row.createdAt),
    attachmentIds,
    attachments: parsedAttachments,
    ...(steps !== undefined ? { steps } : {}),
  };
}

export function rowToDesign(row: Record<string, unknown>): DesignRow {
  return {
    threadId: String(row.thread_id ?? row.threadId),
    version: Number(row.version),
    parentVersion: ((row.parent_version ?? row.parentVersion) as number | null) ?? null,
    origin: row.origin as 'designer' | 'user_edit',
    runId: ((row.run_id ?? row.runId) as string | null) ?? null,
    baseRequest: String(row.base_request ?? row.baseRequest),
    edits: parseJsonField<unknown[]>(row.edits, []),
    body: String(row.body),
    preludeVersion: String(row.prelude_version ?? row.preludeVersion),
    summary: String(row.summary),
    facts: parseJsonField<unknown | null>(row.facts, null),
    flags: parseJsonField<string[]>(row.flags, []),
    stlArtifact: ((row.stl_artifact ?? row.stlArtifact) as string | null) ?? null,
    stepArtifact: ((row.step_artifact ?? row.stepArtifact) as string | null) ?? null,
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}

export function rowToArtifact(row: Record<string, unknown>): ArtifactRow {
  return {
    id: String(row.id),
    ownerKey: String(row.owner_key ?? row.ownerKey),
    threadId: ((row.thread_id ?? row.threadId) as string | null) ?? null,
    runId: ((row.run_id ?? row.runId) as string | null) ?? null,
    kind: row.kind as 'stl' | 'step' | 'image',
    bytes: Number(row.bytes),
    objectKey: String(row.object_key ?? row.objectKey),
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}
