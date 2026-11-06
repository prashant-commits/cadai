import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { FileCheckpointSaver, getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { getRunStore } from '@/lib/runs/run-store';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/graph', () => ({ createCadAgent: createAgent }));

import { POST as chat } from '../chat/route';
import { POST as resume } from '../chat/resume/route';
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
  await new Promise((r) => setTimeout(r, 150)); // debounced checkpoint flush
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
const inflightRunId = () => fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))!.replace('.jsonl', '');

/** Graph stream that emits `chunks` then ends. */
const graphOf = (chunks: unknown[]) => ({
  stream: async () =>
    (async function* () {
      for (const c of chunks) yield c;
    })(),
});
const delta = (text: string) => ['custom', { t: 'delta', text, node: 'architectNode' }];
const result = (summary: string) => ['custom', { t: 'result', summary, node: 'respondToUser' }];
const gate = ['updates', { __interrupt__: [{ id: 'g1', value: { kind: 'spec' } }] }];

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
    const seen: { signal?: AbortSignal } = {};
    createAgent.mockReturnValue({
      stream: async (_i: unknown, c: { signal?: AbortSignal }) => {
        seen.signal = c.signal;
        return (async function* () {})();
      },
    });
    await (await startChat()).text();
    expect(seen.signal).toBeInstanceOf(AbortSignal);
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

