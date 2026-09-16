import { describe, it, expect } from 'vitest';
import { resumableGate, freezeStreamingMessages } from './rehydrate';
import type { ChatMessage } from '@/types';

const gatePayload = { kind: 'spec', spec: null, contract: null, revisionCount: 0 } as const;

function msg(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', timestamp: 1, ...over };
}

describe('resumableGate', () => {
  it('finds the message holding an open gate and its run id', () => {
    const found = resumableGate([
      msg({ id: 'a', status: 'complete' }),
      msg({
        id: 'b',
        status: 'awaiting_input',
        runId: 'run-7',
        gates: { g1: { payload: gatePayload, status: 'open' } },
      }),
    ]);
    expect(found).toEqual({ messageId: 'b', runId: 'run-7', gate: gatePayload });
  });

  it('ignores a gate that was already decided', () => {
    expect(
      resumableGate([
        msg({ id: 'b', status: 'complete', runId: 'run-7', gates: { g1: { payload: gatePayload, status: 'approved' } } }),
      ])
    ).toBeNull();
  });

  it('ignores an open gate with no run id, which cannot be resumed', () => {
    expect(
      resumableGate([msg({ id: 'b', status: 'awaiting_input', gates: { g1: { payload: gatePayload, status: 'open' } } })])
    ).toBeNull();
  });

  it('returns the LAST open gate when a thread somehow holds two', () => {
    const found = resumableGate([
      msg({ id: 'a', status: 'awaiting_input', runId: 'run-1', gates: { g1: { payload: gatePayload, status: 'open' } } }),
      msg({ id: 'b', status: 'awaiting_input', runId: 'run-2', gates: { g2: { payload: gatePayload, status: 'open' } } }),
    ]);
    expect(found!.runId).toBe('run-2');
  });

  it('returns null for an empty thread', () => {
    expect(resumableGate([])).toBeNull();
  });
});

describe('freezeStreamingMessages', () => {
  it('marks a message left mid-stream as interrupted', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'streaming', transcript: 'partial' })]);
    expect(out.status).toBe('interrupted');
  });

  it('gives an interrupted message body text so the bubble is never blank', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'streaming', content: '' })]);
    expect(out.content.trim()).not.toBe('');
  });

  it('leaves a message awaiting input alone - its gate is still resumable', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'awaiting_input' })]);
    expect(out.status).toBe('awaiting_input');
  });

  it('leaves completed messages untouched', () => {
    const input = [msg({ status: 'complete', content: 'done' })];
    expect(freezeStreamingMessages(input)).toEqual(input);
  });
});
