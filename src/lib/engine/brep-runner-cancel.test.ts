import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBrep } from './brep-runner';

const saved = { ...process.env };
const dirs: string[] = [];
afterEach(() => {
  process.env = { ...saved };
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform === 'win32')('runBrep stop signal (local process)', () => {
  it('a stopped run kills the geometry process and its children within 1 s', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-slow-geo-'));
    dirs.push(dir);
    const pids = path.join(dir, 'pids');
    // A fake "python" that never finishes and starts a grandchild, like a CAD kernel worker.
    const fake = path.join(dir, 'slow-python.sh');
    fs.writeFileSync(fake, `#!/bin/sh\nsleep 30 &\necho "$$ $!" > "${pids}"\nwait\n`, { mode: 0o755 });
    process.env.CADAI_GEO_PYTHON = fake;
    delete process.env.CADAI_GEO_URL;

    const ac = new AbortController();
    const t0 = Date.now();
    const pending = runBrep('result = 1', { signal: ac.signal, timeoutMs: 60_000 });
    while (!fs.existsSync(pids) || !fs.readFileSync(pids, 'utf-8').trim()) await new Promise((r) => setTimeout(r, 20));
    const [shell, grandchild] = fs.readFileSync(pids, 'utf-8').trim().split(' ').map(Number);
    expect(alive(shell)).toBe(true);

    const stoppedAt = Date.now();
    ac.abort();
    const r = await pending;
    expect(Date.now() - stoppedAt).toBeLessThan(1000);
    expect(r).toMatchObject({ ok: false, error: 'cancelled' });
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(shell)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('an already-stopped run never starts the process', async () => {
    process.env.CADAI_GEO_PYTHON = '/nonexistent/python';
    delete process.env.CADAI_GEO_URL;
    const ac = new AbortController();
    ac.abort();
    expect(await runBrep('result = 1', { signal: ac.signal })).toMatchObject({ ok: false, error: 'cancelled' });
  });
});

describe('runBrep stop signal (geometry service)', () => {
  it('aborts the HTTP request within 1 s', async () => {
    process.env.CADAI_GEO_URL = 'http://geo.invalid';
    let sawSignal: AbortSignal | undefined;
    const slowFetch = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        sawSignal = init?.signal ?? undefined;
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      })) as unknown as typeof fetch;
    const ac = new AbortController();
    const pending = runBrep('result = 1', { fetchImpl: slowFetch, signal: ac.signal, timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    const stoppedAt = Date.now();
    ac.abort();
    const r = await pending;
    expect(Date.now() - stoppedAt).toBeLessThan(1000);
    expect(r).toMatchObject({ ok: false, error: 'cancelled' });
    expect(sawSignal?.aborted).toBe(true);
  });

  it('the timeout still applies when a run signal is given', async () => {
    process.env.CADAI_GEO_URL = 'http://geo.invalid';
    const slowFetch = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
      })) as unknown as typeof fetch;
    const r = await runBrep('result = 1', { fetchImpl: slowFetch, signal: new AbortController().signal, timeoutMs: 100 });
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
  });
});
