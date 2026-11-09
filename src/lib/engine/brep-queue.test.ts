import { describe, it, expect, vi, afterEach } from 'vitest';
import { runBrep } from './brep-runner';

describe('brep-runner geo queue', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('at most 2 concurrent runBrep calls; the rest queue in order', async () => {
    vi.stubEnv('CADAI_GEO_URL', 'http://geo.invalid');

    let inFlight = 0;
    let maxInFlight = 0;
    const executionOrder: number[] = [];

    const deferreds: Array<{ resolve: () => void; id: number }> = [];

    const fakeFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);

      const body = JSON.parse(init?.body as string) as { script: string };
      const idMatch = /# ID: (\d+)/.exec(body.script);
      const id = idMatch ? Number(idMatch[1]) : 0;
      executionOrder.push(id);

      await new Promise<void>((resolve) => {
        deferreds.push({ resolve, id });
      });

      inFlight--;
      return new Response(
        JSON.stringify({
          ok: true,
          parts: [],
          solids: 0,
          ms: 10,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    });

    const p1 = runBrep('box = Box(10, 10, 10)\n# ID: 1', { fetchImpl: fakeFetch });
    const p2 = runBrep('box = Box(10, 10, 10)\n# ID: 2', { fetchImpl: fakeFetch });
    const p3 = runBrep('box = Box(10, 10, 10)\n# ID: 3', { fetchImpl: fakeFetch });
    const p4 = runBrep('box = Box(10, 10, 10)\n# ID: 4', { fetchImpl: fakeFetch });

    await new Promise((r) => setTimeout(r, 50));

    expect(inFlight).toBe(2);
    expect(maxInFlight).toBe(2);
    expect(executionOrder).toEqual([1, 2]);

    deferreds[0].resolve();
    await new Promise((r) => setTimeout(r, 50));

    expect(inFlight).toBe(2);
    expect(maxInFlight).toBe(2);
    expect(executionOrder).toEqual([1, 2, 3]);

    deferreds[1].resolve();
    await new Promise((r) => setTimeout(r, 50));

    expect(inFlight).toBe(2);
    expect(maxInFlight).toBe(2);
    expect(executionOrder).toEqual([1, 2, 3, 4]);

    deferreds[2].resolve();
    deferreds[3].resolve();

    const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(true);
    expect(maxInFlight).toBe(2);
  });

  it('a queued call aborted before its turn never reaches the transport and returns cancelled', async () => {
    vi.stubEnv('CADAI_GEO_URL', 'http://geo.invalid');

    const deferreds: Array<() => void> = [];
    const calledIds: number[] = [];

    const fakeFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { script: string };
      const idMatch = /# ID: (\d+)/.exec(body.script);
      const id = idMatch ? Number(idMatch[1]) : 0;
      calledIds.push(id);

      await new Promise<void>((resolve) => {
        deferreds.push(resolve);
      });

      return new Response(
        JSON.stringify({
          ok: true,
          parts: [],
          solids: 0,
          ms: 10,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    });

    const p1 = runBrep('box = Box(10, 10, 10)\n# ID: 1', { fetchImpl: fakeFetch });
    const p2 = runBrep('box = Box(10, 10, 10)\n# ID: 2', { fetchImpl: fakeFetch });

    await new Promise((r) => setTimeout(r, 50));
    expect(calledIds).toEqual([1, 2]);

    const abortCtrl = new AbortController();
    const p3 = runBrep('box = Box(10, 10, 10)\n# ID: 3', {
      fetchImpl: fakeFetch,
      signal: abortCtrl.signal,
    });

    const p4 = runBrep('box = Box(10, 10, 10)\n# ID: 4', { fetchImpl: fakeFetch });

    await new Promise((r) => setTimeout(r, 50));
    expect(calledIds).toEqual([1, 2]);

    abortCtrl.abort();

    const r3 = await p3;
    expect(r3.ok).toBe(false);
    expect(r3.error).toBe('cancelled');

    deferreds[0]();
    await new Promise((r) => setTimeout(r, 50));
    expect(calledIds).toEqual([1, 2, 4]);

    deferreds[1]();
    deferreds[2]();

    const [r1, r2, r4] = await Promise.all([p1, p2, p4]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r4.ok).toBe(true);
  });
});
