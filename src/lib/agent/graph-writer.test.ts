import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const invokeMock = vi.fn();
const streamMock = vi.fn();
vi.mock('@langchain/openai', () => {
  class F {
    invoke = invokeMock;
    stream = streamMock;
    withStructuredOutput() { return this; }
    withConfig() { return this; }
    bindTools() { return this; }
  }
  return { ChatOpenAI: vi.fn().mockImplementation(function () { return new F(); }) };
});

import { createCadAgent } from './graph';
import { getCheckpointer, runCheckpointKey } from './checkpointer';
import { HumanMessage } from '@langchain/core/messages';

const keys: string[] = [];
afterAll(async () => {
  const cp = getCheckpointer();
  for (const k of keys) await cp.deleteThread(k);
  await new Promise((r) => setTimeout(r, 200));
});

describe('graph custom-channel writes', () => {
  beforeEach(() => {
    process.env.CADAI_VISUAL_CRITIC = 'off';
    invokeMock.mockReset();
    streamMock.mockReset();
  });

  it('streams the architect spec as markdown deltas tagged with the node id', async () => {
    // withStructuredOutput().stream() yields progressively-complete objects.
    streamMock.mockReturnValueOnce((async function* () {
      yield { brief: 'b' };
      yield { brief: 'br' };
      yield { brief: 'bracket_body', variants: [{id:'A', name:'bracket', idea:'bracket'}] };
    })());
    
    invokeMock.mockResolvedValueOnce({
      assemblyName: 'bracket_body',
      sheet: '62 x 40 x 18 mm',
      boundingBox: { width: 62, length: 40, height: 18 },
      components: [{ name: 'body', description: 'main body' }],
      assumptions: [], openQuestions: []
    });

    const agent = createCadAgent( 'deepseek-v4-flash');
    const key = runCheckpointKey('writer-test', 'run-1');
    keys.push(key);

    const custom: Array<{ t: string; node?: string; text?: string }> = [];
    for await (const [mode, payload] of await agent.stream(
      { messages: [new HumanMessage('make a bracket')], designContract: null },
      { configurable: { thread_id: key }, streamMode: ['updates', 'custom'] }
    )) {
      if (mode === 'custom') custom.push(payload as never);
    }

    const deltas = custom.filter((c) => c.t === 'delta' && c.node === 'architectNode');
    expect(deltas.length).toBeGreaterThan(0);
    const md = deltas.map((d) => d.text).join('');
    expect(md).toContain('bracket_body');
    expect(md).toContain('62 x 40 x 18 mm');
    // The whole point: no JSON reaches the channel.
    expect(md).not.toContain('{');
  });

  it('never writes a raw provider error into the channel', async () => {
    streamMock.mockImplementation(() => {
      throw new Error('400 Bad Request {"error":{"message":"giant payload"}}');
    });
    invokeMock.mockRejectedValue(new Error('400 Bad Request {"error":{"message":"giant payload"}}'));

    const agent = createCadAgent( 'deepseek-v4-flash');
    const key = runCheckpointKey('writer-test', 'run-2');
    keys.push(key);

    const custom: Array<{ text?: string }> = [];
    for await (const [mode, payload] of await agent.stream(
      { messages: [new HumanMessage('make a bracket')], designContract: null },
      { configurable: { thread_id: key }, streamMode: ['custom'] }
    )) {
      if (mode === 'custom') custom.push(payload as never);
    }
    const all = custom.map((c) => c.text ?? '').join('');
    expect(all).not.toContain('giant payload');
    expect(all).not.toContain('400 Bad Request');
  });
});
