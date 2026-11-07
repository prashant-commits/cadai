import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LocalRunStore, getRunStore } from './run-store';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-runs-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.CADAI_RUN_DIR;
  delete process.env.CADAI_RUN_STORE;
});

describe('LocalRunStore', () => {
  it('creates a running run and reads it back', async () => {
    const s = new LocalRunStore(tmp());
    const made = await s.create({ runId: 'r1', threadId: 't1' });
    expect(made).toMatchObject({ runId: 'r1', threadId: 't1', status: 'running', lastSeq: 0 });
    expect(await s.get('r1')).toEqual(made);
    expect(await s.get('nope')).toBeUndefined();
    await expect(s.create({ runId: 'r1', threadId: 't1' })).rejects.toThrow(/already exists/);
  });

  it('rejects unsafe run ids (no path traversal)', async () => {
    const s = new LocalRunStore(tmp());
    await expect(s.create({ runId: '../x', threadId: 't' })).rejects.toThrow();
    expect(await s.get('../x')).toBeUndefined();
    expect(await s.events('../x', 0)).toEqual([]);
    expect(await s.isCancelled('../x')).toBe(false);
  });

  it('assigns gap-free seqs under concurrent appends and tracks lastSeq', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't' });
    const seqs = await Promise.all(Array.from({ length: 200 }, (_, i) => s.append('r', { t: 'delta', text: String(i) })));
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    const all = await s.events('r', 0);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    // order of storage matches the order of the append calls
    expect(all.map((e) => e.text)).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
    expect((await s.get('r'))?.lastSeq).toBe(200);
  });

  it('events(afterSeq) returns only later events; ts is stamped, or kept when given', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't' });
    await s.append('r', { t: 'a' });
    await s.append('r', { t: 'b', ts: 42 });
    await s.append('r', { t: 'c' });
    const later = await s.events('r', 1);
    expect(later.map((e) => e.t)).toEqual(['b', 'c']);
    expect(later[0].ts).toBe(42);
    expect(typeof later[1].ts).toBe('number');
    expect(await s.events('r', 3)).toEqual([]);
  });

  it('append to an unknown run rejects', async () => {
    const s = new LocalRunStore(tmp());
    await expect(s.append('ghost', { t: 'x' })).rejects.toThrow(/Unknown run/);
  });

  it('setStatus: paused sets expiresAt, other statuses clear it, errors are kept', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't' });
    await s.setStatus('r', 'paused');
    const paused = await s.get('r');
    expect(paused?.status).toBe('paused');
    expect(paused?.expiresAt).toBeGreaterThan(Date.now());
    await s.setStatus('r', 'running');
    expect((await s.get('r'))?.expiresAt).toBeUndefined();
    await s.setStatus('r', 'failed', { code: 'internal', message: 'boom' });
    expect(await s.get('r')).toMatchObject({ status: 'failed', error: { code: 'internal', message: 'boom' } });
    await s.setStatus('r', 'done');
    expect((await s.get('r'))?.error).toBeUndefined();
  });

  it('cancel flag: requestCancel / isCancelled', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't' });
    expect(await s.isCancelled('r')).toBe(false);
    expect(await s.requestCancel('r')).toBe(true);
    expect(await s.isCancelled('r')).toBe(true);
    // a terminal status clears the flag, and a finished run cannot be flagged again
    await s.setStatus('r', 'done');
    expect(await s.isCancelled('r')).toBe(false);
    expect(await s.requestCancel('r')).toBe(false);
    expect(await s.isCancelled('r')).toBe(false);
  });

  it('a second store on the same directory (another instance) sees runs, events and cancel flags', async () => {
    const dir = tmp();
    const a = new LocalRunStore(dir);
    const b = new LocalRunStore(dir);
    await a.create({ runId: 'r', threadId: 't' });
    await a.append('r', { t: 'run' });
    expect((await b.get('r'))?.lastSeq).toBe(1);
    expect((await b.events('r', 0)).map((e) => e.t)).toEqual(['run']);
    expect(await b.requestCancel('r')).toBe(true);
    expect(await a.isCancelled('r')).toBe(true);
  });

  it('ignores a torn trailing line', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    await s.append('r', { t: 'a' });
    fs.appendFileSync(path.join(dir, 'events', 'r.jsonl'), '{"seq":2,"t":"b"');
    expect((await s.events('r', 0)).map((e) => e.t)).toEqual(['a']);
  });
});

