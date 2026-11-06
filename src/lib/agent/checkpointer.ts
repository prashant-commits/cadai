import { MemorySaver } from '@langchain/langgraph';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Directory for the on-disk HIL checkpoint store.
 *
 * Locally this is `<cwd>/.cadai` (gitignored). On Vercel `process.cwd()` is
 * `/var/task`, which is not writable - mkdir there throws ENOENT and takes
 * the chat stream down with it. `/tmp` is the only writable path in a
 * function, so that's where paused-run state lives in production.
 *
 * `/tmp` is per-instance and ephemeral: a resume must land on the same
 * warm isolate to find the checkpoint. That is still enough for the spec
 * gate as long as Fluid Compute keeps the instance around for the review.
 * Cross-instance resume on Vercel needs the future shared store
 * (CADAI_RUN_STORE=postgres|redis, not implemented); `local` shares state only
 * between instances that see the same disk.
 */
export function checkpointStoreDir(): string {
  // CADAI_RUN_DIR (the run store's directory) wins: pointing two server
  // instances at one directory is how a resume reaches a checkpoint another
  // instance wrote. See src/lib/runs/config.ts for the storage choice.
  const shared = process.env.CADAI_RUN_DIR?.trim();
  if (shared) return path.resolve(shared);
  return process.env.VERCEL
    ? path.join(os.tmpdir(), 'cadai')
    : path.join(process.cwd(), '.cadai');
}

function ensureWritableDir(preferred: string): string {
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'cadai');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

// Custom replacer/reviver for Uint8Array base64 round-tripping
function replacer(_key: string, value: unknown) {
  if (value instanceof Uint8Array) {
    return { _type: 'Uint8Array', data: Buffer.from(value).toString('base64') };
  }
  return value;
}

function reviver(_key: string, value: unknown) {
  const v = value as { _type?: unknown; data?: unknown } | null;
  if (v && typeof v === 'object' && v._type === 'Uint8Array' && typeof v.data === 'string') {
    return new Uint8Array(Buffer.from(v.data, 'base64'));
  }
  return value;
}

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = 24 * HOUR_MS; // a paused run nobody resumed within a day is abandoned

