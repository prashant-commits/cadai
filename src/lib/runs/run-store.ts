import * as fs from 'fs';
import * as os from 'os';
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

/** Only apply the change when the run's current status is one of these. */
export interface Transition {
  expect?: RunStatus[];
}

export interface AppendOptions extends Transition {
  /** Move the run to this status in the same atomic step as the append. */
  status?: RunStatus;
  error?: ApiError;
}

export interface EventPage {
  events: StoredEvent[];
  /** Opaque; pass back to read only what was appended since. */
  cursor: string;
  /** More stored events are ready right now (the page was size-capped). */
  more: boolean;
}

/**
 * Persistent run state. Deliberately small so a Postgres / Redis implementation
 * can follow: one record per run, an append-only ordered event log per run, and
 * one cancel flag per run. Every write that checks a status is atomic per run
 * (a row lock / transaction in a database).
 */
export interface RunStore {
  /** Creates the record. Throws if the runId exists or is not a safe id. */
  create(run: NewRun): Promise<RunInfo>;
  /** Also reaps a `running` run whose owner stopped heartbeating (-> failed). */
  get(runId: string): Promise<RunInfo | undefined>;
  /**
   * `paused` also sets expiresAt (now + checkpoint TTL); every other status
   * clears it. Returns false (and changes nothing) when `expect` does not match.
   */
  setStatus(runId: string, status: RunStatus, error?: ApiError, opts?: Transition): Promise<boolean>;
  /**
   * Appends and returns the event's seq (1, 2, 3 ... per run, gap-free, in
   * append order, across every instance sharing the store). With
   * `opts.status`, the status changes in the same atomic step, so a terminal
   * event and a terminal status are never seen apart. Returns 0 (and writes
   * nothing) when `opts.expect` does not match.
   */
  append(runId: string, event: RunEventInput, opts?: AppendOptions): Promise<number>;
  /** Stored events with seq > afterSeq, in order. */
  events(runId: string, afterSeq: number): Promise<StoredEvent[]>;
  /** Like events(), but resumable: pass the returned cursor to read only new events. */
  eventsSince(runId: string, afterSeq: number, cursor?: string): Promise<EventPage>;
  /** Raises the cancel flag if the run is running or paused; false when it already ended. */
  requestCancel(runId: string): Promise<boolean>;
  isCancelled(runId: string): Promise<boolean>;
  /** The owner's liveness signal: bumps updatedAt of a running run. */
  heartbeat(runId: string): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Names that are store files or directories. Never valid run ids, whatever the layout. */
const RESERVED = new Set(['checkpoints', 'runs', 'events', 'cancel', 'locks', 'tmp']);

export function isSafeRunId(id: string): boolean {
  return typeof id === 'string' && SAFE_ID.test(id) && !RESERVED.has(id.toLowerCase());
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled']);
export const isTerminal = (s: RunStatus) => TERMINAL.has(s);

export const RUN_LOST_MESSAGE = 'run lost: its server instance stopped';

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
/**
 * A running run whose owner has not heartbeated for this long has lost its
 * owner. Generous on purpose (5 min against a 15 s heartbeat): a false
 * positive fails a healthy run.
 */
export const runLostMs = () => envMs('CADAI_RUN_LOST_MS', 5 * 60_000);
/** How often the owner heartbeats. */
export const runHeartbeatMs = () => envMs('CADAI_RUN_HEARTBEAT_MS', 15_000);
/** Finished runs older than this are deleted. */
export const runTtlMs = () => envMs('CADAI_RUN_TTL_MS', 24 * 60 * 60 * 1000);

/** A lock older than this belongs to a crashed (or badly stalled) writer and is broken. */
const lockStaleMs = () => envMs('CADAI_RUN_LOCK_STALE_MS', 15_000);
/** Longer than the stale age (20 s by default), so a waiter always outlives a dead writer's lock and breaks it. */
const lockWaitMs = () => Math.ceil((lockStaleMs() * 4) / 3);
const PRUNE_EVERY_MS = 60_000;
const PAGE_BYTES = 4 * 1024 * 1024;
const SCAN_CHUNK = 64 * 1024;

/** The record on disk: RunInfo minus lastSeq (read from the log), plus the owner's heartbeat counter. */
type Meta = Omit<RunInfo, 'lastSeq'> & { beat?: number };

const toInfo = (meta: Meta, lastSeq: number): RunInfo => {
  const { beat: _beat, ...info } = meta;
  void _beat;
  return { ...info, lastSeq };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

let warnedFallback = false;

/** `preferred` if its subdirectories can be created and written, else os.tmpdir()/cadai-runs (warns once). */
function writableRoot(preferred: string): string {
  const prepare = (root: string) => {
    for (const sub of ['runs', 'events', 'cancel', 'locks']) fs.mkdirSync(path.join(/*turbopackIgnore: true*/ root, sub), { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    return root;
  };
  try {
    return prepare(preferred);
  } catch (e) {
    const fallback = path.join(os.tmpdir(), 'cadai-runs');
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(`Run store directory ${preferred} is not writable (${errCode(e) ?? e}); using ${fallback}.`);
    }
    return prepare(fallback);
  }
}

/** Byte offset of the last '\n' strictly before `end`, or -1. Scans backwards in chunks. */
async function lastNewlineBefore(fh: fs.promises.FileHandle, end: number): Promise<number> {
  let pos = end;
  const buf = Buffer.alloc(SCAN_CHUNK);
  while (pos > 0) {
    const len = Math.min(SCAN_CHUNK, pos);
    const start = pos - len;
    const { bytesRead } = await fh.read(buf, 0, len, start);
    const i = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (i >= 0) return start + i;
    pos = start;
  }
  return -1;
}

/**
 * Files under `dir`, one subdirectory per kind so a run id can never name
 * another kind of file:
 *   runs/<runId>.json     run record (atomic tmp+rename writes)
 *   events/<runId>.jsonl  event log, one `{"seq":N,"ts":..,...}` object per line
 *   cancel/<runId>        exists once cancel was requested
 *   locks/<runId>.lock    O_EXCL lock held around every write to the run
 *
 * The lock makes writes safe across processes sharing the directory: seq is
 * read from the log's last line under the lock, never from a process cache.
 * A lock left by a crashed writer is broken after 15 s.
 */
export class LocalRunStore implements RunStore {
  readonly dir: string;
  private queues = new Map<string, Promise<unknown>>();
  private lastPrune = 0;
  /** Heartbeat counter last seen per running run, and when (this process's clock). */
  private observed = new Map<string, { beat: number; at: number }>();

  constructor(dir: string) {
    this.dir = writableRoot(dir);
    this.maybePrune();
  }

  private file(kind: 'runs' | 'events' | 'cancel' | 'locks', runId: string): string {
    if (!isSafeRunId(runId)) throw new Error(`Invalid runId "${runId}".`);
    const ext = kind === 'runs' ? '.json' : kind === 'events' ? '.jsonl' : kind === 'locks' ? '.lock' : '';
    return path.join(/*turbopackIgnore: true*/ this.dir, kind, `${runId}${ext}`);
  }

  /** In-process FIFO per run, so this process never spins on its own lock. */
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

  /** Cross-process exclusive section for one run. */
  private locked<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.serial(runId, async () => {
      const lock = this.file('locks', runId);
      const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
      const deadline = Date.now() + lockWaitMs();
      for (;;) {
        try {
          await fs.promises.writeFile(lock, token, { flag: 'wx' });
          break;
        } catch (e) {
          if (errCode(e) !== 'EEXIST') throw e;
          try {
            const st = await fs.promises.stat(lock);
            if (Date.now() - st.mtimeMs > lockStaleMs()) {
              // Rename first: only one breaker can win the rename of a given stale lock.
              const aside = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
              await fs.promises.rename(lock, aside).then(() => fs.promises.unlink(aside), () => undefined);
              continue;
            }
          } catch {
            continue; // released between our attempt and the stat
          }
          if (Date.now() > deadline) throw new Error(`Run ${runId} is locked by another writer.`);
          await sleep(3 + Math.random() * 7);
        }
      }
      try {
        return await fn();
      } finally {
        // Only release our own lock: if we stalled past the stale age and a
        // waiter broke it, the file now belongs to that waiter.
        const held = await fs.promises.readFile(lock, 'utf-8').catch(() => '');
        if (held === token) await fs.promises.unlink(lock).catch(() => undefined);
      }
    });
  }

  private async readMeta(runId: string): Promise<Meta | undefined> {
    if (!isSafeRunId(runId)) return undefined;
    try {
      return JSON.parse(await fs.promises.readFile(this.file('runs', runId), 'utf-8')) as Meta;
    } catch {
      return undefined;
    }
  }

  private async writeMeta(meta: Meta): Promise<void> {
    const file = this.file('runs', meta.runId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(meta), 'utf-8');
    await fs.promises.rename(tmp, file);
  }

  private withStatus(meta: Meta, status: RunStatus, error?: ApiError): Meta {
    const now = Date.now();
    const next: Meta = { ...meta, status, updatedAt: now };
    delete next.expiresAt;
    delete next.error;
    if (status === 'paused') next.expiresAt = now + checkpointTtlMs();
    if (error) next.error = error;
    return next;
  }

  /**
   * The last stored seq, read from the log's final complete line. A torn final
   * line (a writer crashed mid-append) is ignored, and cut off when `repair`
   * is set (only under the lock), so the next append starts on a clean line.
   */
  private async lastSeqOf(runId: string, repair: boolean): Promise<number> {
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(this.file('events', runId), repair ? 'r+' : 'r');
    } catch {
      return 0;
    }
    try {
      const { size } = await fh.stat();
      if (size === 0) return 0;
      const endNl = await lastNewlineBefore(fh, size);
      if (endNl < size - 1 && repair) await fh.truncate(endNl + 1);
      if (endNl < 0) return 0;
      const lineStart = (await lastNewlineBefore(fh, endNl)) + 1;
      const head = Buffer.alloc(Math.min(64, endNl - lineStart));
      await fh.read(head, 0, head.length, lineStart);
      const m = /^\{"seq":(\d+)/.exec(head.toString('utf-8'));
      if (m) return Number(m[1]);
      const line = Buffer.alloc(endNl - lineStart);
      await fh.read(line, 0, line.length, lineStart);
      return Number((JSON.parse(line.toString('utf-8')) as StoredEvent).seq) || 0;
    } finally {
      await fh.close();
    }
  }

  async create(run: NewRun): Promise<RunInfo> {
    return this.locked(run.runId, async () => {
      if (await this.readMeta(run.runId)) throw new Error(`Run ${run.runId} already exists.`);
      const now = Date.now();
      const base: Meta = { runId: run.runId, threadId: run.threadId, status: 'running', startedAt: run.startedAt ?? now, updatedAt: now };
      const meta = this.withStatus(base, run.status ?? 'running');
      meta.updatedAt = now;
      await this.writeMeta(meta);
      return toInfo(meta, 0);
    });
  }

  async get(runId: string): Promise<RunInfo | undefined> {
    this.maybePrune();
    let meta = await this.readMeta(runId);
    if (!meta) return undefined;
    if (this.looksLost(meta)) {
      await this.reapLost(runId, meta.beat ?? 0).catch((e) => console.warn('Run reap failed:', e));
      meta = (await this.readMeta(runId)) ?? meta;
    }
    return toInfo(meta, await this.lastSeqOf(runId, false));
  }

  /**
   * Whether a running run's owner stopped heartbeating.
   *
   * Preferred (skew-free): this process has watched the owner's heartbeat
   * counter and it has not moved for runLostMs by THIS process's clock.
   * Fallback, for a reader that has not watched the run before: the owner's
   * last `updatedAt` against this process's clock. That compares two
   * instances' clocks, so it assumes they agree to well within runLostMs
   * (5 min; NTP-synced hosts are within milliseconds). A shared network store
   * should use the database's clock instead.
   */
  private looksLost(meta: Meta, now = Date.now()): boolean {
    if (meta.status !== 'running') {
      this.observed.delete(meta.runId);
      return false;
    }
    const beat = meta.beat ?? 0;
    const seen = this.observed.get(meta.runId);
    if (seen && seen.beat === beat) return now - seen.at > runLostMs();
    this.observed.set(meta.runId, { beat, at: now });
    if (seen) return false; // the counter moved: the owner is alive
    return now - meta.updatedAt > runLostMs();
  }

  /**
   * Ends a run whose owner stopped heartbeating with a stored error event, so
   * tails end too. `judgedBeat` is the heartbeat count the verdict was based
   * on: if the owner heartbeated since, it is alive and nothing happens.
   */
  private reapLost(runId: string, judgedBeat: number): Promise<void> {
    return this.locked(runId, async () => {
      const meta = await this.readMeta(runId);
      if (!meta || meta.status !== 'running' || (meta.beat ?? 0) !== judgedBeat) return;
      const apiError: ApiError = { code: 'internal', message: RUN_LOST_MESSAGE };
      await this.appendLine(runId, { t: 'error', message: RUN_LOST_MESSAGE, apiError });
      await this.writeMeta(this.withStatus(meta, 'failed', apiError));
      await fs.promises.unlink(this.file('cancel', runId)).catch(() => undefined);
      this.observed.delete(runId);
    });
  }

  async setStatus(runId: string, status: RunStatus, error?: ApiError, opts?: Transition): Promise<boolean> {
    return this.locked(runId, async () => {
      const meta = await this.readMeta(runId);
      if (!meta) throw new Error(`Unknown run ${runId}.`);
      if (opts?.expect && !opts.expect.includes(meta.status)) return false;
      await this.writeMeta(this.withStatus(meta, status, error));
      if (isTerminal(status)) await fs.promises.unlink(this.file('cancel', runId)).catch(() => undefined);
      return true;
    });
  }

  /** Under the lock only. */
  private async appendLine(runId: string, event: RunEventInput): Promise<number> {
    const seq = (await this.lastSeqOf(runId, true)) + 1;
    const { seq: _s, ts, ...rest } = event as RunEventInput & { seq?: unknown };
    void _s;
    const line = JSON.stringify({ seq, ts: typeof ts === 'number' ? ts : Date.now(), ...rest });
    await fs.promises.appendFile(this.file('events', runId), `${line}\n`, 'utf-8');
    return seq;
  }

  append(runId: string, event: RunEventInput, opts?: AppendOptions): Promise<number> {
    return this.locked(runId, async () => {
      const meta = await this.readMeta(runId);
      if (!meta) throw new Error(`Unknown run ${runId}.`);
      if (opts?.expect && !opts.expect.includes(meta.status)) return 0;
      const seq = await this.appendLine(runId, event);
      if (opts?.status) {
        await this.writeMeta(this.withStatus(meta, opts.status, opts.error));
        if (isTerminal(opts.status)) await fs.promises.unlink(this.file('cancel', runId)).catch(() => undefined);
      }
      return seq;
    });
  }

  async eventsSince(runId: string, afterSeq: number, cursor?: string): Promise<EventPage> {
    const from = Math.max(0, Number(cursor ?? 0) || 0);
    const empty: EventPage = { events: [], cursor: String(from), more: false };
    if (!isSafeRunId(runId)) return empty;
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(this.file('events', runId), 'r');
    } catch {
      return empty;
    }
    try {
      const { size } = await fh.stat();
      if (size <= from) return empty;
      // Read up to PAGE_BYTES, growing only to finish one oversized line.
      let len = Math.min(size - from, PAGE_BYTES);
      let buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, from);
      let end = buf.lastIndexOf(0x0a);
      while (end < 0 && from + len < size) {
        len = Math.min(size - from, len * 2);
        buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, from);
        end = buf.lastIndexOf(0x0a);
      }
      if (end < 0) return empty; // only an in-progress (or torn) line so far
      const events: StoredEvent[] = [];
      for (const line of buf.subarray(0, end).toString('utf-8').split('\n')) {
        if (!line) continue;
        // Lines start with {"seq":N - skip old ones without parsing their payload.
        const m = /^\{"seq":(\d+)/.exec(line.slice(0, 32));
        if (m && Number(m[1]) <= afterSeq) continue;
        try {
          const e = JSON.parse(line) as StoredEvent;
          if (e.seq > afterSeq) events.push(e);
        } catch {
          // a torn line from a crashed writer, cut off by the next append
        }
      }
      const next = from + end + 1;
      return { events, cursor: String(next), more: next < size };
    } finally {
      await fh.close();
    }
  }

  async events(runId: string, afterSeq: number): Promise<StoredEvent[]> {
    const out: StoredEvent[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.eventsSince(runId, afterSeq, cursor);
      out.push(...page.events);
      cursor = page.cursor;
      if (!page.more) return out;
    }
  }

  requestCancel(runId: string): Promise<boolean> {
    return this.locked(runId, async () => {
      const meta = await this.readMeta(runId);
      if (!meta || isTerminal(meta.status)) return false;
      await fs.promises.writeFile(this.file('cancel', runId), String(Date.now()), 'utf-8');
      return true;
    });
  }

  async isCancelled(runId: string): Promise<boolean> {
    if (!isSafeRunId(runId)) return false;
    return fs.existsSync(this.file('cancel', runId));
  }

  heartbeat(runId: string): Promise<void> {
    return this.locked(runId, async () => {
      const meta = await this.readMeta(runId);
      if (meta?.status === 'running') await this.writeMeta({ ...meta, beat: (meta.beat ?? 0) + 1, updatedAt: Date.now() });
    });
  }

  /** Lazily, at most once a minute: see prune(). */
  maybePrune(now = Date.now()): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    void this.prune(now).catch((e) => console.warn('Run prune failed:', e));
  }

