import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { DEFAULT_MODEL } from '@/lib/agent/models';

const createAgent = vi.hoisted(() => vi.fn());
vi.mock('@/lib/agent/designer/graph', () => ({ createDesignerAgent: createAgent }));

import { POST } from './route';

const saved = { ...process.env };

beforeEach(() => {
  createAgent.mockReset();
  createAgent.mockReturnValue({ stream: async () => (async function* () {})() });
  delete process.env.CADAI_MODEL;
  process.env.CADAI_RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-chat-'));
});

afterEach(() => {
  fs.rmSync(process.env.CADAI_RUN_DIR!, { recursive: true, force: true });
  process.env = { ...saved };
});

const call = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/chat errors', () => {
  it('returns ErrorBody when the messages array is missing', async () => {
    const res = await call({ threadId: 't-test' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Messages array is required.');
    expect(data.apiError).toEqual({ code: 'bad_request', message: 'Messages array is required.' });
  });

  it('keeps the SSE error message and adds apiError when the model is overloaded', async () => {
    createAgent.mockReturnValue({
      stream: async () => (async function* () {
        throw Object.assign(new Error('529 overloaded_error'), { status: 529 });
      })(),
    });
    const res = await call({ threadId: 't-test', messages: [{ role: 'user', content: 'hi' }] });
    const events = (await res.text()).split('\n\n').filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, '')));
    const error = events.find((event: { t?: string }) => event.t === 'error');
    expect(error.message).toBe('Agent execution failed; see server logs.');
    expect(error.apiError).toMatchObject({ code: 'model_unavailable', retryable: true });
  });
});

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
