import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';
import type { ArtifactRef } from '@/lib/contract/run-contract';
import { artifactStoreDir, artifactStoreKind } from './config';
import { getRunStore, isSafeRunId, onRunRemoved, runTtlMs } from './run-store';

export type ArtifactKind = ArtifactRef['kind'];
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['stl', 'step', 'svg', 'png', 'scad', 'py'];

/**
 * Large payloads by reference. Content-addressed: the id is the first 32 hex
 * characters of the content's sha256, so identical content is stored once, and
 * an artifact lives while ANY run that put it still lives.
 *
 * Deliberately small so a bucket / database store can follow: put, get,
 * deleteForRun.
 */
export interface ArtifactStore {
  /** Stores the bytes (a string is UTF-8) and records `runId` as a holder. Throws on a bad runId or kind. */
  put(runId: string, kind: ArtifactKind, bytes: Uint8Array | string): Promise<ArtifactRef>;
  /** The artifact, or undefined when the id is unknown or not a valid id. */
  get(id: string): Promise<{ ref: ArtifactRef; stream: Readable } | undefined>;
  /** Drops the run's hold; content nobody else holds is deleted. */
  deleteForRun(runId: string): Promise<void>;
  /** Evicts least-recently-used `compile-*` runs until their artifacts total at most `maxBytes`. */
  evictCompile?(maxBytes: number): Promise<void>;
}

const ID = /^[0-9a-f]{32}$/;
export const isArtifactId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);
const FILE = new RegExp(`^([0-9a-f]{64})\\.(${ARTIFACT_KINDS.join('|')})$`);

const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const rand = () => Math.random().toString(36).slice(2);
const urlFor = (id: string) => `/api/artifacts/${id}`;

let warnedFallback = false;

/** `preferred` if it can be created and written, else os.tmpdir()/cadai-runs/artifacts (warns once). */
function writableRoot(preferred: string): string {
  const prepare = (root: string) => {
    for (const sub of ['blobs', 'holders', 'runs', 'trash']) fs.mkdirSync(path.join(/*turbopackIgnore: true*/ root, sub), { recursive: true });
    fs.accessSync(root, fs.constants.W_OK);
    return root;
  };
  try {
    return prepare(preferred);
  } catch (e) {
    const fallback = path.join(os.tmpdir(), 'cadai-runs', 'artifacts');
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(`Artifact store directory ${preferred} is not writable (${errCode(e) ?? e}); using ${fallback}.`);
    }
    return prepare(fallback);
  }
}

