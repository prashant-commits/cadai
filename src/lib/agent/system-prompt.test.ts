import { describe, it, expect } from 'vitest';
import { SystemMessage } from '@langchain/core/messages';
import { cachedSystemMessage } from './system-prompt';

describe('cachedSystemMessage', () => {
  it('returns a SystemMessage whose content block carries ephemeral cache control', () => {
    const text = 'You are a CAD designer.';
    const msg = cachedSystemMessage(text);
    expect(msg).toBeInstanceOf(SystemMessage);
    expect(msg.content).toEqual([
      {
        type: 'text',
        text,
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});
