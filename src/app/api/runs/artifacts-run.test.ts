import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { getRunStore } from '@/lib/runs/run-store';
import { getArtifactStore } from '@/lib/runs/artifact-store';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/designer/graph', () => ({ createDesignerAgent: createAgent }));

import { POST as chat } from '../chat/route';
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
});