describe('pause at a gate', () => {
  it('sets status paused (with expiresAt) before the gate reaches the client, and keeps the checkpoint', async () => {
    createAgent.mockReturnValue(graphOf([delta('spec'), gate]));
    const res = await startChat();
    const events = parse(await res.text());
    const runId = events[0].runId;
    expect(events.map((e) => e.t)).toContain('gate');
    const info = await getRunStore().get(runId);
    expect(info?.status).toBe('paused');
    expect(info?.expiresAt).toBeGreaterThan(Date.now());
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

  it('cancel of a paused run cancels it, drops its checkpoint, and appends a cancelled event', async () => {
    createAgent.mockReturnValue(graphOf([gate]));
    const runId = parse(await (await startChat()).text())[0].runId;
    const key = runCheckpointKey('t1', runId);
    await getCheckpointer().put(
      { configurable: { thread_id: key } },
      { v: 1, id: 'cp', ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} } as never,
      { source: 'update', step: 0, parents: {} } as never,
      {}
    );
    expect(await getCheckpointer().getTuple({ configurable: { thread_id: key } })).toBeDefined();
    const res = await cancelRun(post('/c', {}), ctx(runId));
    expect(res.status).toBe(200);
    expect(await getCheckpointer().getTuple({ configurable: { thread_id: key } })).toBeUndefined();
    const info = await getRunStore().get(runId);
    expect(info?.status).toBe('cancelled');
    const stored = await getRunStore().events(runId, 0);
    expect(stored[stored.length - 1]).toMatchObject({ t: 'cancelled' });
    // and it can no longer be resumed
    const r = await resume(post('/api/chat/resume', { threadId: 't1', runId, decision: { action: 'approve' } }));
    expect(r.status).toBe(409);
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

  it('ends at a gate (paused) so the client can resume', async () => {
    createAgent.mockReturnValue(graphOf([delta('s'), gate]));
    const live = parse(await (await startChat()).text());
    const replay = parse(await (await events(live[0].runId)).text());
    expect(replay.map((e) => e.t)).toEqual(live.map((e) => e.t));
    expect(replay[replay.length - 1].t).toBe('gate');
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

describe('POST /api/chat/resume: run control', () => {
  async function pausedRun() {
    createAgent.mockReturnValue(graphOf([delta('spec'), gate]));
    const runId = parse(await (await startChat()).text())[0].runId;
    return runId as string;
  }
  const plant = (saver: FileCheckpointSaver, key: string) =>
    saver.put(
      { configurable: { thread_id: key } },
      { v: 1, id: 'cp', ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} } as never,
      { source: 'update', step: 0, parents: {} } as never,
      {}
    );

  it('resumes the same run: run event with resumed true, seq continues, status ends done', async () => {
    const runId = await pausedRun();
    const before = (await getRunStore().get(runId))!.lastSeq;
    await plant(getCheckpointer(), runCheckpointKey('t1', runId));
    createAgent.mockReturnValue(graphOf([delta('building'), result('built')]));
    const events = parse(await (await resume(post('/api/chat/resume', { threadId: 't1', runId, decision: { action: 'approve' } }))).text());
    expect(events[0]).toMatchObject({ t: 'run', runId, threadId: 't1', status: 'running', resumed: true, seq: before + 1 });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => before + 1 + i));
    expect(events[events.length - 1]).toMatchObject({ t: 'result', summary: 'built' });
    expect((await getRunStore().get(runId))?.status).toBe('done');
  });

  it('resume of a run that is not paused is 409 run_conflict', async () => {
    createAgent.mockReturnValue(graphOf([result('x')]));
    const runId = parse(await (await startChat()).text())[0].runId;
    const res = await resume(post('/api/chat/resume', { threadId: 't1', runId, decision: { action: 'approve' } }));
    expect(res.status).toBe(409);
    expect((await res.json()).apiError.code).toBe('run_conflict');
  });

  it('missing checkpoint -> run_expired event, run marked failed', async () => {
    const runId = await pausedRun(); // run record says paused, but no checkpoint exists
    const events = parse(await (await resume(post('/api/chat/resume', { threadId: 't1', runId, decision: { action: 'approve' } }))).text());
    expect(events.find((e) => e.t === 'error')?.apiError.code).toBe('run_expired');
    const info = await getRunStore().get(runId);
    expect(info?.status).toBe('failed');
    expect(info?.error?.code).toBe('run_expired');
  });

  it('resume reads a checkpoint written by ANOTHER instance sharing the store', async () => {
    const runId = await pausedRun();
    getCheckpointer(); // this instance is already running and has loaded the (empty) store
    const other = new FileCheckpointSaver(dir); // another server process on the same disk
    await plant(other, runCheckpointKey('t1', runId));
    other.flushNow();
    createAgent.mockReturnValue(graphOf([result('continued')]));
    const events = parse(await (await resume(post('/api/chat/resume', { threadId: 't1', runId, decision: { action: 'approve' } }))).text());
    expect(events.some((e) => e.t === 'error')).toBe(false);
    expect(events[events.length - 1]).toMatchObject({ t: 'result', summary: 'continued' });
    expect(createAgent).toHaveBeenCalled();
  });

  it('a gate "cancel" decision ends the run as cancelled without touching the graph', async () => {
    const runId = await pausedRun();
    await plant(getCheckpointer(), runCheckpointKey('t1', runId));
    createAgent.mockClear();
    const events = parse(await (await resume(post('/api/chat/resume', { threadId: 't1', runId, decision: { action: 'cancel' } }))).text());
    expect(events[0]).toMatchObject({ t: 'run', status: 'cancelled', resumed: true });
    expect(events[events.length - 1]).toMatchObject({ t: 'result', summary: 'Generation cancelled by user.' });
    expect(createAgent).not.toHaveBeenCalled();
    expect((await getRunStore().get(runId))?.status).toBe('cancelled');
  });

  it('bad requests are ErrorBody 400s', async () => {
    const a = await resume(post('/api/chat/resume', { runId: 'r' }));
    expect(a.status).toBe(400);
    expect((await a.json()).apiError.code).toBe('bad_request');
    const b = await resume(post('/api/chat/resume', { threadId: 't' }));
    expect(b.status).toBe(400);
    expect((await b.json()).apiError.code).toBe('bad_request');
  });

  it('a paused run from before run records existed (checkpoint only) still resumes', async () => {
    await plant(getCheckpointer(), runCheckpointKey('t-old', 'r-old'));
    createAgent.mockReturnValue(graphOf([result('legacy ok')]));
    const events = parse(await (await resume(post('/api/chat/resume', { threadId: 't-old', runId: 'r-old', decision: { action: 'approve' } }))).text());
    expect(events[0]).toMatchObject({ t: 'run', runId: 'r-old', resumed: true });
    expect(events[events.length - 1]).toMatchObject({ t: 'result' });
  });
});
