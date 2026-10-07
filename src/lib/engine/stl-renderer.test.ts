import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import {
  renderStlViews,
  parseStlTriangles,
  encodeGrayscalePng,
  renderTriangleViews,
  projectToView,
  type ColoredTriangle,
  type RGB,
  type Vec3,
} from './stl-renderer';

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

/** Mirrors the frame margin in stl-renderer.ts. */
const FRAME_MARGIN = 0.12;

/** Axis-aligned box, wound outward, one flat colour. */
function boxTriangles(
  sx: number,
  sy: number,
  sz: number,
  ox: number,
  oy: number,
  oz: number,
  color: RGB
): ColoredTriangle[] {
  const [x0, y0, z0] = [ox, oy, oz];
  const [x1, y1, z1] = [ox + sx, oy + sy, oz + sz];
  const v: Record<string, Vec3> = {
    a: [x0, y0, z0], b: [x1, y0, z0], c: [x1, y1, z0], d: [x0, y1, z0],
    e: [x0, y0, z1], f: [x1, y0, z1], g: [x1, y1, z1], h: [x0, y1, z1],
  };
  const quads: Array<[string, string, string, string]> = [
    ['a', 'd', 'c', 'b'],
    ['e', 'f', 'g', 'h'],
    ['a', 'b', 'f', 'e'],
    ['c', 'd', 'h', 'g'],
    ['b', 'c', 'g', 'f'],
    ['d', 'a', 'e', 'h'],
  ];
  const tris: ColoredTriangle[] = [];
  for (const [p, q, r, s] of quads) {
    for (const [i, j, k] of [
      [p, q, r],
      [p, r, s],
    ]) {
      tris.push({ a: v[i], b: v[j], c: v[k], color });
    }
  }
  return tris;
}

function pngBytes(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

/** Reads the IHDR of a PNG we encoded. */
function readIhdr(png: Buffer): { width: number; height: number; bitDepth: number; colorType: number } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
  };
}

function decodeRgbPng(png: Buffer): { size: number; pixels: Uint8Array } {
  const ihdr = readIhdr(png);
  expect(ihdr.width).toBe(ihdr.height);
  expect(ihdr.bitDepth).toBe(8);
  expect(ihdr.colorType).toBe(2);

  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === 'IDAT') idat.push(Buffer.from(data));
    offset += len + 12;
  }

  const size = ihdr.width;
  const stride = size * 3;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    expect(raw[y * (stride + 1)]).toBe(0);
    for (let i = 0; i < stride; i++) pixels[y * stride + i] = raw[y * (stride + 1) + 1 + i];
  }
  return { size, pixels };
}

function rgbAt(pixels: Uint8Array, size: number, x: number, y: number): RGB {
  const px = Math.floor(x);
  const py = Math.floor(y);
  expect(px).toBeGreaterThanOrEqual(0);
  expect(py).toBeGreaterThanOrEqual(0);
  expect(px).toBeLessThan(size);
  expect(py).toBeLessThan(size);
  const i = (py * size + px) * 3;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}

function expectRedDominant(pixel: RGB) {
  expect(pixel[0]).toBeGreaterThan(pixel[1]);
  expect(pixel[0]).toBeGreaterThan(pixel[2]);
}