  /**
   * Deletes finished runs (and orphan logs) not updated for CADAI_RUN_TTL_MS,
   * and fails paused runs whose checkpoint expired (run_expired). Returns the
   * deleted run ids.
   */
  async prune(now = Date.now()): Promise<string[]> {
    const ttl = runTtlMs();
    const removed: string[] = [];
    const ids = new Set<string>();
    for (const kind of ['runs', 'events'] as const) {
      for (const f of await fs.promises.readdir(path.join(/*turbopackIgnore: true*/ this.dir, kind)).catch(() => [] as string[])) {
        const id = f.replace(/\.jsonl?$/, '');
        if (id !== f && isSafeRunId(id)) ids.add(id);
      }
    }
    for (const id of ids) {
      const meta = await this.readMeta(id);
      if (!meta) {
        const st = await fs.promises.stat(this.file('events', id)).catch(() => undefined);
        if (st && now - st.mtimeMs > ttl) {
          await this.remove(id);
          removed.push(id);
        }
        continue;
      }
      if (meta.status === 'running') {
        if (this.looksLost(meta, now)) await this.reapLost(id, meta.beat ?? 0).catch((e) => console.warn('Run reap failed:', e));
        continue; // a reaped run is deleted by a later prune, once it is older than the TTL
      }
      if (meta.status === 'paused' && meta.expiresAt !== undefined && meta.expiresAt < now) {
        await this.setStatus(id, 'failed', { code: 'run_expired', message: 'The paused run expired before it was resumed.' }, { expect: ['paused'] });
        continue;
      }
      if (isTerminal(meta.status) && now - meta.updatedAt > ttl) {
        await this.locked(id, async () => {
          const again = await this.readMeta(id);
          if (again && isTerminal(again.status) && now - again.updatedAt > ttl) {
            await this.remove(id);
            removed.push(id);
          }
        });
      }
    }
    await this.sweepLeftovers(now);
    return removed;
  }

