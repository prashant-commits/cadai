import { describe, it, expect } from 'vitest';
import { parseTranscript } from '@/lib/agent/transcript';

// The component is thin; what matters is that it renders exactly the nodes the
// parser finds, in order, and never emits marker syntax as visible text.
describe('transcript parsing for the view', () => {
  it('yields sections and gates in document order', () => {
    const src =
      '<!--s:architectNode|Mechanical Architect|ok-->box<!--/s-->' +
      '<!--gate:g1-->' +
      '<!--s:drafterNode|Parametric Drafter|running-->drafting<!--/s-->';
    expect(parseTranscript(src).map((n) => (n.kind === 'gate' ? 'gate' : n.id)))
      .toEqual(['architectNode', 'gate', 'drafterNode']);
  });

  it('exposes a body with no marker syntax left in it', () => {
    const nodes = parseTranscript('<!--s:n|N|ok-->plain body<!--/s-->');
    expect((nodes[0] as { body: string }).body).toBe('plain body');
  });
});
