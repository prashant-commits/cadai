import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { renderStlViews, parseStlTriangles, encodeGrayscalePng } from './stl-renderer';

/** ASCII STL for an axis-aligned box, wound outward. */
function boxStl(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): string {
  const [x0, y0, z0] = [ox, oy, oz];
  const [x1, y1, z1] = [ox + sx, oy + sy, oz + sz];
  const v = {
    a: [x0, y0, z0], b: [x1, y0, z0], c: [x1, y1, z0], d: [x0, y1, z0],
    e: [x0, y0, z1], f: [x1, y0, z1], g: [x1, y1, z1], h: [x0, y1, z1],
  } as Record<string, number[]>;

  const quads: Array<[string, string, string, string]> = [
    ['a', 'd', 'c', 'b'], // bottom (-Z)
    ['e', 'f', 'g', 'h'], // top (+Z)
    ['a', 'b', 'f', 'e'], // -Y
    ['c', 'd', 'h', 'g'], // +Y
    ['b', 'c', 'g', 'f'], // +X
    ['d', 'a', 'e', 'h'], // -X
  ];

  const facets: string[] = [];
  for (const [p, q, r, s] of quads) {
    for (const [i, j, k] of [[p, q, r], [p, r, s]]) {
      facets.push(
        `facet normal 0 0 0\n outer loop\n${[i, j, k]
          .map((key) => `  vertex ${v[key].join(' ')}`)
          .join('\n')}\n endloop\nendfacet`
      );
    }
  }
  return `solid test\n${facets.join('\n')}\nendsolid test`;
}

/** Concatenates the facets of several solids into one, in the order given. */
function mergeStl(...solids: string[]): string {
  const facets = solids
    .map((s) =>
      s
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('solid') && !l.trimStart().startsWith('endsolid'))
        .join('\n')
    )
    .join('\n');
  return `solid merged\n${facets}\nendsolid merged`;
}

/** Decodes our own PNG back to a raster so tests assert on pixels, not bytes. */
function decodeGrayscalePng(png: Buffer): { size: number; pixels: Uint8Array } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  let offset = 8;
  let size = 0;
  const idat: Buffer[] = [];

  while (offset < png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      size = data.readUInt32BE(0);
      expect(data.readUInt32BE(4)).toBe(size);
      expect(data[8]).toBe(8); // 8-bit
      expect(data[9]).toBe(0); // grayscale
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    }
    offset += len + 12;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    // Skip the per-scanline filter byte; the encoder always writes filter 0.
    expect(raw[y * (size + 1)]).toBe(0);
    for (let x = 0; x < size; x++) pixels[y * size + x] = raw[y * (size + 1) + 1 + x];
  }
  return { size, pixels };
}

const BACKGROUND = 26;

describe('parseStlTriangles', () => {
  it('reads every facet of an ASCII STL', () => {
    // 6 faces x 2 triangles.
    expect(parseStlTriangles(boxStl(10, 10, 10))).toHaveLength(12);
  });

  it('returns nothing for a mesh with no vertices', () => {
    expect(parseStlTriangles('solid empty\nendsolid empty')).toHaveLength(0);
  });

  it('does not fuse vertices across facet boundaries', () => {
    // A truncated facet must not have its vertices absorbed into the next one.
    const stl = [
      'solid s',
      'facet normal 0 0 1',
      ' outer loop',
      '  vertex 0 0 0',
      '  vertex 1 0 0',
      ' endloop',
      'endfacet',
      'facet normal 0 0 1',
      ' outer loop',
      '  vertex 0 0 0',
      '  vertex 1 0 0',
      '  vertex 0 1 0',
      ' endloop',
      'endfacet',
      'endsolid s',
    ].join('\n');
    const tris = parseStlTriangles(stl);
    expect(tris).toHaveLength(1);
    expect(tris[0].c).toEqual([0, 1, 0]);
  });
});

