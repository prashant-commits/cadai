import { describe, it, expect } from 'vitest';
import {
  serializeTranscript,
  parseTranscript,
  escapeMarkers,
  type TranscriptNode,
} from './transcript';

describe('transcript markers', () => {
  it('round-trips sections', () => {
    const nodes: TranscriptNode[] = [
      { kind: 'section', id: 'designerNode', label: 'Mechanical Designer', status: 'ok', body: 'Bounding box: 62 x 40 x 18 mm' },
      { kind: 'section', id: 'checkNode', label: 'Verifier', status: 'warn', body: 'wrote 2 modules' },
    ];
    expect(parseTranscript(serializeTranscript(nodes))).toEqual(nodes);
  });

  it('skips legacy gate markers without throwing', () => {
    const src = '<!--s:a|A|ok-->body<!--/s-->\n<!--gate:legacy-gate-1-->\n<!--s:b|B|ok-->body2<!--/s-->';
    const parsed = parseTranscript(src);
    expect(parsed).toEqual([
      { kind: 'section', id: 'a', label: 'A', status: 'ok', body: 'body' },
      { kind: 'section', id: 'b', label: 'B', status: 'ok', body: 'body2' },
    ]);
  });

  it('round-trips a section whose body contains a fenced code block', () => {
    const nodes: TranscriptNode[] = [
      { kind: 'section', id: 'designerNode', label: 'Designer', status: 'ok', body: '```python\nBox(1, 2, 3)\n```' },
    ];
    expect(parseTranscript(serializeTranscript(nodes))).toEqual(nodes);
  });

  it('neutralises a marker sequence appearing inside content', () => {
    const body = escapeMarkers('the model wrote <!--/s--> in its output');
    const parsed = parseTranscript(
      serializeTranscript([{ kind: 'section', id: 'n', label: 'L', status: 'ok', body }])
    );
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as { body: string }).body).not.toContain('<!--');
  });

  it('ignores a trailing unclosed section rather than swallowing the document', () => {
    const src = serializeTranscript([
      { kind: 'section', id: 'a', label: 'A', status: 'ok', body: 'done' },
    ]) + '<!--s:b|B|running-->partial';
    expect(parseTranscript(src).map((n) => n.kind)).toEqual(['section']);
  });

  it('returns an empty list for an empty transcript', () => {
    expect(parseTranscript('')).toEqual([]);
  });
});
