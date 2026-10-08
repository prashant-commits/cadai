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

  it('does not repeat a stand-in note the caller already supplied', () => {
    const spec = standInSpec();
    const supplied = 'bow: drawn as a box (profile polygon is not simple)';
    const { svg } = renderVariantSheet(
      { id: 'A', name: 'stand-in', spec, notes: [supplied] },
      { viewSize: 48 }
    );
    expect(svg.split(supplied).length - 1).toBe(1);
    expect(svg).not.toContain('bow: profile polygon is not simple; drawn as a box');
  });

  it('skips a geometry note when an input note already names that part', () => {
    const standIn = 'bow: drawn as a box (profile polygon is not simple)';
    const standSvg = renderVariantSheet(
      { id: 'A', name: 'stand-in', spec: standInSpec(), notes: [standIn] },
      { viewSize: 48 }
    ).svg;
    expect(standSvg.split(standIn).length - 1).toBe(1);
    expect(standSvg).not.toContain('bow: profile polygon is not simple; drawn as a box');

    const omitted = 'foot: not drawn (localExtents must be positive)';
    const omitSvg = renderVariantSheet(
      { id: 'A', name: 'omit', spec: omittedSpec(), notes: [omitted] },
      { viewSize: 48 }
    ).svg;
    expect(omitSvg.split(omitted).length - 1).toBe(1);
    expect(omitSvg).not.toContain('foot: localExtents must be positive');

    const prefixSvg = renderVariantSheet(
      { id: 'A', name: 'omit', spec: omittedSpec(), notes: ['the footer stays put'] },
      { viewSize: 48 }
    ).svg;
    expect(prefixSvg).toContain('the footer stays put');
    expect(prefixSvg).toContain('foot: localExtents must be positive');
  });

  it('keeps a stand-in note when the caller did not, and never more than three', () => {
    const spec = standInSpec();
    const alone = renderVariantSheet({ id: 'A', name: 'stand-in', spec }, { viewSize: 48 }).svg;
    expect(alone).toContain('bow: profile polygon is not simple; drawn as a box');

    const full = renderVariantSheet(
      { id: 'A', name: 'stand-in', spec, notes: ['keep the tilt', 'mind the span', 'check the post'] },
      { viewSize: 48 }
    ).svg;
    expect(full).toContain('keep the tilt');
    expect(full).toContain('mind the span');
    expect(full).toContain('check the post');
    expect(full).not.toContain('drawn as a box');
  });

  it('prints the guide legend only when the spec has guides', () => {
    const spec = boxSpec();
    spec.guides = [{ label: 'keep_out', kind: 'line', points: [[0, 0, 12], [10, 0, 12]] }];
    const { svg } = renderVariantSheet({ id: 'A', name: 'guided', spec }, { viewSize: 48 });
    expect(svg).toContain('Dashed = guide (not built)');
    expect(svg).not.toContain('Dark discs = holes');
  });

  it('draws a z = 0 ground line across the front, right and iso views', () => {
    const spec = boxSpec();
    spec.components![0].position = [0, 0, 20];
    spec.components![0].localExtents = [10, 8, 6];
    const { svg } = renderVariantSheet({ id: 'A', name: 'raised', spec }, { viewSize: 80 });
    expect(svg.match(/z = 0/g)).toHaveLength(3);

    const cells = [...svg.matchAll(/<image\b[^>]*>/g)].map((match) => ({
      x: attr(match[0], 'x'),
      y: attr(match[0], 'y'),
      s: attr(match[0], 'width'),
    }));
    expect(cells).toHaveLength(4);
    const used = [...svg.matchAll(/<line\b[^>]*stroke="#5a564f"[^>]*>/g)].map((match) => {
      const mx = (attr(match[0], 'x1') + attr(match[0], 'x2')) / 2;
      const my = (attr(match[0], 'y1') + attr(match[0], 'y2')) / 2;
      return cells.findIndex(
        (cell) => mx >= cell.x && mx <= cell.x + cell.s && my >= cell.y && my <= cell.y + cell.s
      );
    });
    expect(used.sort((a, b) => a - b)).toEqual([0, 1, 3]);
  });

  it('rasterizes a name that contains XML-forbidden control characters', async () => {
    const { svg } = renderVariantSheet(
      { id: 'A', name: 'lug\f\x07A', spec: boxSpec() },
      { viewSize: 48 }
    );
    expect(svg).toContain('lugA');
    expect(svg).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    const png = await svgToPngDataUrl(svg);
    expect(png.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('prints the hole legend only when a component declares holes', () => {
    const spec = boxSpec();
    spec.components![0].holes = [{ d: 3, axis: 'z', at: [5, 5, 10] }];
    const { svg } = renderVariantSheet({ id: 'C', name: 'drilled', spec }, { viewSize: 48 });
    expect(svg).toContain('Dark discs = holes');
    expect(svg).not.toContain('Dashed = guide (not built)');
  });
});

function omittedSpec(): AssemblySpec {
  const spec = boxSpec();
  spec.components = [
    {
      name: 'foot',
      description: 'no height',
      localExtents: [10, 10, 0],
      shape: { kind: 'box' },
    },
  ];
  return spec;
}

function standInSpec(): AssemblySpec {
  const spec = boxSpec();
  spec.components = [
    {
      name: 'bow',
      description: 'self-intersecting outline',
      localExtents: [20, 10, 5],
      shape: {
        kind: 'profile',
        plane: 'xy',
        points: [
          [0, 0],
          [20, 10],
          [0, 10],
          [20, 0],
        ],
      },
    },
  ];
  return spec;
}

function attr(tag: string, name: string): number {
  const match = new RegExp(`${name}="([^"]+)"`).exec(tag);
  return Number(match?.[1]);
}

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
