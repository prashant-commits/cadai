import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { getRunStore } from '@/lib/runs/run-store';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/designer/graph', () => ({ createDesignerAgent: createAgent }));

import { POST as chat } from '../chat/route';
import { GET as getRun } from './[runId]/route';
import { POST as cancelRun } from './[runId]/cancel/route';
import { GET as getEvents } from './[runId]/events/route';

const saved = { ...process.env };
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-runs-api-'));
  process.env.CADAI_RUN_DIR = dir;
  process.env.CADAI_CANCEL_POLL_MS = '20';
  process.env.CADAI_TAIL_POLL_MS = '20';
  createAgent.mockReset();
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 150));
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SSE payloads are asserted field by field
type Ev = Record<string, any>;
const parse = (text: string): Ev[] =>
  text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));

const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) });
const startChat = (extra: Record<string, unknown> = {}) =>
  chat(post('/api/chat', { threadId: 't1', messages: [{ role: 'user', content: 'a bracket' }], ...extra }));
const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The one run in the temp store: the route has not returned its runId yet while the body is unread. */
const inflightRunId = () => fs.readdirSync(path.join(dir, 'events')).find((f) => f.endsWith('.jsonl'))!.replace('.jsonl', '');

/** Graph stream that emits `chunks` then ends. */
const graphOf = (chunks: unknown[]) => ({
  stream: async () =>
    (async function* () {
      for (const c of chunks) yield c;
    })(),
});
const delta = (text: string) => ['custom', { t: 'delta', text, node: 'designerNode' }];
const result = (summary: string) => ['custom', { t: 'result', summary, node: 'respondToUser' }];

