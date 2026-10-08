import { MemorySaver } from '@langchain/langgraph';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph';

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
 */
export function checkpointStoreDir(): string {
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
function replacer(key: string, value: any) {
  if (value instanceof Uint8Array) {
    return { _type: 'Uint8Array', data: Buffer.from(value).toString('base64') };
  }
  return value;
}

function reviver(key: string, value: any) {
  if (value && typeof value === 'object' && value._type === 'Uint8Array' && typeof value.data === 'string') {
    return new Uint8Array(Buffer.from(value.data, 'base64'));
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

export class FileCheckpointSaver extends MemorySaver {
  readonly dir: string;
  private filePath: string;
  private pendingFlush: NodeJS.Timeout | null = null;
  private lastPrune = 0;

  constructor(dir: string) {
    super();
    this.dir = ensureWritableDir(dir);
    this.filePath = path.join(this.dir, 'checkpoints.json');
    this.load();
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
    const ttl = checkpointTtlMs();
    const removed: string[] = [];
    const threads = Object.keys((this as unknown as { storage?: Record<string, unknown> }).storage ?? {});
    for (const threadId of threads) {
      let newest = 0;
      for await (const tuple of this.list({ configurable: { thread_id: threadId } }, { limit: 1 })) {
        newest = Date.parse(tuple.checkpoint.ts) || 0;
      }
      if (now - newest > ttl) {
        await super.deleteThread(threadId);
        removed.push(threadId);
      }
    }
    if (removed.length > 0) this.flush();
    return removed;
  }

  private load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(data, reviver);
        
        // MemorySaver exposes these publicly
        if (parsed.storage) {
          (this as any).storage = parsed.storage;
        }
        if (parsed.writes) {
          (this as any).writes = parsed.writes;
        }
      }
    } catch (e) {
      console.error('Failed to load checkpointer data:', e);
    }
  }

  private flush() {
    if (this.pendingFlush) return; // Debounce flush
    this.pendingFlush = setTimeout(() => {
      try {
        const data = JSON.stringify({
          storage: (this as any).storage,
          writes: (this as any).writes
        }, replacer, 2);
        fs.writeFileSync(this.filePath, data, 'utf-8');
      } catch (e) {
        console.error('Failed to flush checkpointer data:', e);
      } finally {
        this.pendingFlush = null;
      }
    }, 100);
  }

  async put(...args: any[]) {
    const result = await super.put(...(args as [any, any, any]));
    this.flush();
    // At most once an hour, on the write path.
    if (Date.now() - this.lastPrune > HOUR_MS) {
      void this.pruneExpired().catch((e) => console.warn('Checkpoint prune failed:', e));
    }
    return result;
  }

  async putWrites(...args: any[]) {
    await super.putWrites(...(args as [any, any, any]));
    this.flush();
  }

  // MemorySaver.deleteThread already drops both storage[threadId] AND every
  // writes[] entry keyed to that thread; re-implementing it here only ever
  // leaked the writes half. Delegate, then persist.
  async deleteThread(id: string) {
    await super.deleteThread(id);
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
let singleton: FileCheckpointSaver | null = null;
export function getCheckpointer(): FileCheckpointSaver {
  if (!singleton) {
    singleton = new FileCheckpointSaver(checkpointStoreDir());
  }
  return singleton;
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
