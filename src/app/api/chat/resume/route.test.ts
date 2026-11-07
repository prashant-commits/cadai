import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { DEFAULT_MODEL } from '@/lib/agent/models';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/graph', () => ({ createCadAgent: createAgent }));

import { POST } from './route';

const saved = { ...process.env };

let runDir = '';
beforeEach(() => {
  delete process.env.CADAI_MODEL;
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-resume-'));
  process.env.CADAI_RUN_DIR = runDir;
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 150)); // let the debounced checkpoint flush land first
  process.env = { ...saved };
  fs.rmSync(runDir, { recursive: true, force: true });
});


const call = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/chat/resume', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/chat/resume', () => {
  it('an unknown run with no checkpoint is 410 run_expired, writes nothing and never touches the graph', async () => {
    createAgent.mockClear();
    const res = await call({ threadId: 't-gone', runId: 'r-gone', decision: { action: 'approve' } });
    expect(res.status).toBe(410);
    const body = await res.json();
    // `error` stays the same human string old clients already show.
    expect(body.error).toBe('This paused run expired or was not found on this server. Send the request again.');
    expect(body.apiError.code).toBe('run_expired');
    expect(createAgent).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(runDir, 'runs'))).toEqual([]);
    expect(fs.readdirSync(path.join(runDir, 'events'))).toEqual([]);
  });

  it('a live checkpoint is resumed with coerced model slug', async () => {
    const key = runCheckpointKey('t-live', 'r-live');
    await getCheckpointer().put(
      { configurable: { thread_id: key } },
      { v: 1, id: 'cp', ts: new Date().toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} } as never,
      { source: 'update', step: 0, parents: {} } as never,
      {}
    );
    createAgent.mockReset();
    createAgent.mockReturnValue({ stream: async () => (async function* () {})() });
    const res = await call({ threadId: 't-live', runId: 'r-live', model: 'gpt-6-luna', decision: { action: 'approve' } });
    await res.text();
    expect(createAgent).toHaveBeenCalledWith(DEFAULT_MODEL);
  });
});
