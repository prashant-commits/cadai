import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getCheckpointer, runCheckpointKey } from '@/lib/agent/checkpointer';
import { DEFAULT_MODEL } from '@/lib/agent/models';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/graph', () => ({ createCadAgent: createAgent }));

import { POST } from './route';

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.CADAI_MODEL;
});

afterEach(() => {
  process.env = { ...saved };
});

const keys: string[] = [];
afterAll(async () => {
  for (const k of keys) await getCheckpointer().deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
});

const call = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/chat/resume', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/chat/resume', () => {
  it('an expired / missing checkpoint gets a clear error event and never touches the graph', async () => {
    createAgent.mockClear();
    const res = await call({ threadId: 't-gone', runId: 'r-gone', decision: { action: 'approve' } });
    const text = await res.text();
    const events = text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    expect(events).toEqual([
      { t: 'error', message: 'This paused run expired or was not found on this server. Send the request again.' },
    ]);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('a live checkpoint is resumed with coerced model slug', async () => {
    const key = runCheckpointKey('t-live', 'r-live');
    keys.push(key);
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
