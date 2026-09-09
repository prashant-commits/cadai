import { MemorySaver } from '@langchain/langgraph';
import * as fs from 'fs';
import * as path from 'path';
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph';

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

export class FileCheckpointSaver extends MemorySaver {
  private filePath: string;
  private pendingFlush: NodeJS.Timeout | null = null;

  constructor(private dir: string) {
    super();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, 'checkpoints.json');
    this.load();
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
    singleton = new FileCheckpointSaver(path.join(process.cwd(), '.cadai'));
  }
  return singleton;
}
