import * as fs from 'fs';
import * as path from 'path';
import type { ApiError, RunInfo, RunStatus } from '@/lib/contract/run-contract';
import { checkpointTtlMs } from '@/lib/agent/checkpointer';
import { runStoreDir, runStoreKind } from './config';

/** An event as stored: the payload plus its envelope. */
export type StoredEvent = { seq: number; ts: number } & Record<string, unknown>;

/** What a caller hands to append(): any event object; `ts` is kept if present, else stamped. */
export type RunEventInput = Record<string, unknown> & { ts?: number };

export interface NewRun {
  runId: string;
  threadId: string;
  status?: RunStatus; // default 'running'
  startedAt?: number; // default now
}

/**
 * Persistent run state. Deliberately small so a Postgres / Redis implementation
 * can follow: one record per run, an append-only ordered event log per run, and
 * one cancel flag per run.
 */
export interface RunStore {
  /** Creates the record. Throws if the runId exists or is not a safe id. */
  create(run: NewRun): Promise<RunInfo>;
  get(runId: string): Promise<RunInfo | undefined>;
  /** `paused` also sets expiresAt (now + checkpoint TTL); every other status clears it. */
  setStatus(runId: string, status: RunStatus, error?: ApiError): Promise<void>;
  /** Appends and returns the event's seq (1, 2, 3 ... per run, gap-free, in append order). */
  append(runId: string, event: RunEventInput): Promise<number>;
  /** Stored events with seq > afterSeq, in order. */
  events(runId: string, afterSeq: number): Promise<StoredEvent[]>;
  /** Raises the cancel flag. Visible to every instance that shares the store. */
  requestCancel(runId: string): Promise<void>;
  isCancelled(runId: string): Promise<boolean>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export function isSafeRunId(id: string): boolean {
  return SAFE_ID.test(id);
}

type Meta = Omit<RunInfo, 'lastSeq'>;

/**
 * JSON-lines files under `dir`:
 *   <runId>.json    run record (atomic tmp+rename writes)
 *   <runId>.jsonl   event log, one JSON object per line
 *   <runId>.cancel  exists once cancel was requested
 * Appends to one run are serialized through an in-process queue, so concurrent
 * appends from this process never interleave or reuse a seq. One run has one
 * writer process at a time (the instance streaming it).
 */
export class LocalRunStore implements RunStore {
  private queues = new Map<string, Promise<unknown>>();
  private counters = new Map<string, number>();

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private p(runId: string, ext: string): string {
    if (!isSafeRunId(runId)) throw new Error(`Invalid runId "${runId}".`);
    return path.join(/*turbopackIgnore: true*/ this.dir, `${runId}.${ext}`);
  }

  private serial<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(runId, tail);
    void tail.then(() => {
      if (this.queues.get(runId) === tail) this.queues.delete(runId);
    });
    return next;
  }

  private async readMeta(runId: string): Promise<Meta | undefined> {
    if (!isSafeRunId(runId)) return undefined;
    try {
      return JSON.parse(await fs.promises.readFile(this.p(runId, 'json'), 'utf-8')) as Meta;
    } catch {
      return undefined;
    }
  }

  private async writeMeta(meta: Meta): Promise<void> {
    const file = this.p(meta.runId, 'json');
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(meta), 'utf-8');
    await fs.promises.rename(tmp, file);
  }

  private async readLog(runId: string): Promise<StoredEvent[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.p(runId, 'jsonl'), 'utf-8');
    } catch {
      return [];
    }
    const out: StoredEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as StoredEvent);
      } catch {
        // A torn final line from a concurrent append: it is not stored yet.
      }
    }
    return out;
  }

  private async lastSeq(runId: string): Promise<number> {
    const cached = this.counters.get(runId);
    if (cached !== undefined) return cached;
    const log = await this.readLog(runId);
    return log.length ? log[log.length - 1].seq : 0;
  }

  async create(run: NewRun): Promise<RunInfo> {
    const file = this.p(run.runId, 'json');
    if (fs.existsSync(file)) throw new Error(`Run ${run.runId} already exists.`);
    const now = Date.now();
    const status = run.status ?? 'running';
    const meta: Meta = {
      runId: run.runId,
      threadId: run.threadId,
      status,
      startedAt: run.startedAt ?? now,
      updatedAt: now,
      ...(status === 'paused' ? { expiresAt: now + checkpointTtlMs() } : {}),
    };
    await this.writeMeta(meta);
    return { ...meta, lastSeq: 0 };
  }

  async get(runId: string): Promise<RunInfo | undefined> {
    const meta = await this.readMeta(runId);
    if (!meta) return undefined;
    return { ...meta, lastSeq: await this.lastSeq(runId) };
  }

  async setStatus(runId: string, status: RunStatus, error?: ApiError): Promise<void> {
    await this.serial(runId, async () => {
      const meta = await this.readMeta(runId);
      if (!meta) throw new Error(`Unknown run ${runId}.`);
      const now = Date.now();
      const rest: Meta = { ...meta };
      delete rest.expiresAt;
      delete rest.error;
      await this.writeMeta({
        ...rest,
        status,
        updatedAt: now,
        ...(status === 'paused' ? { expiresAt: now + checkpointTtlMs() } : {}),
        ...(error ? { error } : {}),
      });
    });
  }

  append(runId: string, event: RunEventInput): Promise<number> {
    return this.serial(runId, async () => {
      if (!fs.existsSync(this.p(runId, 'json'))) throw new Error(`Unknown run ${runId}.`);
      const seq = (await this.lastSeq(runId)) + 1;
      const ts = typeof event.ts === 'number' ? event.ts : Date.now();
      await fs.promises.appendFile(this.p(runId, 'jsonl'), `${JSON.stringify({ ...event, seq, ts })}\n`, 'utf-8');
      this.counters.set(runId, seq);
      return seq;
    });
  }

  async events(runId: string, afterSeq: number): Promise<StoredEvent[]> {
    if (!isSafeRunId(runId)) return [];
    return (await this.readLog(runId)).filter((e) => e.seq > afterSeq);
  }

  async requestCancel(runId: string): Promise<void> {
    await fs.promises.writeFile(this.p(runId, 'cancel'), String(Date.now()), 'utf-8');
  }

  async isCancelled(runId: string): Promise<boolean> {
    if (!isSafeRunId(runId)) return false;
    return fs.existsSync(this.p(runId, 'cancel'));
  }
}

let singleton: { key: string; store: RunStore } | null = null;

/** The process-wide store, chosen by CADAI_RUN_STORE; re-created if CADAI_RUN_DIR changes. */
export function getRunStore(): RunStore {
  runStoreKind(); // validates CADAI_RUN_STORE
  const dir = runStoreDir();
  if (!singleton || singleton.key !== dir) singleton = { key: dir, store: new LocalRunStore(dir) };
  return singleton.store;
}
