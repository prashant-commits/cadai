import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { getRunStore } from '@/lib/runs/run-store';
import { getArtifactStore } from '@/lib/runs/artifact-store';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/designer/graph', () => ({ createDesignerAgent: createAgent }));

import { POST as chat } from '../chat/route';
import { POST as resume } from '../chat/resume/route';
import { POST as cancelRun } from './[runId]/cancel/route';
import { GET as getArtifact } from '../artifacts/[id]/route';

const saved = { ...process.env };
let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-art-run-'));
  process.env.CADAI_RUN_DIR = dir;
  process.env.CADAI_CANCEL_POLL_MS = '20';
  delete process.env.CADAI_INLINE_PAYLOADS;
  createAgent.mockReset();
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 150));
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SSE payloads are asserted field by field
type Ev = Record<string, any>;
const parse = (text: string): Ev[] => text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
const graphOf = (chunks: unknown[]) => ({
  stream: async () =>
    (async function* () {
      for (const c of chunks) yield c;
    })(),
});
const startChat = () =>
  chat(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ threadId: 't1', messages: [{ role: 'user', content: 'a bracket' }] }) }));
const fetchArtifact = (id: string) => getArtifact(new NextRequest(`http://localhost/api/artifacts/${id}`), { params: Promise.resolve({ id }) });

/** A 2 MB ASCII STL (the size class that motivated this) and a small base64 STEP. */
const BIG_STL = `solid big\n${'facet normal 0 0 1\n outer loop\n  vertex 0 0 0\n  vertex 1 0 0\n  vertex 0 1 0\n endloop\nendfacet\n'.repeat(22_000)}endsolid big\n`;
const STEP_BYTES = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n');
const resultChunk = (extra: Record<string, unknown> = {}) => [
  'custom',
  { t: 'result', summary: 'done', code: 'cube(1);', stl: BIG_STL, step: STEP_BYTES.toString('base64'), language: 'build123d', node: 'respondToUser', ...extra },
];

describe('result event', () => {
  it('carries refs and no inline stl/step by default; code stays inline', async () => {
    expect(BIG_STL.length).toBeGreaterThan(1_900_000);
    createAgent.mockReturnValue(graphOf([resultChunk()]));
    const events = parse(await (await startChat()).text());
    const result = events.find((e) => e.t === 'result')!;
    expect(result.stl).toBeUndefined();
    expect(result.step).toBeUndefined();
    expect(result.code).toBe('cube(1);');
    expect(result.artifacts.stl).toMatchObject({ kind: 'stl', bytes: BIG_STL.length });
    expect(result.artifacts.step).toMatchObject({ kind: 'step', bytes: STEP_BYTES.length });

    // The refs resolve to the original bytes.
    const stl = await fetchArtifact(result.artifacts.stl.id);
    expect(await stl.text()).toBe(BIG_STL);
    const step = await fetchArtifact(result.artifacts.step.id);
    expect(Buffer.from(await step.arrayBuffer()).equals(STEP_BYTES)).toBe(true);
  });

  it('keeps the inline fields next to the refs when CADAI_INLINE_PAYLOADS=1', async () => {
    process.env.CADAI_INLINE_PAYLOADS = '1';
    createAgent.mockReturnValue(graphOf([resultChunk()]));
    const result = parse(await (await startChat()).text()).find((e) => e.t === 'result')!;
    expect(result.stl).toBe(BIG_STL);
    expect(result.step).toBe(STEP_BYTES.toString('base64'));
    expect(result.artifacts.stl.bytes).toBe(BIG_STL.length);
    expect(result.artifacts.step.bytes).toBe(STEP_BYTES.length);
  });

  it('stores the event exactly as streamed: the log line for a 2 MB STL is small', async () => {
    createAgent.mockReturnValue(graphOf([resultChunk()]));
    const events = parse(await (await startChat()).text());
    const runId = events[0].runId;
    const line = fs.readFileSync(path.join(dir, 'events', `${runId}.jsonl`), 'utf-8').split('\n').find((l) => l.includes('"t":"result"'))!;
    expect(line.length).toBeLessThan(10_000);
    const stored = (await getRunStore().events(runId, 0)).find((e) => e.t === 'result')!;
    const streamed = events.find((e) => e.t === 'result')!;
    expect(stored).toEqual(streamed);
  });

  it('a result without payloads has no artifacts field', async () => {
    createAgent.mockReturnValue(graphOf([['custom', { t: 'result', summary: 'x', node: 'respondToUser' }]]));
    const result = parse(await (await startChat()).text()).find((e) => e.t === 'result')!;
    expect(result.artifacts).toBeUndefined();
  });

  it('falls back to inline when the artifact store fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(getArtifactStore(), 'put').mockRejectedValue(new Error('disk full'));
    createAgent.mockReturnValue(graphOf([resultChunk()]));
    const result = parse(await (await startChat()).text()).find((e) => e.t === 'result')!;
    expect(result.stl).toBe(BIG_STL);
    expect(result.artifacts).toBeUndefined();
    warn.mockRestore();
  });
});

