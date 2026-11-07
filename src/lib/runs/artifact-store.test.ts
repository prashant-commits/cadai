import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalArtifactStore, getArtifactStore, isArtifactId } from './artifact-store';
import { LocalRunStore } from './run-store';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-art-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.CADAI_RUN_DIR;
  delete process.env.CADAI_ARTIFACT_STORE;
  delete process.env.CADAI_RUN_TTL_MS;
});

const read = async (s: LocalArtifactStore, id: string) => {
  const got = await s.get(id);
  if (!got) return undefined;
  const chunks: Buffer[] = [];
  for await (const c of got.stream) chunks.push(c as Buffer);
  return { ref: got.ref, data: Buffer.concat(chunks) };
};

describe('LocalArtifactStore', () => {
  it('puts and gets content, with a content-addressed ref', async () => {
    const s = new LocalArtifactStore(tmp());
    const ref = await s.put('r1', 'stl', 'solid x\nendsolid x\n');
    expect(ref.id).toMatch(/^[0-9a-f]{32}$/);
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.sha256.startsWith(ref.id)).toBe(true);
    expect(ref).toMatchObject({ kind: 'stl', bytes: 19, url: `/api/artifacts/${ref.id}` });
    const got = await read(s, ref.id);
    expect(got?.data.toString()).toBe('solid x\nendsolid x\n');
    expect(got?.ref).toEqual(ref);
  });

  it('stores binary bytes exactly', async () => {
    const s = new LocalArtifactStore(tmp());
    const bytes = Uint8Array.from([0, 255, 10, 13, 128]);
    const ref = await s.put('r1', 'png', bytes);
    expect((await read(s, ref.id))?.data.equals(Buffer.from(bytes))).toBe(true);
  });

  it('stores identical content once, across runs', async () => {
    const dir = tmp();
    const s = new LocalArtifactStore(dir);
    const a = await s.put('r1', 'svg', '<svg/>');
    const b = await s.put('r2', 'svg', '<svg/>');
    expect(b).toEqual(a);
    expect(fs.readdirSync(path.join(s.dir, 'blobs'))).toEqual([a.id]);
    expect(fs.readdirSync(path.join(s.dir, 'blobs', a.id))).toHaveLength(1);
  });

  it('concurrent identical puts leave one intact file and no temp files', async () => {
    const s = new LocalArtifactStore(tmp());
    const big = 'x'.repeat(2_000_000);
    const refs = await Promise.all(Array.from({ length: 8 }, (_, i) => s.put(`r${i}`, 'stl', big)));
    expect(new Set(refs.map((r) => r.id)).size).toBe(1);
    const names = fs.readdirSync(path.join(s.dir, 'blobs', refs[0].id));
    expect(names).toEqual([`${refs[0].sha256}.stl`]);
    expect((await read(s, refs[0].id))?.data.length).toBe(2_000_000);
  });

  it('a reader never sees a partial file (writes go through tmp + rename)', async () => {
    const s = new LocalArtifactStore(tmp());
    const big = 'y'.repeat(4_000_000);
    const put = s.put('r', 'stl', big);
    // While the put is in flight, anything get() returns is complete.
    for (let i = 0; i < 20; i++) {
      const id = fs.readdirSync(path.join(s.dir, 'blobs'))[0];
      const got = id ? await read(s, id) : undefined;
      if (got) expect(got.data.length).toBe(4_000_000);
      await new Promise((r) => setTimeout(r, 1));
    }
    await put;
  });

  it('validates ids, run ids and kinds', async () => {
    const s = new LocalArtifactStore(tmp());
    for (const bad of ['', 'abc', '../etc/passwd', 'G'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32)]) {
      expect(isArtifactId(bad)).toBe(false);
      expect(await s.get(bad)).toBeUndefined();
    }
    expect(isArtifactId('a'.repeat(32))).toBe(true);
    expect(await s.get('a'.repeat(32))).toBeUndefined();
    await expect(s.put('../x', 'stl', 'a')).rejects.toThrow(/Invalid runId/);
    await expect(s.put('blobs', 'stl', 'a')).resolves.toBeDefined(); // not a store-reserved run id: layout keeps kinds in separate dirs
    // @ts-expect-error bad kind
    await expect(s.put('r', 'exe', 'a')).rejects.toThrow(/Invalid artifact kind/);
  });

  it('deleteForRun removes only artifacts no other run holds', async () => {
    const s = new LocalArtifactStore(tmp());
    const shared = await s.put('r1', 'stl', 'shared');
    const only1 = await s.put('r1', 'svg', 'only-1');
    const only2 = await s.put('r2', 'svg', 'only-2');
    await s.put('r2', 'stl', 'shared');
    await s.deleteForRun('r1');
    expect(await s.get(only1.id)).toBeUndefined();
    expect((await read(s, shared.id))?.data.toString()).toBe('shared');
    expect(await read(s, only2.id)).toBeDefined();
    await s.deleteForRun('r2');
    expect(await s.get(shared.id)).toBeUndefined();
    expect(fs.readdirSync(path.join(s.dir, 'blobs'))).toEqual([]);
    await s.deleteForRun('never-existed'); // no-op
  });

  it('a put racing a delete of the same content keeps the bytes', async () => {
    const s = new LocalArtifactStore(tmp());
    const ref = await s.put('r1', 'stl', 'content');
    for (let i = 0; i < 20; i++) {
      await Promise.all([s.deleteForRun('r1'), s.put('r2', 'stl', 'content')]);
      const got = await read(s, ref.id);
      expect(got?.data.toString()).toBe('content');
      await s.put('r1', 'stl', 'content'); // r1 holds again for the next round
      await s.deleteForRun('r2');
    }
  });

  it('prune: drops holds of vanished runs, expires compile-* by TTL, keeps live runs', async () => {
    process.env.CADAI_RUN_TTL_MS = '1000';
    const s = new LocalArtifactStore(tmp());
    const live = await s.put('live', 'stl', 'live-bytes');
    const gone = await s.put('gone', 'stl', 'gone-bytes');
    const fresh = await s.put('compile-fresh', 'stl', 'fresh-bytes');
    const old = await s.put('compile-old', 'stl', 'old-bytes');
    const past = new Date(Date.now() - 120_000);
    for (const run of ['gone', 'compile-old']) {
      for (const f of fs.readdirSync(path.join(s.dir, 'runs', run))) fs.utimesSync(path.join(s.dir, 'runs', run, f), past, past);
    }
    const dropped = await s.prune(async (id) => id === 'live');
    expect(dropped.sort()).toEqual(['compile-old', 'gone']);
    expect(await s.get(gone.id)).toBeUndefined();
    expect(await s.get(old.id)).toBeUndefined();
    expect(await s.get(live.id)).toBeDefined();
    expect(await s.get(fresh.id)).toBeDefined();
  });

  it('a run deleted by the run store TTL takes its artifacts with it', async () => {
    process.env.CADAI_RUN_TTL_MS = '1000';
    const dir = tmp();
    const runs = new LocalRunStore(dir);
    await import('./artifact-store'); // registers the removal hook
    const s = new LocalArtifactStore(path.join(runs.dir, 'artifacts'));
    await runs.create({ runId: 'old', threadId: 't' });
    await runs.setStatus('old', 'done');
    const ref = await s.put('old', 'stl', 'bytes');
    expect(await runs.prune(Date.now() + 5_000)).toEqual(['old']);
    await new Promise((r) => setTimeout(r, 100));
    expect(await s.get(ref.id)).toBeUndefined();
  });

  it('getArtifactStore follows CADAI_RUN_DIR and rejects an unknown backend', async () => {
    process.env.CADAI_RUN_DIR = tmp();
    const s = getArtifactStore() as LocalArtifactStore;
    expect(s.dir).toBe(path.join(process.env.CADAI_RUN_DIR, 'artifacts'));
    process.env.CADAI_ARTIFACT_STORE = 's3';
    expect(() => getArtifactStore()).toThrow(/CADAI_ARTIFACT_STORE/);
    process.env.CADAI_ARTIFACT_STORE = 'local';
    expect(() => getArtifactStore()).not.toThrow();
  });

  it('M2: get refreshes a compile hold (expiry by last use); empty compile dirs are pruned', async () => {
    process.env.CADAI_RUN_TTL_MS = '1000';
    const s = new LocalArtifactStore(tmp());
    const ref = await s.put('compile-a', 'stl', 'bytes');
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(s.dir, 'runs', 'compile-a', ref.id), past, past);
    await (await s.get(ref.id))!.stream.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(await s.prune(async () => false)).toEqual([]); // used just now: kept
    expect(await s.get(ref.id)).toBeDefined();
    fs.mkdirSync(path.join(s.dir, 'runs', 'compile-empty'));
    expect(await s.prune(async () => false)).toEqual(['compile-empty']);
  });

  it('M2: evictCompile drops least-recently-used compile runs to fit the byte cap', async () => {
    const s = new LocalArtifactStore(tmp());
    const a = await s.put('compile-a', 'stl', 'a'.repeat(1000));
    const b = await s.put('compile-b', 'stl', 'b'.repeat(1000));
    const c = await s.put('compile-c', 'stl', 'c'.repeat(1000));
    const keep = await s.put('run-1', 'stl', 'd'.repeat(5000)); // non-compile runs are never evicted
    const at = (run: string, id: string, ms: number) => fs.utimesSync(path.join(s.dir, 'runs', run, id), new Date(ms), new Date(ms));
    at('compile-a', a.id, 3000); // a is the most recently used
    at('compile-b', b.id, 1000);
    at('compile-c', c.id, 2000);
    await s.evictCompile!(2000);
    expect(await s.get(b.id)).toBeUndefined();
    expect(await s.get(c.id)).toBeDefined();
    expect(await s.get(a.id)).toBeDefined();
    await s.evictCompile!(0);
    expect(await s.get(a.id)).toBeUndefined();
    expect(await s.get(keep.id)).toBeDefined();
  });

  it('L1: the same bytes under a different kind are refused, not served under the wrong type', async () => {
    const s = new LocalArtifactStore(tmp());
    await s.put('r1', 'svg', 'same');
    await expect(s.put('r2', 'png', 'same')).rejects.toThrow(/already exists as svg/);
    await expect(s.put('r3', 'svg', 'same')).resolves.toBeDefined();
  });
});
