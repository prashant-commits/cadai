import { IDBPDatabase, IDBPTransaction, openDB } from 'idb';
import { ChatMessage, ChatThread } from '@/types';
import {
  ACTIVE_THREAD_META_KEY,
  CadaiDB,
  DB_NAME,
  DB_VERSION,
  LEGACY_KEYS,
  MessageRow,
  ThreadRow,
  rowId,
} from './db-schema';

export const DEFAULT_OPENSCAD_CODE = `// CAD AI - Welcome Demo: Parametric Rounded Box with Center Bore
// Designed for FDM 3D Printing

// [Parameters]
width = 40;          // [20:80] Width in mm
depth = 40;          // [20:80] Depth in mm
height = 25;         // [10:60] Total height in mm
wall_thickness = 2.4;// [1.2:5] Minimum wall thickness
corner_radius = 5;   // [1:10] Corner fillet radius
hole_radius = 8;     // [3:15] Center bore radius
$fn = 48;            // Smooth curve resolution

module rounded_box(w, d, h, r) {
    hull() {
        translate([-(w/2-r), -(d/2-r), 0]) cylinder(h=h, r=r);
        translate([ (w/2-r), -(d/2-r), 0]) cylinder(h=h, r=r);
        translate([-(w/2-r),  (d/2-r), 0]) cylinder(h=h, r=r);
        translate([ (w/2-r),  (d/2-r), 0]) cylinder(h=h, r=r);
    }
}

difference() {
    // 1. Outer solid body with rounded corners
    rounded_box(width, depth, height, corner_radius);

    // 2. Center through-bore
    translate([0, 0, -1])
        cylinder(h=height + 2, r=hole_radius);
}
`;

export function createInitialThread(): ChatThread {
  const initialId = 'thread-' + Date.now();
  return {
    id: initialId,
    title: 'Demo Rounded Box',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModel: 'gemini-3.6-flash',
    code: DEFAULT_OPENSCAD_CODE,
    messages: [
      {
        id: 'welcome-msg',
        role: 'assistant',
        content: `👋 **Welcome to CAD AI!** I am your 3D parametric mechanical design assistant.

I specialize in creating 3D printable objects for **FDM, SLA, and SLS** printing. You can describe any part or mechanical design in plain English, and I will:
1. 🧠 Plan and reason about the mechanics & printability
2. ⚙️ Generate parametric OpenSCAD code
3. 🔍 Validate geometry & manifoldness before rendering
4. 🖨️ Recommend slicing settings (walls, infill, layer height, orientation)

**Try asking:**
- *"Design a snap-fit lid enclosure for an Arduino Uno"*
- *"Create a parametric phone stand tilted at 60 degrees with cable pass-through"*
- *"Make a durable hex-grid storage container"*
- *"Model a GT2 20-tooth timing pulley with 5mm shaft bore"*`,
        code: DEFAULT_OPENSCAD_CODE,
        timestamp: Date.now(),
      },
    ],
  };
}

// --- Database handle ---------------------------------------------------------

type CascadeTx = IDBPTransaction<
  CadaiDB,
  ('threads' | 'messages' | 'generatedCode')[],
  'readwrite'
>;

let dbPromise: Promise<IDBPDatabase<CadaiDB> | null> | null = null;

function getDB(): Promise<IDBPDatabase<CadaiDB> | null> {
  if (!dbPromise) {
    dbPromise = openDatabase();
  }
  return dbPromise;
}

async function openDatabase(): Promise<IDBPDatabase<CadaiDB> | null> {
  if (typeof indexedDB === 'undefined') return null;

  try {
    return await openDB<CadaiDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('threads', { keyPath: 'id' });

        const messages = db.createObjectStore('messages', { keyPath: 'rowId' });
        messages.createIndex('threadId', 'threadId');

        const generatedCode = db.createObjectStore('generatedCode', { keyPath: 'rowId' });
        generatedCode.createIndex('threadId', 'threadId');

        db.createObjectStore('meta');
      },
    });
  } catch (err) {
    // Private-mode / disabled-storage edge cases: degrade to in-memory only.
    console.error('IndexedDB unavailable; threads will not persist:', err);
    return null;
  }
}

/**
 * Test-only: close the open connection, drop the memoized handle and cancel any
 * queued debounced writes. The connection has to close or a follow-up
 * `deleteDatabase()` blocks on it.
 */
export async function __resetDbForTests(): Promise<void> {
  pendingCodeWrites.forEach((timer) => clearTimeout(timer));
  pendingCodeWrites.clear();
  inFlightLoad = null;

  const pending = dbPromise;
  dbPromise = null;
  if (pending) {
    const db = await pending.catch(() => null);
    db?.close();
  }
}