/**
 * Layout under `dir`:
 *   blobs/<id>/<sha256>.<kind>   the bytes (one file per id; atomic tmp+rename)
 *   holders/<id>/<runId>         marker: this run holds the artifact
 *   runs/<runId>/<id>            the same marker, indexed by run
 *   trash/                       blob directories being deleted
 *
 * Delete vs put race: a delete moves the blob aside, then re-checks the
 * holders and moves it back if a put marked it meanwhile. A put marks first and
 * verifies the blob exists afterwards (re-writing it if a delete took it), so
 * one of the two always sees the other.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly dir: string;
  private lastPrune = 0;

  constructor(dir: string) {
    this.dir = writableRoot(dir);
  }

  private p(...parts: string[]): string {
    return path.join(/*turbopackIgnore: true*/ this.dir, ...parts);
  }

  private checkRun(runId: string): void {
    if (!isSafeRunId(runId)) throw new Error(`Invalid runId "${runId}".`);
  }

  /** The stored file name inside blobs/<id>, if any. */
  private async blobFile(id: string): Promise<string | undefined> {
    const names = await fs.promises.readdir(this.p('blobs', id)).catch(() => [] as string[]);
    return names.find((n) => FILE.test(n));
  }

  async put(runId: string, kind: ArtifactKind, bytes: Uint8Array | string): Promise<ArtifactRef> {
    this.checkRun(runId);
    if (!ARTIFACT_KINDS.includes(kind)) throw new Error(`Invalid artifact kind "${kind}".`);
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf-8') : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const id = sha256.slice(0, 32);
    const name = `${sha256}.${kind}`;

    // Content addressing has no room for two kinds of the same bytes: serving it under the wrong type would be unsafe.
    const existing = await this.blobFile(id);
    if (existing && FILE.exec(existing)![2] !== kind) throw new Error(`Artifact ${id} already exists as ${FILE.exec(existing)![2]}, not ${kind}.`);

    // Mark first (so a concurrent delete sees us), then make sure the bytes exist.
    await fs.promises.mkdir(this.p('holders', id), { recursive: true });
    await fs.promises.mkdir(this.p('runs', runId), { recursive: true });
    await fs.promises.writeFile(this.p('holders', id, runId), '');
    await fs.promises.writeFile(this.p('runs', runId, id), '');

    for (let attempt = 0; attempt < 3; attempt++) {
      await fs.promises.mkdir(this.p('blobs', id), { recursive: true });
      const file = this.p('blobs', id, name);
      if (!fs.existsSync(file)) {
        const tmp = this.p('blobs', id, `${name}.${process.pid}.${rand()}.tmp`);
        try {
          await fs.promises.writeFile(tmp, buf);
          await fs.promises.rename(tmp, file);
        } catch (e) {
          await fs.promises.unlink(tmp).catch(() => undefined);
          if (errCode(e) !== 'ENOENT') throw e; // ENOENT: a delete moved the directory; retry
          continue;
        }
      } else {
        const now = new Date();
        await fs.promises.utimes(this.p('runs', runId, id), now, now).catch(() => undefined); // keeps the hold fresh for the TTL
      }
      if (fs.existsSync(file)) return { id, kind, bytes: buf.length, sha256, url: urlFor(id) };
    }
    throw new Error(`Could not store artifact ${id}.`);
  }

  async get(id: string): Promise<{ ref: ArtifactRef; stream: Readable } | undefined> {
    if (!isArtifactId(id)) return undefined;
    const name = await this.blobFile(id);
    if (!name) return undefined;
    const m = FILE.exec(name)!;
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(this.p('blobs', id, name), 'r');
    } catch {
      return undefined; // deleted meanwhile
    }
    const { size } = await fh.stat();
    void this.touchCompileHolds(id); // last use, not put time, drives compile expiry
    return {
      ref: { id, kind: m[2] as ArtifactKind, bytes: size, sha256: m[1], url: urlFor(id) },
      stream: fh.createReadStream({ autoClose: true }),
    };
  }

  private async touchCompileHolds(id: string): Promise<void> {
    const now = new Date();
    for (const runId of await this.holders(id)) {
      if (runId.startsWith('compile-')) await fs.promises.utimes(this.p('runs', runId, id), now, now).catch(() => undefined);
    }
  }

  /** Total stored bytes and newest hold of one run. */
  private async runUsage(runId: string): Promise<{ bytes: number; newest: number }> {
    let bytes = 0;
    let newest = 0;
    for (const id of await fs.promises.readdir(this.p('runs', runId)).catch(() => [] as string[])) {
      const st = await fs.promises.stat(this.p('runs', runId, id)).catch(() => undefined);
      if (st) newest = Math.max(newest, st.mtimeMs);
      const name = await this.blobFile(id);
      const blob = name ? await fs.promises.stat(this.p('blobs', id, name)).catch(() => undefined) : undefined;
      if (blob) bytes += blob.size;
    }
    return { bytes, newest };
  }

  async evictCompile(maxBytes: number): Promise<void> {
    const runs: Array<{ runId: string; bytes: number; newest: number }> = [];
    for (const runId of await fs.promises.readdir(this.p('runs')).catch(() => [] as string[])) {
      if (runId.startsWith('compile-') && isSafeRunId(runId)) runs.push({ runId, ...(await this.runUsage(runId)) });
    }
    let total = runs.reduce((n, r) => n + r.bytes, 0);
    runs.sort((a, b) => a.newest - b.newest); // least recently used first
    for (const r of runs) {
      if (total <= maxBytes) break;
      await this.deleteForRun(r.runId);
      total -= r.bytes;
    }
  }

  async deleteForRun(runId: string): Promise<void> {
    this.checkRun(runId);
    const ids = (await fs.promises.readdir(this.p('runs', runId)).catch(() => [] as string[])).filter(isArtifactId);
    for (const id of ids) {
      await fs.promises.unlink(this.p('holders', id, runId)).catch(() => undefined);
      await this.dropIfUnheld(id);
    }
    await fs.promises.rm(this.p('runs', runId), { recursive: true, force: true });
  }

  private async holders(id: string): Promise<string[]> {
    return fs.promises.readdir(this.p('holders', id)).catch(() => [] as string[]);
  }

  /** Deletes the blob when no run holds it (see the class comment for the race). */
  private async dropIfUnheld(id: string): Promise<void> {
    if ((await this.holders(id)).length > 0) return;
    const aside = this.p('trash', `${id}.${process.pid}.${rand()}`);
    try {
      await fs.promises.rename(this.p('blobs', id), aside);
    } catch {
      await fs.promises.rm(this.p('holders', id), { recursive: true, force: true }).catch(() => undefined);
      return; // no blob (or already moving)
    }
    if ((await this.holders(id)).length > 0) {
      // A put marked it while we were deleting: give it back (or drop ours if it already re-wrote it).
      await fs.promises.rename(aside, this.p('blobs', id)).catch(() => fs.promises.rm(aside, { recursive: true, force: true }));
      return;
    }
    await fs.promises.rm(aside, { recursive: true, force: true });
    await fs.promises.rmdir(this.p('holders', id)).catch(() => undefined);
  }

  /** Lazily, at most once a minute. */
  maybePrune(runExists: (runId: string) => Promise<boolean>, now = Date.now()): void {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    void this.prune(runExists, now).catch((e) => console.warn('Artifact prune failed:', e));
  }

  /**
   * Drops holds of runs that no longer exist (their record was deleted), and
   * of synthetic `compile-*` runs not touched for CADAI_RUN_TTL_MS. Also clears
   * leftover trash and tmp files from a crash. Returns the run ids dropped.
   */
  async prune(runExists: (runId: string) => Promise<boolean>, now = Date.now()): Promise<string[]> {
    const ttl = runTtlMs();
    const dropped: string[] = [];
    for (const runId of await fs.promises.readdir(this.p('runs')).catch(() => [] as string[])) {
      if (!isSafeRunId(runId)) continue;
      let drop: boolean;
      if (runId.startsWith('compile-')) {
        const newest = await this.newestHold(runId);
        drop = newest === undefined || now - newest > ttl; // an empty dir has nothing to keep
      } else {
        const newest = await this.newestHold(runId);
        // A run record is created before its first artifact, so a missing one means it was pruned.
        // The age check spares a hold written in the instant before the record is visible elsewhere.
        drop = !(await runExists(runId)) && (newest === undefined || now - newest > 60_000);
      }
      if (drop) {
        await this.deleteForRun(runId);
        dropped.push(runId);
      }
    }
    const stale = async (dir: string, pick: (n: string) => boolean) => {
      for (const n of await fs.promises.readdir(dir).catch(() => [] as string[])) {
        if (!pick(n)) continue;
        const st = await fs.promises.stat(path.join(/*turbopackIgnore: true*/ dir, n)).catch(() => undefined);
        if (st && now - st.mtimeMs > 60_000) await fs.promises.rm(path.join(/*turbopackIgnore: true*/ dir, n), { recursive: true, force: true });
      }
    };
    await stale(this.p('trash'), () => true);
    for (const id of await fs.promises.readdir(this.p('blobs')).catch(() => [] as string[])) {
      await stale(this.p('blobs', id), (n) => n.endsWith('.tmp'));
      // An unheld blob (a put that crashed before marking, or a failed delete).
      if (isArtifactId(id) && (await this.holders(id)).length === 0) {
        const st = await fs.promises.stat(this.p('blobs', id)).catch(() => undefined);
        if (st && now - st.mtimeMs > 60_000) await this.dropIfUnheld(id);
      }
    }
    return dropped;
  }

  private async newestHold(runId: string): Promise<number | undefined> {
    let newest: number | undefined;
    for (const id of await fs.promises.readdir(this.p('runs', runId)).catch(() => [] as string[])) {
      const st = await fs.promises.stat(this.p('runs', runId, id)).catch(() => undefined);
      if (st && (newest === undefined || st.mtimeMs > newest)) newest = st.mtimeMs;
    }
    return newest;
  }
}

