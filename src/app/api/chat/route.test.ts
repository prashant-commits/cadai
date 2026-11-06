import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_MODEL } from '@/lib/agent/models';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/graph', () => ({ createCadAgent: createAgent }));

import { POST } from './route';

const saved = { ...process.env };

beforeEach(() => {
  createAgent.mockReset();
  createAgent.mockReturnValue({ stream: async () => (async function* () {})() });
  delete process.env.CADAI_MODEL;
});

afterEach(() => {
  process.env = { ...saved };
});

const call = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/chat model coercion', () => {
  it('coerces retired gateway slug to DEFAULT_MODEL', async () => {
    const res = await call({
      threadId: 't-test',
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'test message' }],
    });
    await res.text();
    expect(createAgent).toHaveBeenCalledWith(DEFAULT_MODEL);
  });

  it('keeps offered catalogue slugs as-is', async () => {
    const res = await call({
      threadId: 't-test',
      model: 'claude-opus-5.5',
      messages: [{ role: 'user', content: 'test message' }],
    });
    await res.text();
    expect(createAgent).toHaveBeenCalledWith('claude-opus-5.5');
  });

  it('allows CADAI_MODEL override when it is an offered slug', async () => {
    process.env.CADAI_MODEL = 'claude-sonnet-5.5';
    const res = await call({
      threadId: 't-test',
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'test message' }],
    });
    await res.text();
    expect(createAgent).toHaveBeenCalledWith('claude-sonnet-5.5');
  });

  it('ignores CADAI_MODEL when it is not an offered slug and falls back to DEFAULT_MODEL', async () => {
    process.env.CADAI_MODEL = 'gpt-5.6-luna';
    const res = await call({
      threadId: 't-test',
      model: 'gpt-6-luna',
      messages: [{ role: 'user', content: 'test message' }],
    });
    await res.text();
    expect(createAgent).toHaveBeenCalledWith(DEFAULT_MODEL);
  });
});