  /**
   * Locks older than the stale age (their writer crashed) and the aside /
   * temp files a crash can leave between rename and unlink.
   */
  private async sweepLeftovers(now: number): Promise<void> {
    for (const kind of ['locks', 'runs'] as const) {
      const dir = path.join(/*turbopackIgnore: true*/ this.dir, kind);
      for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
        const leftover = f.endsWith('.lock') || f.endsWith('.stale') || f.endsWith('.tmp');
        if (!leftover || (kind === 'runs' && f.endsWith('.lock'))) continue;
        const file = path.join(/*turbopackIgnore: true*/ dir, f);
        const st = await fs.promises.stat(file).catch(() => undefined);
        if (!st || now - st.mtimeMs <= lockStaleMs()) continue;
        if (f.endsWith('.lock')) {
          // Same rename-first break as a waiter, so a fresh lock is never removed.
          const aside = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`;
          await fs.promises.rename(file, aside).then(() => fs.promises.unlink(aside), () => undefined);
        } else {
          await fs.promises.unlink(file).catch(() => undefined);
        }
      }
    }
  }

  private async remove(runId: string): Promise<void> {
    for (const kind of ['runs', 'events', 'cancel'] as const) {
      await fs.promises.unlink(this.file(kind, runId)).catch(() => undefined);
    }
  }
}

let singleton: { key: string; store: LocalRunStore } | null = null;

/** The process-wide store, chosen by CADAI_RUN_STORE; re-created if CADAI_RUN_DIR changes. */
export function getRunStore(): RunStore {
  runStoreKind(); // validates CADAI_RUN_STORE
  const dir = runStoreDir();
  if (!singleton || singleton.key !== dir) singleton = { key: dir, store: new LocalRunStore(dir) };
  else singleton.store.maybePrune();
  return singleton.store;
}