describe('encodeGrayscalePng', () => {
  it('round-trips a raster through a real PNG decode', () => {
    const size = 4;
    const pixels = new Uint8Array(size * size);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i * 16;

    const decoded = decodeGrayscalePng(encodeGrayscalePng(pixels, size));
    expect(decoded.size).toBe(size);
    expect([...decoded.pixels]).toEqual([...pixels]);
  });
});

describe('renderStlViews', () => {
  it('produces one decodable PNG per requested view', () => {
    const views = renderStlViews(boxStl(20, 20, 20), { size: 64 });

    expect(views.map((v) => v.name)).toEqual(['front', 'right', 'top', 'iso']);
    for (const view of views) {
      expect(view.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
      const png = Buffer.from(view.dataUrl.split(',')[1], 'base64');
      const { size, pixels } = decodeGrayscalePng(png);
      expect(size).toBe(64);
      // The model actually got drawn.
      expect(pixels.some((p) => p !== BACKGROUND)).toBe(true);
    }
  });

  it('returns nothing when there is no geometry', () => {
    expect(renderStlViews('solid empty\nendsolid empty')).toEqual([]);
  });

  it('centres the model and leaves a margin', () => {
    // Offset far from the origin: the camera must follow the model, not sit at
    // world zero, or an off-origin part renders blank.
    const views = renderStlViews(boxStl(20, 20, 20, 500, -300, 900), { size: 64 });
    const { pixels } = decodeGrayscalePng(Buffer.from(views[0].dataUrl.split(',')[1], 'base64'));

    // Centre is covered...
    expect(pixels[32 * 64 + 32]).not.toBe(BACKGROUND);
    // ...and all four corners are still background.
    for (const idx of [0, 63, 63 * 64, 63 * 64 + 63]) {
      expect(pixels[idx]).toBe(BACKGROUND);
    }
  });

  it('distinguishes shapes that differ only along one axis', () => {
    // A tall slab and a wide slab have identical top views but must differ
    // from the front - this is the whole point of rendering more than one.
    const tall = renderStlViews(boxStl(10, 10, 60), { size: 64, views: ['front'] });
    const wide = renderStlViews(boxStl(60, 10, 10), { size: 64, views: ['front'] });

    const a = decodeGrayscalePng(Buffer.from(tall[0].dataUrl.split(',')[1], 'base64')).pixels;
    const b = decodeGrayscalePng(Buffer.from(wide[0].dataUrl.split(',')[1], 'base64')).pixels;
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
  });

  it('shades faces differently rather than flooding one flat value', () => {
    // The iso view sees three faces at once; if they all render identically the
    // lighting is broken and the image carries no form.
    const [iso] = renderStlViews(boxStl(20, 20, 20), { size: 96, views: ['iso'] });
    const { pixels } = decodeGrayscalePng(Buffer.from(iso.dataUrl.split(',')[1], 'base64'));

    const shades = new Set(pixels.filter((p) => p !== BACKGROUND));
    expect(shades.size).toBeGreaterThanOrEqual(3);
  });

  it('resolves occlusion independently of draw order', () => {
    // Two boxes at different depths. A depth buffer makes the result identical
    // whichever is written first; without one, the last triangle drawn wins and
    // swapping the order changes the image.
    const near = boxStl(6, 6, 6, -3, -40, -3);
    const far = boxStl(40, 6, 40, -20, 30, -20);

    const nearFirst = mergeStl(near, far);
    const farFirst = mergeStl(far, near);

    const render = (stl: string) =>
      decodeGrayscalePng(
        Buffer.from(
          renderStlViews(stl, { size: 96, views: ['front'] })[0].dataUrl.split(',')[1],
          'base64'
        )
      ).pixels;

    const a = render(nearFirst);
    const b = render(farFirst);

    // Something is actually in front of something else.
    expect(a[48 * 96 + 48]).not.toBe(BACKGROUND);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });
});