describe('gate event', () => {
  const specGate = (sheetA: string | null, sheetB: string | null) => [
    'updates',
    {
      __interrupt__: [
        {
          id: 'g1',
          value: {
            kind: 'spec',
            recommendedId: 'B',
            variants: [
              { id: 'A', name: 'a', idea: '', spec: null, sheetSvg: sheetA, review: null },
              { id: 'B', name: 'b', idea: '', spec: null, sheetSvg: sheetB, review: null },
            ],
            contract: null,
            revisionCount: 0,
          },
        },
      ],
    },
  ];

  it('carries sheet refs (recommended as sheetSvg, all by variant id) and nulls the inline sheets', async () => {
    const a = `<svg>${'a'.repeat(5000)}</svg>`;
    const b = `<svg>${'b'.repeat(5000)}</svg>`;
    createAgent.mockReturnValue(graphOf([specGate(a, b)]));
    const events = parse(await (await startChat()).text());
    const gate = events.find((e) => e.t === 'gate')!;
    expect(gate.payload.variants.map((v: Ev) => v.sheetSvg)).toEqual([null, null]);
    expect(gate.artifacts.sheetSvg).toEqual(gate.artifacts.sheets.B);
    expect(gate.artifacts.sheets.A.id).not.toBe(gate.artifacts.sheets.B.id);
    expect(gate.artifacts.sheetSvg.kind).toBe('svg');
    expect(await (await fetchArtifact(gate.artifacts.sheets.A.id)).text()).toBe(a);
    expect(await (await fetchArtifact(gate.artifacts.sheetSvg.id)).text()).toBe(b);
    const line = fs.readFileSync(path.join(dir, 'events', `${events[0].runId}.jsonl`), 'utf-8').split('\n').find((l) => l.includes('"t":"gate"'))!;
    expect(line.length).toBeLessThan(5_000);
  });

  it('keeps sheets inline when CADAI_INLINE_PAYLOADS=1; a variant without a sheet gets no ref', async () => {
    process.env.CADAI_INLINE_PAYLOADS = '1';
    createAgent.mockReturnValue(graphOf([specGate('<svg>a</svg>', null)]));
    const gate = parse(await (await startChat()).text()).find((e) => e.t === 'gate')!;
    expect(gate.payload.variants[0].sheetSvg).toBe('<svg>a</svg>');
    expect(gate.payload.variants[1].sheetSvg).toBeNull();
    expect(Object.keys(gate.artifacts.sheets)).toEqual(['A']);
    expect(gate.artifacts.sheetSvg).toBeUndefined(); // recommended B has no sheet: not substituted
  });

  it('accept gate: the stl goes by reference', async () => {
    createAgent.mockReturnValue(graphOf([['updates', { __interrupt__: [{ id: 'g2', value: { kind: 'accept', code: 'x', stl: BIG_STL, violations: [], modelInfo: null, revisionCount: 0 } }] }]]));
    const events = parse(await (await startChat()).text());
    const gate = events.find((e) => e.t === 'gate')!;
    expect(gate.payload.stl).toBeUndefined();
    expect(gate.payload.code).toBe('x');
    expect(gate.artifacts.stl.bytes).toBe(BIG_STL.length);
    const line = fs.readFileSync(path.join(dir, 'events', `${events[0].runId}.jsonl`), 'utf-8').split('\n').find((l) => l.includes('"t":"gate"'))!;
    expect(line.length).toBeLessThan(10_000);
  });
});

