import { describe, it, expect, afterEach } from 'vitest';
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
    await s.requestCancel('r');
    expect(await s.isCancelled('r')).toBe(true);
  });

  it('a second store on the same directory (another instance) sees runs, events and cancel flags', async () => {
    const dir = tmp();
    const a = new LocalRunStore(dir);
    const b = new LocalRunStore(dir);
    await a.create({ runId: 'r', threadId: 't' });
    await a.append('r', { t: 'run' });
    expect((await b.get('r'))?.lastSeq).toBe(1);
    expect((await b.events('r', 0)).map((e) => e.t)).toEqual(['run']);
    await b.requestCancel('r');
    expect(await a.isCancelled('r')).toBe(true);
  });

  it('ignores a torn trailing line', async () => {
    const dir = tmp();
    const s = new LocalRunStore(dir);
    await s.create({ runId: 'r', threadId: 't' });
    await s.append('r', { t: 'a' });
    fs.appendFileSync(path.join(dir, 'r.jsonl'), '{"t":"b","seq"');
    expect((await s.events('r', 0)).map((e) => e.t)).toEqual(['a']);
  });
});

describe('getRunStore', () => {
  it('is selected by CADAI_RUN_STORE (local default) and honours CADAI_RUN_DIR', async () => {
    const dir = tmp();
    process.env.CADAI_RUN_DIR = dir;
    const s = getRunStore();
    await s.create({ runId: 'sel', threadId: 't' });
    expect(fs.existsSync(path.join(dir, 'sel.json'))).toBe(true);
    process.env.CADAI_RUN_STORE = 'local';
    expect(getRunStore()).toBe(s);
  });

  it('refuses an unimplemented store instead of silently using disk', () => {
    process.env.CADAI_RUN_STORE = 'postgres';
    expect(() => getRunStore()).toThrow(/Unsupported CADAI_RUN_STORE/);
  });
});
