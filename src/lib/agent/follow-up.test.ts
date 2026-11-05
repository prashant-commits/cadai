import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { AgentStateType } from './graph';
import type { AssemblySpec } from './assembly-spec';
import { followUpEdit } from './follow-up';

const spec = { assemblyName: 'pen_holder', components: [] } as unknown as AssemblySpec;
const state = (over: Record<string, unknown>) =>
  ({ specVariants: [], designContract: { standing: {}, pinnedParams: {}, spec }, messages: [], ...over }) as unknown as AgentStateType;

describe('followUpEdit', () => {
  it('turns a message after a finished design into an edit of the approved spec', () => {
    const r = followUpEdit(state({ messages: [new HumanMessage('a pen holder'), new AIMessage('Built it.'), new HumanMessage('Make the tubes 150 mm tall')] }));
    expect(r).toEqual({ spec, request: 'Make the tubes 150 mm tall' });
  });

  it('reads the text part of a message that carries an image', () => {
    const msg = new HumanMessage({ content: [{ type: 'text', text: 'Move this hole' }, { type: 'image_url', image_url: { url: 'data:x' } }] });
    expect(followUpEdit(state({ messages: [new HumanMessage('a'), new AIMessage('b'), msg] }))?.request).toBe('Move this hole');
  });

  it('is not an edit on the first message of a thread, without an approved spec, or mid-run', () => {
    expect(followUpEdit(state({ messages: [new HumanMessage('a pen holder')] }))).toBeNull();
    expect(followUpEdit(state({ designContract: { standing: {}, pinnedParams: {} }, messages: [new HumanMessage('a'), new AIMessage('b'), new HumanMessage('c')] }))).toBeNull();
    expect(followUpEdit(state({ specVariants: [{ id: 'A' }], messages: [new HumanMessage('a'), new AIMessage('b'), new HumanMessage('c')] }))).toBeNull();
  });
});