describe('renderTriangleViews', () => {
  const red: RGB = [220, 20, 20];

  it('returns an RGB PNG and a camera for each view of a coloured box', () => {
    const size = 64;
    const box = boxTriangles(20, 20, 20, 0, 0, 0, red);
    const { views, cameras } = renderTriangleViews(box, { size });

    expect(views.map((v) => v.name)).toEqual(['front', 'right', 'top', 'iso']);
    expect(cameras.map((c) => c.name)).toEqual(['front', 'right', 'top', 'iso']);
    expect(new Set(cameras.map((c) => c.scale)).size).toBe(1);

    const centre: Vec3 = [10, 10, 10];
    for (const view of views) {
      expect(view.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
      const png = pngBytes(view.dataUrl);
      const ihdr = readIhdr(png);
      expect(ihdr.width).toBe(size);
      expect(ihdr.height).toBe(size);
      expect(ihdr.bitDepth).toBe(8);
      expect(ihdr.colorType).toBe(2);

      const camera = cameras.find((c) => c.name === view.name);
      expect(camera).toBeDefined();
      const [x, y] = projectToView(camera!, centre);
      const pixel = rgbAt(decodeRgbPng(png).pixels, size, x, y);
      expect(pixel).not.toEqual([BACKGROUND, BACKGROUND, BACKGROUND]);
      if (view.name === 'front' || view.name === 'right' || view.name === 'top') {
        expectRedDominant(pixel);
      }
    }
  });

  it('keeps the nearer box colour when two boxes overlap in the front view', () => {
    const size = 128;
    const near = boxTriangles(20, 10, 20, 40, 0, 40, red);
    const far = boxTriangles(100, 10, 100, 0, 50, 0, [20, 20, 220]);
    const render = (tris: ColoredTriangle[]) => {
      const { views, cameras } = renderTriangleViews(tris, { size, views: ['front'] });
      return { camera: cameras[0], pixels: decodeRgbPng(pngBytes(views[0].dataUrl)).pixels };
    };

    const nearFirst = render([...near, ...far]);
    const farFirst = render([...far, ...near]);

    const nearPixel = rgbAt(nearFirst.pixels, size, ...projectToView(nearFirst.camera, [50, 5, 50]));
    expectRedDominant(nearPixel);

    const farPixel = rgbAt(nearFirst.pixels, size, ...projectToView(nearFirst.camera, [10, 55, 10]));
    expect(farPixel[2]).toBeGreaterThan(farPixel[0]);
    expect(farPixel[2]).toBeGreaterThan(farPixel[1]);

    expect(Buffer.compare(Buffer.from(nearFirst.pixels), Buffer.from(farFirst.pixels))).toBe(0);
  });

  it('fits bounding-box corners inside the frame margin, and extra bounds shrink the scale', () => {
    const size = 64;
    const box = boxTriangles(20, 30, 10, 100, 0, 40, red);
    const { cameras } = renderTriangleViews(box, { size });
    const inset = (size / 2) * FRAME_MARGIN;

    const corners: Vec3[] = [];
    for (const x of [100, 120]) {
      for (const y of [0, 30]) {
        for (const z of [40, 50]) corners.push([x, y, z]);
      }
    }
    expect(corners).toHaveLength(8);

    for (const camera of cameras) {
      const [cx, cy] = projectToView(camera, camera.center);
      expect(cx).toBeCloseTo(size / 2);
      expect(cy).toBeCloseTo(size / 2);

      const [rx, ry] = projectToView(camera, [
        camera.center[0] + camera.right[0],
        camera.center[1] + camera.right[1],
        camera.center[2] + camera.right[2],
      ]);
      expect(rx).toBeGreaterThan(cx);
      expect(ry).toBeCloseTo(cy);

      const [ux, uy] = projectToView(camera, [
        camera.center[0] + camera.up[0],
        camera.center[1] + camera.up[1],
        camera.center[2] + camera.up[2],
      ]);
      expect(ux).toBeCloseTo(cx);
      expect(uy).toBeLessThan(cy);

      for (const corner of corners) {
        const [px, py] = projectToView(camera, corner);
        expect(px).toBeGreaterThanOrEqual(0);
        expect(px).toBeLessThanOrEqual(size);
        expect(py).toBeGreaterThanOrEqual(0);
        expect(py).toBeLessThanOrEqual(size);
        expect(px).toBeGreaterThanOrEqual(inset - 1e-6);
        expect(px).toBeLessThanOrEqual(size - inset + 1e-6);
        expect(py).toBeGreaterThanOrEqual(inset - 1e-6);
        expect(py).toBeLessThanOrEqual(size - inset + 1e-6);
      }
    }

    const outlier: Vec3 = [800, -400, 300];
    const [outsideX, outsideY] = projectToView(cameras[0], outlier);
    expect(outsideX < 0 || outsideX > size || outsideY < 0 || outsideY > size).toBe(true);

    const framed = renderTriangleViews(box, { size, extraBounds: [outlier] });
    expect(framed.cameras[0].scale).toBeLessThan(cameras[0].scale);
    expect(new Set(framed.cameras.map((c) => c.scale)).size).toBe(1);
    for (const camera of framed.cameras) {
      const [px, py] = projectToView(camera, outlier);
      expect(px).toBeGreaterThanOrEqual(inset - 1e-6);
      expect(px).toBeLessThanOrEqual(size - inset + 1e-6);
      expect(py).toBeGreaterThanOrEqual(inset - 1e-6);
      expect(py).toBeLessThanOrEqual(size - inset + 1e-6);
    }
  });

  it('returns nothing when there is no geometry to frame', () => {
    expect(renderTriangleViews([])).toEqual({ views: [], cameras: [] });
  });
});