/** CADAI_CHECKPOINT_TTL_MS, validated: non-numeric or <= 0 -> 24 h. */
export function checkpointTtlMs(): number {
  const n = Number(process.env.CADAI_CHECKPOINT_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

type Persisted = { storage: Record<string, unknown>; writes: Record<string, unknown> };

function threadOfWriteKey(key: string): string | undefined {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A MemorySaver mirrored to `<dir>/checkpoints.json`.
 *
 * Several saver instances (several server processes on one disk) may share the
 * file. Each instance only owns the threads it wrote or deleted since its last
 * flush ("dirty" / "deleted"); everything else is taken from disk. So a flush
 * merges instead of overwriting, and a read first picks up threads other
 * instances wrote. Writes are atomic (tmp + rename). The merge is
 * read-modify-write without a file lock: two processes flushing in the same
 * few milliseconds can lose the older write. Threads are per-run and one run is
 * driven by one instance at a time, so that does not happen in practice.
 */
export class FileCheckpointSaver extends MemorySaver {
  readonly dir: string;
  private filePath: string;
  private pendingFlush: NodeJS.Timeout | null = null;
  private lastPrune = 0;
  private dirty = new Set<string>();
  private deleted = new Set<string>();
  private stamp = '';

  constructor(dir: string) {
    super();
    this.dir = ensureWritableDir(dir);
    this.filePath = path.join(this.dir, 'checkpoints.json');
    this.refresh();
    // Abandoned paused runs are only ever dropped by age; sweep at startup.
    void this.pruneExpired().catch((e) => console.warn('Checkpoint prune failed:', e));
  }

  /**
   * Deletes every thread whose NEWEST checkpoint is older than the TTL. A run
   * that paused at a gate and was never resumed or cancelled otherwise stays in
   * checkpoints.json (and is rewritten on every later step) forever.
   */
  async pruneExpired(now: number = Date.now()): Promise<string[]> {
    this.lastPrune = now;
    this.refresh();
    const ttl = checkpointTtlMs();
    const removed: string[] = [];
    const threads = Object.keys((this as unknown as { storage?: Record<string, unknown> }).storage ?? {});
    for (const threadId of threads) {
      let newest = 0;
      for await (const tuple of super.list({ configurable: { thread_id: threadId } }, { limit: 1 })) {
        newest = Date.parse(tuple.checkpoint.ts) || 0;
      }
      if (now - newest > ttl) {
        await super.deleteThread(threadId);
        this.markDeleted(threadId);
        removed.push(threadId);
      }
    }
    if (removed.length > 0) this.flush();
    return removed;
  }

  private statFile(): string {
    try {
      const st = fs.statSync(this.filePath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  }

  private readDisk(): Persisted | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'), reviver);
      return { storage: parsed?.storage ?? {}, writes: parsed?.writes ?? {} };
    } catch (e) {
      console.error('Failed to load checkpointer data:', e);
      return null;
    }
  }

  private markDirty(threadId: string) {
    this.dirty.add(threadId);
    this.deleted.delete(threadId);
  }

  private markDeleted(threadId: string) {
    this.deleted.add(threadId);
    this.dirty.delete(threadId);
  }

  /** Adopt every thread on disk that this instance has not changed locally; forget threads another instance deleted. */
  private refresh() {
    const stamp = this.statFile();
    if (stamp === this.stamp) return;
    const self = this as unknown as Persisted;
    const disk = this.readDisk();
    const diskStorage = disk?.storage ?? {};
    const diskWrites = disk?.writes ?? {};
    for (const id of Object.keys(self.storage)) {
      if (!this.dirty.has(id) && !(id in diskStorage)) delete self.storage[id];
    }
    for (const [id, value] of Object.entries(diskStorage)) {
      if (!this.dirty.has(id) && !this.deleted.has(id)) self.storage[id] = value;
    }
    for (const key of Object.keys(self.writes)) {
      const id = threadOfWriteKey(key);
      if (id !== undefined && !this.dirty.has(id)) delete self.writes[key];
    }
    for (const [key, value] of Object.entries(diskWrites)) {
      const id = threadOfWriteKey(key);
      if (id !== undefined && !this.dirty.has(id) && !this.deleted.has(id)) self.writes[key] = value;
    }
    this.stamp = stamp;
  }

  /** Synchronously merge our changes into the file. */
  private writeThrough() {
    const self = this as unknown as Persisted;
    const disk = this.readDisk() ?? { storage: {}, writes: {} };
    for (const id of this.deleted) delete disk.storage[id];
    for (const key of Object.keys(disk.writes)) {
      const id = threadOfWriteKey(key);
      if (id !== undefined && (this.deleted.has(id) || this.dirty.has(id))) delete disk.writes[key];
    }
    for (const id of this.dirty) {
      if (id in self.storage) disk.storage[id] = self.storage[id];
      else delete disk.storage[id];
    }
    for (const [key, value] of Object.entries(self.writes)) {
      const id = threadOfWriteKey(key);
      if (id !== undefined && this.dirty.has(id)) disk.writes[key] = value;
    }
    const tmp = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(disk, replacer, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
    this.dirty.clear();
    this.deleted.clear();
    // Pick up other instances' threads that were not in memory yet.
    this.stamp = '';
    this.refresh();
  }

  /** Write pending changes now (a paused run must be on disk before the client is told it paused). */
  flushNow() {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (this.dirty.size === 0 && this.deleted.size === 0) return;
    try {
      this.writeThrough();
    } catch (e) {
      console.error('Failed to flush checkpointer data:', e);
    }
  }

  private flush() {
    if (this.pendingFlush) return; // Debounce flush
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      this.flushNow();
    }, 100);
  }

  async getTuple(config: Parameters<MemorySaver['getTuple']>[0]) {
    this.refresh();
    return super.getTuple(config);
  }

  async *list(...args: Parameters<MemorySaver['list']>) {
    this.refresh();
    yield* super.list(...args);
  }

  // Callers (langgraph, tests) may pass a 4th newVersions argument; MemorySaver ignores it.
  async put(...args: [...Parameters<MemorySaver['put']>, ...unknown[]]) {
    const [config, checkpoint, metadata] = args;
    const threadId = config?.configurable?.thread_id as string | undefined;
    this.refresh();
    const result = await super.put(config, checkpoint, metadata);
    if (threadId) this.markDirty(threadId);
    this.flush();
    // At most once an hour, on the write path.
    if (Date.now() - this.lastPrune > HOUR_MS) {
      void this.pruneExpired().catch((e) => console.warn('Checkpoint prune failed:', e));
    }
    return result;
  }

  async putWrites(...args: Parameters<MemorySaver['putWrites']>) {
    const threadId = args[0]?.configurable?.thread_id as string | undefined;
    await super.putWrites(...args);
    if (threadId) this.markDirty(threadId);
    this.flush();
  }

  // MemorySaver.deleteThread already drops both storage[threadId] AND every
  // writes[] entry keyed to that thread; re-implementing it here only ever
  // leaked the writes half. Delegate, then persist.
  async deleteThread(id: string) {
    await super.deleteThread(id);
    this.markDeleted(id);
    this.flush();
  }
}

/**
 * Checkpoint key for ONE agent run.
 *
 * Deliberately not the chat thread id. The checkpointer exists so an
 * interrupt() can survive the gap between two HTTP requests - not to carry
 * conversation history. Keying on the chat thread made every turn resume the
 * previous turn's state, so `messages` (a concat reducer) replayed each
 * earlier spec dump, code listing and validation report back into the next
 * turn's prompt, on top of the history the client already re-sends.
 * One key per run keeps a paused run resumable while each turn still starts
 * from a clean state.
 */
export function runCheckpointKey(threadId: string, runId: string): string {
  return `${threadId}::${runId}`;
}

// Module-level singleton. A checkpointer instantiated per-request would give
// each request its own in-memory `storage`/`writes`, so two concurrent
// requests writing to the same checkpoints.json would race and stomp each
// other's threads on flush. One shared instance also lets the resume route
// call deleteThread() directly on cancel, without invoking the graph.
// Keyed by directory so a changed CADAI_RUN_DIR (tests, a second store) gets its own saver.
let singleton: { dir: string; saver: FileCheckpointSaver } | null = null;
export function getCheckpointer(): FileCheckpointSaver {
  const dir = checkpointStoreDir();
  if (!singleton || singleton.dir !== dir) {
    singleton = { dir, saver: new FileCheckpointSaver(dir) };
  }
  return singleton.saver;
}

/**
 * Drop a paused run's checkpoint. Swallows construction AND delete failures:
 * `/api/chat`'s catch used to call `getCheckpointer().deleteThread().catch()`,
 * which does not catch a synchronous throw from the constructor, so a dead
 * saver turned into an unhandledRejection and an empty SSE body.
 */
export async function deleteRunCheckpoint(id: string): Promise<void> {
  try {
    await getCheckpointer().deleteThread(id);
  } catch {
    // The run is already unresumable; failing to clean up must not hide the
    // original error from the client.
  }
}