/** Graph that blocks until its signal aborts, like a long LLM call. */
function hangingGraph(seen: { signal?: AbortSignal }) {
  return {
    stream: async (_input: unknown, config: { signal?: AbortSignal }) => {
      seen.signal = config.signal;
      return (async function* () {
        yield delta('working');
        await new Promise<void>((_, reject) => {
          config.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      })();
    },
  };
}

describe('POST /api/chat: run envelope', () => {
  it('first event is { t: run } with runId, threadId, status running, resumed false', async () => {
    createAgent.mockReturnValue(graphOf([delta('hi'), result('done')]));
    const events = parse(await (await startChat()).text());
    expect(events[0]).toMatchObject({ t: 'run', threadId: 't1', status: 'running', resumed: false, seq: 1 });
    expect(typeof events[0].runId).toBe('string');
    expect(events[0].runId.length).toBeGreaterThan(8);
  });

  it('every event carries seq (1,2,3...) and a non-decreasing ts; legacy fields are intact', async () => {
    createAgent.mockReturnValue(graphOf([delta('a'), delta('b'), result('fin')]));
    const events = parse(await (await startChat()).text());
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    for (let i = 1; i < events.length; i++) expect(events[i].ts).toBeGreaterThanOrEqual(events[i - 1].ts);
    expect(events.every((e) => typeof e.ts === 'number')).toBe(true);
    expect(events.find((e) => e.t === 'result')).toMatchObject({ t: 'result', summary: 'fin' });
    expect(events.filter((e) => e.t === 'delta').map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('stores every event and ends the run as done', async () => {
    createAgent.mockReturnValue(graphOf([delta('a'), result('fin')]));
    const events = parse(await (await startChat()).text());
    const runId = events[0].runId;
    const info = await getRunStore().get(runId);
    expect(info).toMatchObject({ runId, threadId: 't1', status: 'done', lastSeq: events.length });
    const stored = await getRunStore().events(runId, 0);
    expect(stored).toEqual(events);
  });

  it('the run is registered as running while the graph is still working', async () => {
    const seen: { signal?: AbortSignal } = {};
    createAgent.mockReturnValue(hangingGraph(seen));
    const res = await startChat();
    const reader = res.body!.getReader();
    const first = parse(new TextDecoder().decode((await reader.read()).value));
    const info = await getRunStore().get(first[0].runId);
    expect(info?.status).toBe('running');
    await cancelRun(post('/x', {}) , ctx(first[0].runId));
    await reader.cancel();
  });

  it('the graph stream gets an abort signal', async () => {
    const seen: { signal?: AbortSignal; streamMode?: string[] } = {};
    createAgent.mockReturnValue({
      stream: async (_i: unknown, c: { signal?: AbortSignal; streamMode?: string[] }) => {
        seen.signal = c.signal;
        seen.streamMode = c.streamMode;
        return (async function* () {})();
      },
    });
    await (await startChat()).text();
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.streamMode).toEqual(['updates', 'messages', 'custom', 'tasks']);
  });

  it('a graph failure ends the run as failed with an error event carrying apiError', async () => {
    createAgent.mockReturnValue({
      stream: async () => {
        throw new Error('model exploded');
      },
    });
    const events = parse(await (await startChat()).text());
    const err = events.find((e) => e.t === 'error')!;
    expect(err.message).toMatch(/Agent execution failed/);
    expect(err.apiError).toMatchObject({ code: 'internal' });
    const info = await getRunStore().get(events[0].runId);
    expect(info?.status).toBe('failed');
    expect(info?.error?.code).toBe('internal');
  });

  it('a bad request is an ErrorBody (400 bad_request) and keeps the string `error`', async () => {
    const res = await chat(post('/api/chat', { threadId: 't', messages: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Messages array is required.');
    expect(body.apiError).toEqual({ code: 'bad_request', message: 'Messages array is required.' });
  });
});

describe('client disconnect does not cancel', () => {
  it('the run finishes and is replayable after the reader goes away', async () => {
    createAgent.mockReturnValue({
      stream: async () =>
        (async function* () {
          yield delta('one');
          await sleep(80);
          yield delta('two');
          yield result('all done');
        })(),
    });
    const res = await startChat();
    const reader = res.body!.getReader();
    const first = parse(new TextDecoder().decode((await reader.read()).value));
    const runId = first[0].runId;
    await reader.cancel(); // tab closed
    await sleep(300);
    const info = await getRunStore().get(runId);
    expect(info?.status).toBe('done');
    expect(await getRunStore().isCancelled(runId)).toBe(false);
    const replay = parse(await (await getEvents(new NextRequest(`http://localhost/api/runs/${runId}/events`), ctx(runId))).text());
    expect(replay.map((e) => e.t)).toEqual(['run', 'section', 'delta', 'delta', 'section', 'result']);
  });
});

describe('POST /api/runs/:runId/cancel', () => {
  it('stops a running run: stream ends with { t: cancelled }, status cancelled, signal aborted', async () => {
    const seen: { signal?: AbortSignal } = {};
    createAgent.mockReturnValue(hangingGraph(seen));
    const res = await startChat();
    const textP = res.text();
    await sleep(60);
    const runId = inflightRunId();
    const cancelRes = await cancelRun(post(`/api/runs/${runId}/cancel`, {}), ctx(runId));
    expect(cancelRes.status).toBe(200);
    const events = parse(await textP);
    expect(events[events.length - 1]).toMatchObject({ t: 'cancelled' });
    expect(typeof events[events.length - 1].at).toBe('number');
    expect(events.some((e) => e.t === 'error')).toBe(false);
    expect(seen.signal?.aborted).toBe(true);
    const info = await getRunStore().get(runId);
    expect(info?.status).toBe('cancelled');
    expect(info?.error?.code).toBe('cancelled');
  });

  it('cancel requested by another instance (store flag only) is picked up by the owner', async () => {
    const seen: { signal?: AbortSignal } = {};
    createAgent.mockReturnValue(hangingGraph(seen));
    const res = await startChat();
    const textP = res.text();
    await sleep(60);
    const runId = inflightRunId();
    await getRunStore().requestCancel(runId); // no abort controller touched
    const events = parse(await textP);
    expect(events[events.length - 1].t).toBe('cancelled');
    expect((await getRunStore().get(runId))?.status).toBe('cancelled');
  });

  it('cancel of a finished run is 409 run_conflict', async () => {
    createAgent.mockReturnValue(graphOf([result('x')]));
    const runId = parse(await (await startChat()).text())[0].runId;
    const res = await cancelRun(post('/c', {}), ctx(runId));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.apiError.code).toBe('run_conflict');
    expect(typeof body.error).toBe('string');
  });

  it('cancel of an unknown run is 404 not_found', async () => {
    const res = await cancelRun(post('/c', {}), ctx('missing'));
    expect(res.status).toBe(404);
    expect((await res.json()).apiError.code).toBe('not_found');
  });
});

describe('GET /api/runs/:runId', () => {
  it('returns RunInfo', async () => {
    createAgent.mockReturnValue(graphOf([delta('a'), result('x')]));
    const events = parse(await (await startChat()).text());
    const runId = events[0].runId;
    const res = await getRun(new NextRequest(`http://localhost/api/runs/${runId}`), ctx(runId));
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info).toMatchObject({ runId, threadId: 't1', status: 'done', lastSeq: events.length });
    expect(typeof info.startedAt).toBe('number');
    expect(info.updatedAt).toBeGreaterThanOrEqual(info.startedAt);
  });

  it('unknown run is 404 not_found with an ErrorBody', async () => {
    const res = await getRun(new NextRequest('http://localhost/api/runs/nope'), ctx('nope'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.apiError.code).toBe('not_found');
    expect(body.error).toBe(body.apiError.message);
  });
});

describe('GET /api/runs/:runId/events', () => {
  const events = (runId: string, q = '') =>
    getEvents(new NextRequest(`http://localhost/api/runs/${runId}/events${q}`), ctx(runId));

  it('after=0 replays everything, starting with the stored run event', async () => {
    createAgent.mockReturnValue(graphOf([delta('a'), delta('b'), result('x')]));
    const live = parse(await (await startChat()).text());
    const replay = parse(await (await events(live[0].runId)).text());
    expect(replay).toEqual(live);
  });

  it('after=N replays only seq > N, led by a synthetic run event', async () => {
    createAgent.mockReturnValue(graphOf([delta('a'), delta('b'), result('x')]));
    const live = parse(await (await startChat()).text());
    const replay = parse(await (await events(live[0].runId, '?after=2')).text());
    expect(replay[0]).toMatchObject({ t: 'run', runId: live[0].runId, status: 'done', resumed: true, seq: 0 });
    expect(replay.slice(1)).toEqual(live.filter((e) => e.seq > 2));
  });

  it('tails a live run: replays what exists, then streams the rest until the run ends', async () => {
    createAgent.mockReturnValue({
      stream: async () =>
        (async function* () {
          yield delta('early');
          await sleep(150);
          yield delta('late');
          yield result('end');
        })(),
    });
    const res = await startChat();
    const liveP = res.text();
    await sleep(60);
    const runId = inflightRunId();
    const tail = parse(await (await events(runId, '?after=1')).text());
    const types = tail.map((e) => e.t);
    expect(types).toEqual(['run', 'section', 'delta', 'delta', 'section', 'result']);
    expect(tail.map((e) => e.seq)).toEqual([0, 2, 3, 4, 5, 6]);
    await liveP;
  });

  it('a cancelled run replays through its cancelled event', async () => {
    const seen: { signal?: AbortSignal } = {};
    createAgent.mockReturnValue(hangingGraph(seen));
    const textP = (await startChat()).text();
    await sleep(60);
    const runId = inflightRunId();
    await cancelRun(post('/c', {}), ctx(runId));
    await textP;
    const replay = parse(await (await events(runId)).text());
    expect(replay[replay.length - 1].t).toBe('cancelled');
  });

  it('rejects a bad `after` with 400 bad_request and an unknown run with 404', async () => {
    createAgent.mockReturnValue(graphOf([result('x')]));
    const runId = parse(await (await startChat()).text())[0].runId;
    for (const bad of ['?after=-1', '?after=abc', '?after=1.5']) {
      const res = await events(runId, bad);
      expect(res.status).toBe(400);
      expect((await res.json()).apiError.code).toBe('bad_request');
    }
    const res = await events('ghost');
    expect(res.status).toBe(404);
    expect((await res.json()).apiError.code).toBe('not_found');
  });
});

describe('review fixes (routes)', () => {
  it('F7: a run whose owner died is failed by the tail (which then ends) and cancel answers 409', async () => {
    const store = getRunStore();
    await store.create({ runId: 'orphan', threadId: 't' });
    await store.append('orphan', { t: 'run', runId: 'orphan', threadId: 't', status: 'running', resumed: false });
    process.env.CADAI_RUN_LOST_MS = '100';
    const t0 = Date.now();
    const tail = parse(await (await getEvents(new NextRequest('http://localhost/api/runs/orphan/events'), ctx('orphan'))).text());
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(tail.at(-1)).toMatchObject({ t: 'error', apiError: { message: 'run lost: its server instance stopped' } });
    expect((await store.get('orphan'))?.status).toBe('failed');
    const c = await cancelRun(post('/c', {}), ctx('orphan'));
    expect(c.status).toBe(409);
  });

  it('F7: the owner heartbeats, so a long quiet step is not mistaken for a lost run', async () => {
    process.env.CADAI_RUN_HEARTBEAT_MS = '30';
    process.env.CADAI_RUN_LOST_MS = '150';
    createAgent.mockReturnValue({
      stream: async () =>
        (async function* () {
          await sleep(500); // a long model call with no events
          yield result('slow but alive');
        })(),
    });
    const textP = (await startChat()).text();
    await sleep(350);
    const info = await getRunStore().get(inflightRunId());
    expect(info?.status).toBe('running');
    const events = parse(await textP);
    expect(events.at(-1)).toMatchObject({ t: 'result' });
    expect((await getRunStore().get(events[0].runId))?.status).toBe('done');
  });

  it('F9: a cancel that lands after the result keeps the run done with exactly one terminal outcome', async () => {
    process.env.CADAI_CANCEL_ACK_MS = '300'; // the fake graph ignores the abort; the route ends it as done
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    createAgent.mockReturnValue({
      stream: async () =>
        (async function* () {
          yield result('finished');
          await gateOpen; // the graph is wrapping up after its result
        })(),
    });
    const textP = (await startChat()).text();
    await sleep(60);
    const runId = inflightRunId();
    const c = await cancelRun(post('/c', {}), ctx(runId));
    expect(c.status).toBe(200);
    release();
    const events = parse(await textP);
    expect(events.map((e) => e.t)).not.toContain('cancelled');
    expect((await getRunStore().get(runId))?.status).toBe('done');
    expect(await getRunStore().isCancelled(runId)).toBe(false); // flag cleared with the terminal status
    const again = await cancelRun(post('/c', {}), ctx(runId));
    expect(again.status).toBe(409);
  });


  it('F11: a graph error event keeps its message on the failed RunInfo', async () => {
    createAgent.mockReturnValue(graphOf([['custom', { t: 'error', message: 'The script failed to compile part X', node: 'designerNode' }]]));
    const events = parse(await (await startChat()).text());
    const err = events.find((e) => e.t === 'error')!;
    expect(err.message).toBe('The script failed to compile part X');
    expect(err.apiError).toMatchObject({
      code: 'internal',
      message: 'Something went wrong on the server.',
    });
    expect(err.apiError.detail).toContain('The script failed to compile part X');
    const info = await getRunStore().get(events[0].runId);
    expect(info).toMatchObject({ status: 'failed', error: err.apiError });
  });

  it('F11: a thrown graph error keeps the real (redacted) cause as ApiError.detail', async () => {
    createAgent.mockReturnValue({
      stream: async () => {
        throw new Error('401 from provider: invalid x-api-key sk-ant-abcdefghijklmnop');
      },
    });
    const events = parse(await (await startChat()).text());
    const err = events.find((e) => e.t === 'error')!;
    expect(err.message).toMatch(/Agent execution failed/);
    expect(err.apiError.detail).toContain('401 from provider');
    expect(err.apiError.detail).not.toContain('sk-ant-abcdefghijklmnop');
    expect((await getRunStore().get(events[0].runId))?.error?.detail).toBe(err.apiError.detail);
  });

  it('F13: a client that never reads does not hold the run open; past the backlog cap it is cut off', async () => {
    process.env.CADAI_CLIENT_BACKLOG_BYTES = String(256 * 1024);
    const big = 'x'.repeat(200 * 1024);
    createAgent.mockReturnValue(graphOf([delta(big), delta(big), delta(big), result('done')]));
    const res = await startChat();
    await sleep(300); // nobody reads
    const runId = inflightRunId();
    expect((await getRunStore().get(runId))?.status).toBe('done');
    // everything is stored for replay, but the unread live stream was dropped instead of buffered without limit
    expect((await getRunStore().events(runId, 0)).at(-1)).toMatchObject({ t: 'result' });
    await expect(res.text()).rejects.toThrow(/too far behind/);
  });

  it('F13: a client that reads late still gets every event (closing never drops queued data)', async () => {
    createAgent.mockReturnValue(graphOf([delta('a'), delta('b'), result('done')]));
    const res = await startChat();
    await sleep(200);
    const events = parse(await res.text());
    expect(events.map((e) => e.t)).toEqual(['run', 'section', 'delta', 'delta', 'section', 'result']);
  });

  it('F13: if the store fails mid-run the live stream keeps unique, increasing seqs', async () => {
    createAgent.mockReturnValue(graphOf([delta('a'), delta('b'), result('r')]));
    const store = getRunStore();
    const real = store.append.bind(store);
    let n = 0;
    const spy = vi.spyOn(store, 'append').mockImplementation(async (...args) => {
      if (++n > 2) throw new Error('disk full');
      return real(...args);
    });
    const events = parse(await (await startChat()).text());
    spy.mockRestore();
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs.every((s) => s > 0)).toBe(true);
  });
});

describe('re-review fixes (routes)', () => {
  it('N2: an owner that was reaped while stalled stores nothing after the terminal event and stops its graph', async () => {
    process.env.CADAI_RUN_LOST_MS = '100';
    process.env.CADAI_RUN_HEARTBEAT_MS = '100000'; // the stalled owner does not heartbeat
    let release!: () => void;
    const stall = new Promise<void>((r) => (release = r));
    const seen: { signal?: AbortSignal } = {};
    createAgent.mockReturnValue({
      stream: async (_i: unknown, c: { signal?: AbortSignal }) => {
        seen.signal = c.signal;
        return (async function* () {
          yield delta('working');
          await stall; // e.g. the machine slept
          yield delta('late');
          yield result('too late');
        })();
      },
    });
    const textP = (await startChat()).text();
    await sleep(60);
    const runId = inflightRunId();
    await getRunStore().get(runId); // a reader observes the run
    await sleep(150);
    expect((await getRunStore().get(runId))?.status).toBe('failed'); // reaped as lost
    release();
    const live = parse(await textP);
    const stored = await getRunStore().events(runId, 0);
    const terminal = stored.findIndex((e) => e.t === 'error');
    expect(terminal).toBe(stored.length - 1); // nothing after the terminal event
    expect(stored.map((e) => e.t)).not.toContain('result');
    expect(live.at(-1)).toMatchObject({ t: 'error', apiError: { message: 'run lost: its server instance stopped' } });
    expect(seen.signal?.aborted).toBe(true);
    expect((await getRunStore().get(runId))?.status).toBe('failed');
  });

  it('N3: Stop on a run whose owner is gone ends it as cancelled, not as "run lost"', async () => {
    process.env.CADAI_CANCEL_ACK_MS = '200';
    const store = getRunStore();
    await store.create({ runId: 'orphan2', threadId: 't' });
    await store.append('orphan2', { t: 'run', runId: 'orphan2', threadId: 't', status: 'running', resumed: false });
    const res = await cancelRun(post('/c', {}), ctx('orphan2'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    expect((await store.events('orphan2', 0)).at(-1)).toMatchObject({ t: 'cancelled' });
  });

  it('N3: Stop on a live run is acknowledged by its owner (the route waits and reports cancelled)', async () => {
    const seen: { signal?: AbortSignal } = {};
    createAgent.mockReturnValue(hangingGraph(seen));
    const textP = (await startChat()).text();
    await sleep(60);
    const res = await cancelRun(post('/c', {}), ctx(inflightRunId()));
    expect((await res.json()).status).toBe('cancelled');
    expect(parse(await textP).filter((e) => e.t === 'cancelled')).toHaveLength(1);
  });

  it('N4: a failed append does not stop later events being stored; live seqs equal stored seqs', async () => {
    createAgent.mockReturnValue(graphOf([delta('a'), delta('b'), result('r')]));
    const store = getRunStore();
    const real = store.append.bind(store);
    let n = 0;
    const spy = vi.spyOn(store, 'append').mockImplementation(async (...args) => {
      if (++n === 2) throw new Error('lock timeout'); // one transient failure
      return real(...args);
    });
    const live = parse(await (await startChat()).text());
    spy.mockRestore();
    const stored = await store.events(live[0].runId, 0);
    expect(stored.map((e) => e.t)).toEqual(['run', 'section', 'delta', 'delta', 'section', 'result']);
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(live).toEqual(stored);
    expect((await store.get(live[0].runId))?.status).toBe('done');
  });
});
