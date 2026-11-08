import { describe, it, expect } from 'vitest';
import { freezeStreamingMessages } from './chat-messages';
import type { ChatMessage } from '@/types';

function msg(over: Partial<ChatMessage>): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', timestamp: Date.now(), ...over };
}

describe('freezeStreamingMessages', () => {
  it('marks a message left mid-stream as interrupted', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'streaming', transcript: 'partial' })]);
    expect(out.status).toBe('interrupted');
  });

  it('gives an interrupted message body text so the bubble is never blank', () => {
    const [out] = freezeStreamingMessages([msg({ status: 'streaming', content: '' })]);
    expect(out.content.trim()).not.toBe('');
  });

  it('leaves completed messages untouched', () => {
    const input = [msg({ status: 'complete', content: 'done' })];
    expect(freezeStreamingMessages(input)).toEqual(input);
  });
});