const stores = new Map<string, LocalArtifactStore>();

/** The store under a run store directory (cached per directory). */
export function artifactStoreFor(runDir: string): LocalArtifactStore {
  const dir = path.join(/*turbopackIgnore: true*/ runDir, 'artifacts');
  let s = stores.get(dir);
  if (!s) stores.set(dir, (s = new LocalArtifactStore(dir)));
  return s;
}

/** The process-wide store, chosen by CADAI_ARTIFACT_STORE; follows the run store's directory. */
export function getArtifactStore(): ArtifactStore {
  artifactStoreKind(); // validates CADAI_ARTIFACT_STORE
  const run = getRunStore();
  // the run store's resolved (possibly fallback) directory
  const store = artifactStoreFor((run as { dir?: string }).dir ?? path.dirname(artifactStoreDir()));
  store.maybePrune((id) => run.get(id).then((r) => r !== undefined));
  return store;
}

// A run deleted by the run store's TTL prune takes its holds with it.
onRunRemoved((runId, dir) => {
  void artifactStoreFor(dir).deleteForRun(runId).catch((e) => console.warn('Artifact cleanup failed:', e));
});

/** deleteForRun that never throws (a bad CADAI_ARTIFACT_STORE included): cleanup must not break a cancel. */
export async function safeDeleteForRun(runId: string): Promise<void> {
  try {
    await getArtifactStore().deleteForRun(runId);
  } catch (e) {
    console.warn('Artifact cleanup failed:', e);
  }
}