// --- Row mapping -------------------------------------------------------------

function toThreadRow(thread: ChatThread): ThreadRow {
  // Spread rather than list fields, so a new ChatThread field persists by default.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { messages, ...row } = thread;
  return row;
}

function toMessageRow(threadId: string, message: ChatMessage): MessageRow {
  return {
    rowId: rowId(threadId, message.id),
    threadId,
    id: message.id,
    role: message.role,
    content: message.content,
    image: message.image,
    progressUpdates: message.progressUpdates,
    timestamp: message.timestamp,
    hasCode: message.code !== undefined,
  };
}

async function assembleThread(
  db: IDBPDatabase<CadaiDB>,
  row: ThreadRow
): Promise<ChatThread> {
  const [messageRows, codeRows] = await Promise.all([
    db.getAllFromIndex('messages', 'threadId', row.id),
    db.getAllFromIndex('generatedCode', 'threadId', row.id),
  ]);

  const codeByRowId = new Map(codeRows.map((c) => [c.rowId, c.code]));

  const messages: ChatMessage[] = messageRows
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((m) => {
      const message: ChatMessage = {
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      };
      if (m.image !== undefined) message.image = m.image;
      if (m.progressUpdates !== undefined) message.progressUpdates = m.progressUpdates;

      const code = codeByRowId.get(m.rowId);
      if (code !== undefined) message.code = code;

      return message;
    });

  return {
    ...row,
    // Every loaded thread carries a contract, as the old loader guaranteed.
    designContract: row.designContract || { standing: {}, pinnedParams: {} },
    messages,
  };
}

// --- Load --------------------------------------------------------------------

function bootstrapInMemory(): { threads: ChatThread[]; activeThreadId: string } {
  const initial = createInitialThread();
  return { threads: [initial], activeThreadId: initial.id };
}

type LoadResult = { threads: ChatThread[]; activeThreadId: string };

let inFlightLoad: Promise<LoadResult> | null = null;

/**
 * Single-flight: React StrictMode invokes the init effect twice, and without
 * this both calls would see an empty database and each bootstrap its own
 * initial thread.
 */
export function loadAllThreads(): Promise<LoadResult> {
  if (!inFlightLoad) {
    inFlightLoad = readAllThreads().finally(() => {
      inFlightLoad = null;
    });
  }
  return inFlightLoad;
}

async function readAllThreads(): Promise<LoadResult> {
  const db = await getDB();
  if (!db) return bootstrapInMemory();

  try {
    if ((await db.count('threads')) === 0) {
      await migrateFromLocalStorage(db);
    }

    const rows = await db.getAll('threads');

    if (rows.length === 0) {
      const initial = createInitialThread();
      await upsertThread(initial);
      await Promise.all(initial.messages.map((m) => upsertMessage(initial.id, m)));
      await setActiveThreadId(initial.id);
      return { threads: [initial], activeThreadId: initial.id };
    }

    // Newest first, matching the prepend order threads were created in.
    rows.sort((a, b) => b.createdAt - a.createdAt);

    const threads = await Promise.all(rows.map((row) => assembleThread(db, row)));
    const storedActiveId = await db.get('meta', ACTIVE_THREAD_META_KEY);
    const activeThreadId =
      storedActiveId && threads.some((t) => t.id === storedActiveId)
        ? storedActiveId
        : threads[0].id;

    return { threads, activeThreadId };
  } catch (err) {
    console.error('Failed to load threads from IndexedDB:', err);
    return bootstrapInMemory();
  }
}

// --- Migration ---------------------------------------------------------------

/**
 * One-time move of the old single-blob localStorage formats (v2, then v1) into
 * the normalized stores. The legacy keys are only removed once the transaction
 * has committed, so a failure part-way through leaves the blob intact for a retry.
 */
