import { describe, it, expect } from 'vitest';
import { buildFirstUserMessage } from './prompt';
import type { DesignerInput } from './types';

describe('designer prompt markup framing', () => {
  const MARKUP_SENTENCE =
    'The image above is a screenshot of the current design that the user drew on. The marks show the change they want; everything under the marks is the current design, not a target.';
  const REFERENCE_SENTENCE = "The images above are the user's reference images.";

  it('the markup sentence reaches the designer prompt', () => {
    const input: DesignerInput = {
      request: 'make a notch',
      attachments: [{ mediaType: 'image/png', base64: 'xyz', kind: 'markup' }],
    };
    const msg = buildFirstUserMessage(input, 'body');
    expect(msg).toContain(MARKUP_SENTENCE);
    expect(msg).not.toContain(REFERENCE_SENTENCE);
  });

  it('reference images keep the old sentence', () => {
    const input: DesignerInput = {
      request: 'make a bracket',
      attachments: [{ mediaType: 'image/png', base64: 'xyz', kind: 'reference' }],
    };
    const msg = buildFirstUserMessage(input, 'body');
    expect(msg).toContain(REFERENCE_SENTENCE);
    expect(msg).not.toContain(MARKUP_SENTENCE);
  });

  it('both sentences present when both kinds exist', () => {
    const input: DesignerInput = {
      request: 'modify lid',
      attachments: [
        { mediaType: 'image/png', base64: 'xyz1', kind: 'markup' },
        { mediaType: 'image/png', base64: 'xyz2', kind: 'reference' },
      ],
    };
    const msg = buildFirstUserMessage(input, 'body');
    expect(msg).toContain(MARKUP_SENTENCE);
    expect(msg).toContain(REFERENCE_SENTENCE);
  });
});
