import { describe, expect, it } from 'vitest';
import type { AssemblySpec } from '../agent/assembly-spec';
import { svgToPngDataUrl } from './rasterize';
import { fixtureSpec } from './fixtures';
import { renderVariantSheet } from './sheet-svg';

function assertWellFormedSvg(svg: string) {
  expect(svg.trim().startsWith('<svg')).toBe(true);
  expect(svg.trim().endsWith('</svg>')).toBe(true);
  const tags = svg.match(/<\/?[^>]+>/g);
  expect(tags).not.toBeNull();
  const stack: string[] = [];
  let roots = 0;
  for (const tag of tags ?? []) {
    if (tag.startsWith('<!')) continue;
    if (tag.startsWith('</')) {
      const name = /^<\/\s*([A-Za-z0-9]+)/.exec(tag)?.[1];
      expect(stack.pop()).toBe(name);
      continue;
    }
    const name = /^<\s*([A-Za-z0-9]+)/.exec(tag)?.[1];
    expect(name).toBeTruthy();
    if (name === 'svg') roots += 1;
    if (tag.endsWith('/>')) continue;
    stack.push(name!);
  }
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
}

describe('renderVariantSheet', () => {
  it('draws an escaped sheet with four views, dimensions and a dashed path per guide', async () => {
    const spec = fixtureSpec();
    spec.guides = [
      ...spec.guides,
      { label: 'gap <1> & "x"', kind: 'line', points: [[0, 0, 1], [10, 0, 1]] },
    ];
    const { svg } = renderVariantSheet(
      {
        id: 'A',
        name: 'lug <A> & "b"',
        idea: 'a <bold> idea',
        spec,
        notes: ['watch the "edge"'],
      },
      { viewSize: 72 }
    );

    assertWellFormedSvg(svg);
    expect(svg.match(/<image\b/g)).toHaveLength(4);
    expect(svg).toContain('A - lug &lt;A&gt; &amp; &quot;b&quot;');
    expect(svg).toContain('a &lt;bold&gt; idea');
    expect(svg).toContain('watch the &quot;edge&quot;');
    expect(svg).toContain('gap &lt;1&gt; &amp; &quot;x&quot;');
    expect(svg).toContain('130 x 50 x 42 mm');
    expect(svg).toContain('FRONT');
    expect(svg).toContain('RIGHT');
    expect(svg).toContain('TOP');
    expect(svg).toContain('ISO');
    expect(svg).toContain('Dashed = guide (not built)');
    expect(svg).toContain('Dark discs = holes');
    expect(svg.match(/stroke-dasharray="6 4"/g)).toHaveLength(spec.guides.length * 4);
    expect(svg).toContain('font-family="DejaVu Sans, Arial, sans-serif"');
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/\shref="https?:/i);

    const textOnly = svg.replace(/<[^>]*>/g, '');
    expect(textOnly).not.toMatch(/[<>]/);

    const sizes = [...svg.matchAll(/font-size="([0-9.]+)"/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11);

    const png = await svgToPngDataUrl(svg);
    expect(png.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('uses a 320 px view and keeps text at least 11 px by default', () => {
    const { svg } = renderVariantSheet({ id: 'B', name: 'plain', spec: boxSpec() });
    expect(svg).not.toContain('Dashed = guide (not built)');
    expect(svg).not.toContain('Dark discs = holes');
    expect(svg.match(/<image\b[^>]*width="320"/g)).toHaveLength(4);
    const sizes = [...svg.matchAll(/font-size="([0-9.]+)"/g)].map((match) => Number(match[1]));
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(11);
  });

  it('prints the guide legend only when the spec has guides', () => {
    const spec = boxSpec();
    spec.guides = [{ label: 'keep_out', kind: 'line', points: [[0, 0, 12], [10, 0, 12]] }];
    const { svg } = renderVariantSheet({ id: 'A', name: 'guided', spec }, { viewSize: 48 });
    expect(svg).toContain('Dashed = guide (not built)');
    expect(svg).not.toContain('Dark discs = holes');
  });

  it('prints the hole legend only when a component declares holes', () => {
    const spec = boxSpec();
    spec.components![0].holes = [{ d: 3, axis: 'z', at: [5, 5, 10] }];
    const { svg } = renderVariantSheet({ id: 'C', name: 'drilled', spec }, { viewSize: 48 });
    expect(svg).toContain('Dark discs = holes');
    expect(svg).not.toContain('Dashed = guide (not built)');
  });
});

function boxSpec(): AssemblySpec {
  return {
    sheet: '',
    assemblyName: 'one',
    boundingBox: { width: 10, length: 10, height: 10 },
    components: [
      {
        name: 'block',
        description: 'box',
        localExtents: [10, 10, 10],
        position: [0, 0, 0],
        shape: { kind: 'box' },
      },
    ],
    guides: [],
    stressPoints: [],
    assumptions: [],
    openQuestions: [],
  };
}