describe('cleanup', () => {
  it('cancelling a paused run deletes the artifacts only it holds, and keeps shared ones', async () => {
    const shared = await getArtifactStore().put('other-run', 'svg', '<svg>shared</svg>');
    createAgent.mockReturnValue(graphOf([['updates', { __interrupt__: [{ id: 'g', value: { kind: 'spec', recommendedId: 'A', variants: [{ id: 'A', name: 'a', idea: '', spec: null, sheetSvg: '<svg>shared</svg>', review: null }, { id: 'B', name: 'b', idea: '', spec: null, sheetSvg: '<svg>mine</svg>', review: null }], contract: null, revisionCount: 0 } }] }]]));
    const gate = parse(await (await startChat()).text()).find((e) => e.t === 'gate')!;
    const runId = gate.runId;
    const mine = gate.artifacts.sheets.B;
    expect((await fetchArtifact(mine.id)).status).toBe(200);

    const res = await cancelRun(new NextRequest(`http://localhost/api/runs/${runId}/cancel`, { method: 'POST' }), { params: Promise.resolve({ runId }) });
    expect(res.status).toBe(200);
    expect((await fetchArtifact(mine.id)).status).toBe(404);
    expect((await fetchArtifact(shared.id)).status).toBe(200);
  });
});

describe('M1: a failing artifact store never kills the run', () => {
  it('an unsupported CADAI_ARTIFACT_STORE leaves a result inline and ends the run done; delta/run events never touch the store', async () => {
    process.env.CADAI_ARTIFACT_STORE = 's3';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createAgent.mockReturnValue(graphOf([['custom', { t: 'delta', text: 'hi', node: 'architectNode' }], resultChunk()]));
    const events = parse(await (await startChat()).text());
    const result = events.find((e) => e.t === 'result')!;
    expect(result.stl).toBe(BIG_STL);
    expect(result.artifacts).toBeUndefined();
    expect(events.some((e) => e.t === 'error')).toBe(false);
    expect((await getRunStore().get(events[0].runId))?.status).toBe('done');
    expect(warn).toHaveBeenCalledTimes(1); // logged once
    warn.mockRestore();
  });

  it('a gate stays inline too, and cancelling with a bad store still succeeds', async () => {
    process.env.CADAI_ARTIFACT_STORE = 's3';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createAgent.mockReturnValue(graphOf([['updates', { __interrupt__: [{ id: 'g', value: { kind: 'accept', code: 'x', stl: 'solid', violations: [], modelInfo: null, revisionCount: 0 } }] }]]));
    const gate = parse(await (await startChat()).text()).find((e) => e.t === 'gate')!;
    expect(gate.payload.stl).toBe('solid');
    const runId = gate.runId;
    const res = await cancelRun(new NextRequest(`http://localhost/api/runs/${runId}/cancel`, { method: 'POST' }), { params: Promise.resolve({ runId }) });
    expect(res.status).toBe(200);
    warn.mockRestore();
  });
});

describe('M3: cancelling at the gate via resume', () => {
  it('deletes the artifacts only this run holds, and keeps shared ones', async () => {
    const shared = await getArtifactStore().put('other-run', 'svg', '<svg>shared</svg>');
    createAgent.mockReturnValue(graphOf([['updates', { __interrupt__: [{ id: 'g', value: { kind: 'spec', recommendedId: 'A', variants: [{ id: 'A', name: 'a', idea: '', spec: null, sheetSvg: '<svg>shared</svg>', review: null }, { id: 'B', name: 'b', idea: '', spec: null, sheetSvg: '<svg>mine</svg>', review: null }], contract: null, revisionCount: 0 } }] }]]));
    const gate = parse(await (await startChat()).text()).find((e) => e.t === 'gate')!;
    const mine = gate.artifacts.sheets.B;
    expect((await fetchArtifact(mine.id)).status).toBe(200);
    await getCheckpointer().put(
      { configurable: { thread_id: runCheckpointKey('t1', gate.runId) } },
      { v: 1, id: 'cp', ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} } as never,
      { source: 'update', step: 0, parents: {} } as never,
      {},
    );
    const res = await resume(new NextRequest('http://localhost/api/chat/resume', { method: 'POST', body: JSON.stringify({ threadId: 't1', runId: gate.runId, decision: { action: 'cancel' } }) }));
    await res.text();
    expect((await getRunStore().get(gate.runId))?.status).toBe('cancelled');
    expect((await fetchArtifact(mine.id)).status).toBe(404);
    expect((await fetchArtifact(shared.id)).status).toBe(200);
  });
});