describe('getRunStore', () => {
  it('is selected by CADAI_RUN_STORE (local default) and honours CADAI_RUN_DIR', async () => {
    const dir = tmp();
    process.env.CADAI_RUN_DIR = dir;
    const s = getRunStore();
    await s.create({ runId: 'sel', threadId: 't' });
    expect(fs.existsSync(path.join(dir, 'runs', 'sel.json'))).toBe(true);
    process.env.CADAI_RUN_STORE = 'local';
    expect(getRunStore()).toBe(s);
  });

  it('refuses an unimplemented store instead of silently using disk', () => {
    process.env.CADAI_RUN_STORE = 'postgres';
    expect(() => getRunStore()).toThrow(/Unsupported CADAI_RUN_STORE/);
  });
});

describe('review fixes', () => {
  it('F1: reserved names are not run ids, and files of each kind live in their own subdirectory', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    for (const id of ['checkpoints', 'runs', 'events', 'locks', 'cancel', 'CHECKPOINTS']) {
      await expect(s.create({ runId: id, threadId: 't' })).rejects.toThrow(/Invalid runId/);
      expect(await s.get(id)).toBeUndefined();
    }
    await s.create({ runId: 'r', threadId: 't' });
    await s.append('r', { t: 'x' });
    expect(fs.readdirSync(path.join(dir, 'runs'))).toEqual(['r.json']);
    expect(fs.readdirSync(path.join(dir, 'events'))).toEqual(['r.jsonl']);
    expect(fs.readdirSync(dir).sort()).toEqual(['cancel', 'events', 'locks', 'runs']);
  });

  it('F2/F8: two instances appending alternately produce 1..N with no duplicates, and both see the true lastSeq', async () => {
    const dir = tmp();
    const a = new LocalRunStore(dir);
    const b = new LocalRunStore(dir);
    await a.create({ runId: 'r', threadId: 't' });
    const seqs: number[] = [];
    // The review's repro: start on A, resume on B, come back to A.
    for (const [store, n] of [[a, 3], [b, 2], [a, 1], [b, 1], [a, 2]] as const) {
      for (let i = 0; i < n; i++) seqs.push(await store.append('r', { t: 'e' }));
      expect((await a.get('r'))?.lastSeq).toBe(seqs.length);
      expect((await b.get('r'))?.lastSeq).toBe(seqs.length);
    }
    expect(seqs).toEqual(Array.from({ length: 9 }, (_, i) => i + 1));
    expect((await a.events('r', 0)).map((e) => e.seq)).toEqual(seqs);
  });

  it('F2: concurrent appends from two instances (two lock holders) are still gap-free', async () => {
    const dir = tmp();
    const a = new LocalRunStore(dir);
    const b = new LocalRunStore(dir);
    await a.create({ runId: 'r', threadId: 't' });
    const all = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).append('r', { t: 'e', i })));
    expect([...all].sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect((await a.events('r', 0)).map((e) => e.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it('F8: a torn trailing line is ignored by readers and cut off by the next append (no glued records)', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    await s.append('r', { t: 'a' });
    fs.appendFileSync(path.join(dir, 'events', 'r.jsonl'), '{"seq":2,"ts":1,"t":"to'); // writer crashed here
    expect((await s.get('r'))?.lastSeq).toBe(1);
    expect(await s.append('r', { t: 'b' })).toBe(2);
    expect(await s.append('r', { t: 'c' })).toBe(3);
    expect((await s.events('r', 0)).map((e) => [e.seq, e.t])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
  });

  it('F3/F9: setStatus and append honour `expect` atomically; exactly one of two racing transitions wins', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't', status: 'paused' });
    const claims = await Promise.all([
      s.setStatus('r', 'running', undefined, { expect: ['paused'] }),
      s.setStatus('r', 'running', undefined, { expect: ['paused'] }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const ends = await Promise.all([
      s.append('r', { t: 'cancelled' }, { status: 'cancelled', expect: ['running'] }),
      s.append('r', { t: 'error' }, { status: 'failed', expect: ['running'] }),
    ]);
    expect(ends.filter((n) => n > 0)).toHaveLength(1);
    expect(await s.events('r', 0)).toHaveLength(1);
    expect(['cancelled', 'failed']).toContain((await s.get('r'))?.status);
  });

  it('F5: prune deletes finished runs older than CADAI_RUN_TTL_MS, keeps fresh and running ones, fails expired paused runs', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    for (const id of ['old-done', 'fresh-done', 'live', 'old-paused']) await s.create({ runId: id, threadId: 't' });
    await s.append('old-done', { t: 'x' });
    await s.setStatus('old-done', 'done');
    await s.setStatus('fresh-done', 'done');
    await s.setStatus('old-paused', 'paused');
    process.env.CADAI_RUN_TTL_MS = String(60 * 60 * 1000);
    const later = Date.now() + 2 * 60 * 60 * 1000;
    // the paused run's checkpoint TTL (24 h by default) has not passed; make it.
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'old-paused.json'), 'utf-8'));
    fs.writeFileSync(path.join(dir, 'runs', 'old-paused.json'), JSON.stringify({ ...meta, expiresAt: Date.now() - 1 }));
    const fresh = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'fresh-done.json'), 'utf-8'));
    fs.writeFileSync(path.join(dir, 'runs', 'fresh-done.json'), JSON.stringify({ ...fresh, updatedAt: later }));
    process.env.CADAI_RUN_LOST_MS = String(24 * 60 * 60 * 1000); // keep `live` from being reaped as lost
    const removed = await s.prune(later);
    expect(removed).toEqual(['old-done']);
    expect(fs.existsSync(path.join(dir, 'runs', 'old-done.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'events', 'old-done.jsonl'))).toBe(false);
    expect(await s.get('fresh-done')).toBeDefined();
    expect((await s.get('live'))?.status).toBe('running');
    expect(await s.get('old-paused')).toMatchObject({ status: 'failed', error: { code: 'run_expired' } });
    delete process.env.CADAI_RUN_LOST_MS;
  });

  it('F5: pruning runs lazily at most once a minute', async () => {
    const s = new LocalRunStore(tmp());
    const spy = vi.spyOn(s, 'prune').mockResolvedValue([]);
    const t = Date.now() + 120_000;
    s.maybePrune(t);
    s.maybePrune(t + 1_000);
    s.maybePrune(t + 59_000);
    expect(spy).toHaveBeenCalledTimes(1);
    s.maybePrune(t + 61_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('F6: an unwritable directory falls back to os.tmpdir()/cadai-runs with one warning', async () => {
    const base = tmp();
    const blocker = path.join(base, 'file');
    fs.writeFileSync(blocker, 'not a dir');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = new LocalRunStore(path.join(blocker, 'runs'));
    expect(s.dir).toBe(path.join(os.tmpdir(), 'cadai-runs'));
    const id = `fallback-${Date.now()}`;
    await s.create({ runId: id, threadId: 't' });
    expect(await s.get(id)).toBeDefined();
    new LocalRunStore(path.join(blocker, 'again'));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('not writable'))).toHaveLength(1);
    warn.mockRestore();
    for (const kind of ['runs', 'events']) fs.rmSync(path.join(s.dir, kind, `${id}.json${kind === 'events' ? 'l' : ''}`), { force: true });
  });

  it('F7: a running run with no heartbeat for CADAI_RUN_LOST_MS is failed by the next reader, with a stored error event', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    await s.append('r', { t: 'run' });
    process.env.CADAI_RUN_LOST_MS = '50';
    await new Promise((r) => setTimeout(r, 80));
    const info = await s.get('r');
    expect(info).toMatchObject({ status: 'failed', error: { code: 'internal', message: 'run lost: its server instance stopped' } });
    const last = (await s.events('r', 0)).at(-1);
    expect(last).toMatchObject({ t: 'error', apiError: { message: 'run lost: its server instance stopped' } });
    expect(info?.lastSeq).toBe(2);
    delete process.env.CADAI_RUN_LOST_MS;
  });

  it('F7: heartbeat keeps a running run alive', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't' });
    process.env.CADAI_RUN_LOST_MS = '100';
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await s.heartbeat('r');
    }
    expect((await s.get('r'))?.status).toBe('running');
    delete process.env.CADAI_RUN_LOST_MS;
  });

  it('F12: eventsSince reads only what was appended after the cursor', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    await s.append('r', { t: 'a' });
    const first = await s.eventsSince('r', 0);
    expect(first.events.map((e) => e.t)).toEqual(['a']);
    const size = fs.statSync(path.join(dir, 'events', 'r.jsonl')).size;
    expect(Number(first.cursor)).toBe(size);
    await s.append('r', { t: 'b' });
    const second = await s.eventsSince('r', 0, first.cursor);
    expect(second.events.map((e) => e.t)).toEqual(['b']);
    expect((await s.eventsSince('r', 0, second.cursor)).events).toEqual([]);
  });

  it('F12: a large log is read in bounded pages', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't' });
    const blob = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 6; i++) await s.append('r', { t: 'result', blob });
    const page = await s.eventsSince('r', 0);
    expect(page.more).toBe(true);
    expect(page.events.length).toBeLessThan(6);
    expect((await s.events('r', 0)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('F13: create of an existing id is rejected even when racing', async () => {
    const s = new LocalRunStore(tmp());
    const results = await Promise.allSettled([s.create({ runId: 'r', threadId: 't' }), s.create({ runId: 'r', threadId: 't' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('re-review fixes (store)', () => {
  afterEach(() => {
    delete process.env.CADAI_RUN_LOCK_STALE_MS;
    delete process.env.CADAI_RUN_LOST_MS;
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Lockable = { locked<T>(runId: string, fn: () => Promise<T>): Promise<T> };

  it('N4: a dead writer\'s fresh lock is waited out and broken, not reported as a failure', async () => {
    process.env.CADAI_RUN_LOCK_STALE_MS = '300';
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    fs.writeFileSync(path.join(dir, 'locks', 'r.lock'), 'dead-writer'); // just taken, then the writer crashed
    const t0 = Date.now();
    expect(await s.append('r', { t: 'a' })).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('N4: a writer that stalled past the stale age does not remove the lock of the writer that broke it', async () => {
    process.env.CADAI_RUN_LOCK_STALE_MS = '150';
    const dir = tmp();
    const a = new LocalRunStore(dir) as unknown as Lockable;
    const b = new LocalRunStore(dir) as unknown as Lockable;
    const lock = path.join(dir, 'locks', 'r.lock');
    const aDone = a.locked('r', () => sleep(400)); // stalls past the stale age
    await sleep(20);
    let lockDuringB = '';
    const bDone = b.locked('r', async () => {
      await aDone; // A wakes up and runs its release while B holds the lock
      lockDuringB = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf-8') : '';
    });
    await bDone;
    expect(lockDuringB).not.toBe(''); // B's lock survived A's release
    expect(fs.existsSync(lock)).toBe(false); // and B released it
  });

  it('N7: prune reaps a lost running run nobody reads, and deletes it after the TTL', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'crashed', threadId: 't' });
    process.env.CADAI_RUN_LOST_MS = '50';
    await s.prune(Date.now() + 1_000);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'crashed.json'), 'utf-8'));
    expect(meta).toMatchObject({ status: 'failed', error: { message: 'run lost: its server instance stopped' } });
    process.env.CADAI_RUN_TTL_MS = '100';
    expect(await s.prune(Date.now() + 10_000)).toEqual(['crashed']);
    delete process.env.CADAI_RUN_TTL_MS;
  });

  it('N7: prune sweeps locks and aside/temp files older than the stale age, and keeps fresh locks', async () => {
    process.env.CADAI_RUN_LOCK_STALE_MS = '100';
    const dir = tmp();
    const s = new LocalRunStore(dir);
    const old = Date.now() / 1000 - 60;
    for (const f of ['locks/dead.lock', 'locks/x.lock.1.ab.stale', 'runs/r.json.1.ab.tmp']) {
      fs.writeFileSync(path.join(dir, f), 'x');
      fs.utimesSync(path.join(dir, f), old, old);
    }
    fs.writeFileSync(path.join(dir, 'locks', 'live.lock'), 'held');
    await s.prune();
    expect(fs.readdirSync(path.join(dir, 'locks'))).toEqual(['live.lock']);
    expect(fs.readdirSync(path.join(dir, 'runs'))).toEqual([]);
  });

  it('N9: lost-run detection defaults to a generous 5 min', async () => {
    const { runLostMs } = await import('./run-store');
    expect(runLostMs()).toBe(5 * 60_000);
  });

  it('N9: an owner whose clock runs ahead is still reaped once its heartbeat stops (reader clock only)', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    const file = path.join(dir, 'runs', 'r.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...meta, updatedAt: Date.now() + 60 * 60_000, beat: 3 })); // owner clock +1 h
    process.env.CADAI_RUN_LOST_MS = '100';
    expect((await s.get('r'))?.status).toBe('running'); // first look: records beat 3
    await sleep(150);
    expect((await s.get('r'))?.status).toBe('failed'); // beat unchanged for 150 ms by our clock
  });

  it('N9: a moving heartbeat keeps a run alive even when its owner\'s clock runs behind', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    process.env.CADAI_RUN_LOST_MS = '100';
    expect((await s.get('r'))?.status).toBe('running'); // observed while fresh
    const file = path.join(dir, 'runs', 'r.json');
    for (let i = 1; i <= 3; i++) {
      await sleep(60);
      const meta = JSON.parse(fs.readFileSync(file, 'utf-8'));
      fs.writeFileSync(file, JSON.stringify({ ...meta, beat: i, updatedAt: Date.now() - 60 * 60_000 })); // owner clock -1 h
      expect((await s.get('r'))?.status).toBe('running');
    }
  });

  it('N8: replay with `after` near the end does not parse the earlier events', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't' });
    for (let i = 0; i < 20; i++) await s.append('r', { t: 'delta', text: 'y'.repeat(1000) });
    const parse = vi.spyOn(JSON, 'parse');
    const page = await s.eventsSince('r', 18);
    const parsedLines = parse.mock.calls.filter((c) => String(c[0]).startsWith('{"seq":')).length;
    parse.mockRestore();
    expect(page.events.map((e) => e.seq)).toEqual([19, 20]);
    expect(parsedLines).toBe(2);
  });
});

describe('re-review fixes (store)', () => {
  afterEach(() => {
    delete process.env.CADAI_RUN_LOCK_STALE_MS;
    delete process.env.CADAI_RUN_LOST_MS;
    delete process.env.CADAI_RUN_TTL_MS;
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  type Lockable = { locked<T>(runId: string, fn: () => Promise<T>): Promise<T> };

  it('N4: a dead writer\'s fresh lock is waited out and broken, not reported as a failure', async () => {
    process.env.CADAI_RUN_LOCK_STALE_MS = '300';
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    fs.writeFileSync(path.join(dir, 'locks', 'r.lock'), 'dead-writer'); // just taken, then the writer crashed
    const t0 = Date.now();
    expect(await s.append('r', { t: 'a' })).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('N4: a writer that stalled past the stale age does not remove the lock of the writer that broke it', async () => {
    process.env.CADAI_RUN_LOCK_STALE_MS = '150';
    const dir = tmp();
    const a = new LocalRunStore(dir) as unknown as Lockable;
    const b = new LocalRunStore(dir) as unknown as Lockable;
    const lock = path.join(dir, 'locks', 'r.lock');
    const aDone = a.locked('r', () => sleep(400)); // stalls past the stale age
    await sleep(20);
    let lockDuringB = '';
    const bDone = b.locked('r', async () => {
      await aDone; // A wakes up and runs its release while B holds the lock
      lockDuringB = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf-8') : '';
    });
    await bDone;
    expect(lockDuringB).not.toBe(''); // B's lock survived A's release
    expect(fs.existsSync(lock)).toBe(false); // and B released it
  });

  it('N7: prune reaps a lost running run nobody reads, and deletes it after the TTL', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'crashed', threadId: 't' });
    process.env.CADAI_RUN_LOST_MS = '50';
    await s.prune(Date.now() + 1_000);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'crashed.json'), 'utf-8'));
    expect(meta).toMatchObject({ status: 'failed', error: { message: 'run lost: its server instance stopped' } });
    expect((await s.events('crashed', 0)).at(-1)).toMatchObject({ t: 'error' });
    process.env.CADAI_RUN_TTL_MS = '100';
    expect(await s.prune(Date.now() + 10_000)).toEqual(['crashed']);
  });

  it('N7: prune sweeps locks and aside/temp files older than the stale age, and keeps fresh locks', async () => {
    process.env.CADAI_RUN_LOCK_STALE_MS = '100';
    const dir = tmp();
    const s = new LocalRunStore(dir);
    const old = Date.now() / 1000 - 60;
    for (const f of ['locks/dead.lock', 'locks/x.lock.1.ab.stale', 'runs/r.json.1.ab.tmp']) {
      fs.writeFileSync(path.join(dir, f), 'x');
      fs.utimesSync(path.join(dir, f), old, old);
    }
    fs.writeFileSync(path.join(dir, 'locks', 'live.lock'), 'held');
    await s.prune();
    expect(fs.readdirSync(path.join(dir, 'locks'))).toEqual(['live.lock']);
    expect(fs.readdirSync(path.join(dir, 'runs'))).toEqual([]);
  });

  it('N9: lost-run detection defaults to a generous 5 min', async () => {
    const { runLostMs } = await import('./run-store');
    expect(runLostMs()).toBe(5 * 60_000);
  });

  it('N9: an owner whose clock runs ahead is still reaped once its heartbeat stops (reader clock only)', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    const file = path.join(dir, 'runs', 'r.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...meta, updatedAt: Date.now() + 60 * 60_000, beat: 3 })); // owner clock +1 h
    process.env.CADAI_RUN_LOST_MS = '100';
    expect((await s.get('r'))?.status).toBe('running'); // first look: records beat 3
    await sleep(150);
    expect((await s.get('r'))?.status).toBe('failed'); // beat unchanged for 150 ms by our clock
  });

  it('N9: a moving heartbeat keeps a run alive even when its owner\'s clock runs behind', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    process.env.CADAI_RUN_LOST_MS = '100';
    expect((await s.get('r'))?.status).toBe('running'); // observed while fresh
    const file = path.join(dir, 'runs', 'r.json');
    for (let i = 1; i <= 3; i++) {
      await sleep(60);
      const meta = JSON.parse(fs.readFileSync(file, 'utf-8'));
      fs.writeFileSync(file, JSON.stringify({ ...meta, beat: i, updatedAt: Date.now() - 60 * 60_000 })); // owner clock -1 h
      expect((await s.get('r'))?.status).toBe('running');
    }
  });

  it('N8: replay with `after` near the end does not parse the earlier events', async () => {
    const s = new LocalRunStore(tmp());
    await s.create({ runId: 'r', threadId: 't' });
    for (let i = 0; i < 20; i++) await s.append('r', { t: 'delta', text: 'y'.repeat(1000) });
    const parse = vi.spyOn(JSON, 'parse');
    const page = await s.eventsSince('r', 18);
    const parsedLines = parse.mock.calls.filter((c) => String(c[0]).startsWith('{"seq":')).length;
    parse.mockRestore();
    expect(page.events.map((e) => e.seq)).toEqual([19, 20]);
    expect(parsedLines).toBe(2);
  });
});