async function migrateFromLocalStorage(db: IDBPDatabase<CadaiDB>): Promise<void> {
  if (typeof localStorage === 'undefined') return;

  try {
    const source = LEGACY_KEYS.map((keys) => ({
      keys,
      raw: localStorage.getItem(keys.threads),
    })).find((candidate) => candidate.raw);

    if (!source || !source.raw) return;

    const legacyThreads: ChatThread[] = JSON.parse(source.raw);
    if (!Array.isArray(legacyThreads) || legacyThreads.length === 0) return;

    const tx = db.transaction(['threads', 'messages', 'generatedCode', 'meta'], 'readwrite');

    for (const thread of legacyThreads) {
      await tx.objectStore('threads').put(toThreadRow(thread));

      for (const message of thread.messages || []) {
        await tx.objectStore('messages').put(toMessageRow(thread.id, message));

        if (message.code !== undefined) {
          await tx.objectStore('generatedCode').put({
            rowId: rowId(thread.id, message.id),
            threadId: thread.id,
            messageId: message.id,
            code: message.code,
          });
        }
      }
    }

    const legacyActiveId = localStorage.getItem(source.keys.activeThread);
    if (legacyActiveId) {
      await tx.objectStore('meta').put(legacyActiveId, ACTIVE_THREAD_META_KEY);
    }

    await tx.done;

    for (const keys of LEGACY_KEYS) {
      localStorage.removeItem(keys.threads);
      localStorage.removeItem(keys.activeThread);
    }
  } catch (err) {
    console.error('Failed to migrate threads from localStorage:', err);
  }
}

// --- Writes ------------------------------------------------------------------

export async function upsertThread(thread: ChatThread): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    await db.put('threads', toThreadRow(thread));
  } catch (err) {
    console.error('Failed to persist thread:', err);
  }
}

export async function upsertMessage(threadId: string, message: ChatMessage): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    const id = rowId(threadId, message.id);
    const tx = db.transaction(['messages', 'generatedCode'], 'readwrite');

    await tx.objectStore('messages').put(toMessageRow(threadId, message));

    if (message.code !== undefined) {
      await tx.objectStore('generatedCode').put({
        rowId: id,
        threadId,
        messageId: message.id,
        code: message.code,
      });
    } else {
      // Keeps the stores consistent if a message's code was cleared.
      await tx.objectStore('generatedCode').delete(id);
    }

    await tx.done;
  } catch (err) {
    console.error('Failed to persist message:', err);
  }
}

async function deleteThreadRows(tx: CascadeTx, threadId: string): Promise<void> {
  const messages = tx.objectStore('messages');
  const messageKeys = await messages.index('threadId').getAllKeys(threadId);
  await Promise.all(messageKeys.map((key) => messages.delete(key)));

  const generatedCode = tx.objectStore('generatedCode');
  const codeKeys = await generatedCode.index('threadId').getAllKeys(threadId);
  await Promise.all(codeKeys.map((key) => generatedCode.delete(key)));
}

export async function deleteThreadCascade(threadId: string): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    const tx = db.transaction(['threads', 'messages', 'generatedCode'], 'readwrite');
    await tx.objectStore('threads').delete(threadId);
    await deleteThreadRows(tx, threadId);
    await tx.done;
  } catch (err) {
    console.error('Failed to delete thread:', err);
  }
}

/** Drops a thread's messages and their code snapshots, keeping the thread row. */
export async function clearThreadMessages(threadId: string): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    const tx = db.transaction(['threads', 'messages', 'generatedCode'], 'readwrite');
    await deleteThreadRows(tx, threadId);
    await tx.done;
  } catch (err) {
    console.error('Failed to clear thread messages:', err);
  }
}

export async function setActiveThreadId(threadId: string): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    await db.put('meta', threadId, ACTIVE_THREAD_META_KEY);
  } catch (err) {
    console.error('Failed to persist active thread id:', err);
  }
}

// --- Debounced code writes ---------------------------------------------------

const CODE_WRITE_DEBOUNCE_MS = 400;
const pendingCodeWrites = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Editor keystrokes call this on every change, so the write is debounced per
 * thread. Zustand state still updates synchronously — only the disk write waits.
 */
export function setCodeDebounced(
  threadId: string,
  code: string,
  updatedAt: number,
  delayMs = CODE_WRITE_DEBOUNCE_MS
): void {
  const pending = pendingCodeWrites.get(threadId);
  if (pending) clearTimeout(pending);

  const timer = setTimeout(() => {
    pendingCodeWrites.delete(threadId);
    void persistThreadCode(threadId, code, updatedAt);
  }, delayMs);

  pendingCodeWrites.set(threadId, timer);
}

async function persistThreadCode(
  threadId: string,
  code: string,
  updatedAt: number
): Promise<void> {
  const db = await getDB();
  if (!db) return;

  try {
    // Read-modify-write so a compile result landing mid-debounce isn't clobbered.
    const existing = await db.get('threads', threadId);
    if (!existing) return;

    await db.put('threads', { ...existing, code, updatedAt });
  } catch (err) {
    console.error('Failed to persist thread code:', err);
  }
}
