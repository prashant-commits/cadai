import { deflateSync } from 'zlib';

/**
 * Server-side multi-view renderer for ASCII STL and coloured triangle lists.
 *
 * Exists because nothing in the stack can produce an image of the geometry:
 * the bundled openscad-wasm has no PNG path (no `--imgsize`, no lodepng, no
 * OffscreenContext), and three.js is browser-only here. Every accuracy check in
 * the pipeline measures NUMBERS about the mesh - bbox, volume, manifoldness,
 * shell count - so a part that is the right size and watertight but shaped
 * wrong (arm reversed, hole on the wrong face, lid rotated 90 degrees) passes
 * everything and ships.
 *
 * Deliberately a pure-TypeScript software rasterizer rather than a headless GL
 * dependency: no native build, no browser to drive, runs synchronously inside
 * the agent graph on any Node runtime. Flat-shaded orthographic silhouettes are
 * also the right output for this job - a vision model judging "is this the part
 * that was asked for" is helped by clean unambiguous form, not by materials.
 *
 * The coloured path (`renderTriangleViews`) uses the same camera, scale, and
 * pixel mapping as the grayscale STL path, and returns that camera so a vector
 * overlay can land on the pixel the raster already chose.
 *
 * NODE ONLY. Imported by the agent graph; never import from a client component.
 */

export type ViewName = 'front' | 'right' | 'top' | 'iso';

export type Vec3 = [number, number, number];

/** 0..255 per channel. */
export type RGB = [number, number, number];

export interface RenderedView {
  name: ViewName;
  /** `data:image/png;base64,...`, ready for a multimodal content block. */
  dataUrl: string;
}

export interface RenderOptions {
  /** Square edge length in pixels. */
  size?: number;
  views?: ViewName[];
}

export interface ColoredTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  color: RGB;
}

export interface ViewCamera {
  name: ViewName;
  /** Square edge in px. */
  size: number;
  /** World point at the image centre. */
  center: Vec3;
  /** px per mm. Identical for every view of one render. */
  scale: number;
  /** Orthonormal basis used for this view. */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

export interface TriangleViewOptions {
  /** Square edge length in pixels. */
  size?: number;
  views?: ViewName[];
  /** RGB background. Defaults to the grayscale renderer's dark field. */
  background?: RGB;
  /**
   * World points that must fit in the frame (guide geometry drawn later as an
   * overlay). They enlarge the bounding sphere used for centre and scale, and
   * are not drawn.
   */
  extraBounds?: Vec3[];
}

interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

const DEFAULT_SIZE = 512;
const DEFAULT_VIEWS: ViewName[] = ['front', 'right', 'top', 'iso'];

/** Fraction of the frame left empty around the model. */
const MARGIN = 0.12;

const BACKGROUND = 26;
const AMBIENT = 0.22;

/**
 * How much nearer surfaces are brightened relative to far ones.
 *
 * Flat shading alone gives two parallel faces the same value no matter how far
 * apart they are, so an orthographic view of a stepped part collapses into one
 * silhouette with no readable boundary - and "is the hole on the near face or
 * the far one" is precisely the question these renders exist to answer.
 */
const DEPTH_CUE = 0.4;

/** Direction from the model toward the eye, per view. */
const EYE_DIRECTIONS: Record<ViewName, Vec3> = {
  front: [0, -1, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
  iso: [1, -1, 0.75],
};

const DEFAULT_RGB_BACKGROUND: RGB = [BACKGROUND, BACKGROUND, BACKGROUND];

function sub(p: Vec3, q: Vec3): Vec3 {
  return [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
}
function cross(p: Vec3, q: Vec3): Vec3 {
  return [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ];
}
function dot(p: Vec3, q: Vec3): number {
  return p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
}
function norm(p: Vec3): Vec3 {
  const len = Math.hypot(p[0], p[1], p[2]);
  if (len === 0) return [0, 0, 0];
  return [p[0] / len, p[1] / len, p[2] / len];
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, n));
}

/**
 * Pulls triangles out of ASCII STL.
 *
 * Face normals in the file are ignored on purpose - OpenSCAD's exporter is
 * reliable, but a repair-loop mesh may be malformed in exactly the ways worth
 * seeing, and a normal recomputed from the winding never disagrees with the
 * triangle actually being drawn.
 */
export function parseStlTriangles(stl: string): Triangle[] {
  const tris: Triangle[] = [];
  let pending: Vec3[] = [];

  for (const rawLine of stl.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('vertex')) {
      if (line.startsWith('endfacet')) pending = [];
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const v: Vec3 = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
    if (v.some((n) => !Number.isFinite(n))) continue;
    pending.push(v);
    if (pending.length === 3) {
      tris.push({ a: pending[0], b: pending[1], c: pending[2] });
      pending = [];
    }
  }

  return tris;
}

/** Orthonormal camera basis for a view direction. */
function cameraBasis(eyeDir: Vec3): { right: Vec3; up: Vec3; forward: Vec3 } {
  const forward = norm([-eyeDir[0], -eyeDir[1], -eyeDir[2]]);
  // World +Z is up, except looking straight down it is degenerate.
  const worldUp: Vec3 = Math.abs(forward[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(forward, worldUp));
  const up = cross(right, forward);
  return { right, up, forward };
}

function toView(camera: ViewCamera, p: Vec3): Vec3 {
  const d = sub(p, camera.center);
  return [dot(d, camera.right), dot(d, camera.up), dot(d, camera.forward)];
}

/**
 * Projects a world point (mm) to image pixel coordinates [x, y] (y grows
 * downward) for this view. The rasterizer calls this, and only this, so an
 * overlay that uses it lands on the same pixel.
 */
export function projectToView(camera: ViewCamera, p: Vec3): [number, number] {
  const v = toView(camera, p);
  const half = camera.size / 2;
  return [half + v[0] * camera.scale, half - v[1] * camera.scale];
}

function boundingSphere(points: Vec3[]): { center: Vec3; radius: number } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of points) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  }

  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];

  let radius = 0;
  for (const v of points) {
    const d = Math.hypot(v[0] - center[0], v[1] - center[1], v[2] - center[2]);
    if (d > radius) radius = d;
  }

  return { center, radius };
}

function frameScale(radius: number, size: number): number {
  // One shared scale across every view, derived from the bounding sphere, so
  // the images are directly comparable - a part that looks small from the top
  // really is small.
  return radius > 0 ? ((size / 2) * (1 - MARGIN)) / radius : 1;
}

function makeCamera(name: ViewName, center: Vec3, scale: number, size: number): ViewCamera {
  const { right, up, forward } = cameraBasis(EYE_DIRECTIONS[name]);
  return {
    name,
    size,
    center: [center[0], center[1], center[2]],
    scale,
    right,
    up,
    forward,
  };
}

function frameCameras(points: Vec3[], size: number, viewNames: ViewName[]): ViewCamera[] {
  const { center, radius } = boundingSphere(points);
  const scale = frameScale(radius, size);
  return viewNames.map((name) => makeCamera(name, center, scale, size));
}

interface RasterOptions {
  mode: 'gray' | 'rgb';
  background: RGB;
}

/**
 * Flat-shaded z-buffer. Grayscale keeps the STL critic's ramp
 * (`40 + intensity * 215`) and the full depth cue. Colour uses a brighter
 * ramp (`color * (0.5 + 0.5 * intensity)`) and half that depth cue, so a
 * face turned away from the light still reads as its legend hue.
 */
function rasterize(
  tris: { a: Vec3; b: Vec3; c: Vec3; color?: RGB }[],
  camera: ViewCamera,
  opts: RasterOptions
): Uint8Array {
  const { size } = camera;
  const channels = opts.mode === 'gray' ? 1 : 3;
  const pixels = new Uint8Array(size * size * channels);
  if (channels === 1) {
    pixels.fill(opts.background[0]);
  } else {
    for (let i = 0; i < size * size; i++) {
      pixels[i * 3] = opts.background[0];
      pixels[i * 3 + 1] = opts.background[1];
      pixels[i * 3 + 2] = opts.background[2];
    }
  }
  const depth = new Float64Array(size * size).fill(Infinity);

  // Light sits up and to the left of the camera. A pure headlight
  // (light along the view axis) flattens every face to the same value and
  // erases exactly the form we are trying to show.
  const light = norm([-0.4, 0.6, -1]);

  for (const tri of tris) {
    const view = [tri.a, tri.b, tri.c].map((p) => toView(camera, p));
    const screen = [tri.a, tri.b, tri.c].map((p) => projectToView(camera, p));
    const sx = [screen[0][0], screen[1][0], screen[2][0]];
    const sy = [screen[0][1], screen[1][1], screen[2][1]];

    const n = norm(cross(sub(view[1], view[0]), sub(view[2], view[0])));
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue; // degenerate

    // Back faces are NOT culled: on a closed solid the z-buffer hides them
    // anyway, and on a broken one seeing the interior is the point. Flip the
    // normal toward the camera so such faces still shade sensibly.
    const facing: Vec3 = n[2] > 0 ? [-n[0], -n[1], -n[2]] : n;
    const intensity = AMBIENT + (1 - AMBIENT) * Math.max(0, dot(facing, light));

    let shaded: RGB;
    if (opts.mode === 'gray') {
      const shade = clampByte(Math.round(40 + intensity * 215));
      shaded = [shade, shade, shade];
    } else {
      const color = tri.color ?? DEFAULT_RGB_BACKGROUND;
      const lit = 0.5 + 0.5 * intensity;
      shaded = [
        clampByte(Math.round(color[0] * lit)),
        clampByte(Math.round(color[1] * lit)),
        clampByte(Math.round(color[2] * lit)),
      ];
    }

    const minX = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
    const minY = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
    if (minX > maxX || minY > maxY) continue;

    // Edge functions / barycentric rasterization.
    const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
    if (Math.abs(area) < 1e-12) continue;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;

        const w0 = ((sx[1] - px) * (sy[2] - py) - (sx[2] - px) * (sy[1] - py)) / area;
        const w1 = ((sx[2] - px) * (sy[0] - py) - (sx[0] - px) * (sy[2] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        const z = w0 * view[0][2] + w1 * view[1][2] + w2 * view[2][2];
        const idx = y * size + x;
        if (z < depth[idx]) {
          depth[idx] = z;
          if (channels === 1) {
            pixels[idx] = shaded[0];
          } else {
            pixels[idx * 3] = shaded[0];
            pixels[idx * 3 + 1] = shaded[1];
            pixels[idx * 3 + 2] = shaded[2];
          }
        }
      }
    }
  }

  // Depth cue pass. Normalised across whatever was actually drawn, so the full
  // contrast range is used no matter how deep the part is.
  let nearest = Infinity;
  let furthest = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (d === Infinity) continue;
    if (d < nearest) nearest = d;
    if (d > furthest) furthest = d;
  }

  const span = furthest - nearest;
  if (span > 1e-9) {
    for (let i = 0; i < size * size; i++) {
      if (depth[i] === Infinity) continue;
      const t = (depth[i] - nearest) / span; // 0 near, 1 far
      if (channels === 1) {
        const factor = 1 - DEPTH_CUE * t;
        pixels[i] = clampByte(Math.round(pixels[i] * factor));
      } else {
        const factor = 1 - (DEPTH_CUE / 2) * t;
        for (let c = 0; c < 3; c++) {
          const o = i * 3 + c;
          pixels[o] = clampByte(Math.round(pixels[o] * factor));
        }
      }
    }
  }

  return pixels;
}

// ---- Minimal PNG encoder (grayscale 8-bit, and RGB 8-bit colour type 2) ----

let crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encodes an 8-bit grayscale raster as a PNG. */
export function encodeGrayscalePng(pixels: Uint8Array, size: number): Buffer {
  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * size, size).copy(
      raw,
      y * (size + 1) + 1
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0 = grayscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Encodes an 8-bit RGB raster as a PNG (colour type 2). */
function encodeRgbPng(pixels: Uint8Array, size: number): Buffer {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolor
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function scenePoints(tris: { a: Vec3; b: Vec3; c: Vec3 }[], extraBounds?: Vec3[]): Vec3[] {
  const points: Vec3[] = [];
  for (const t of tris) points.push(t.a, t.b, t.c);
  if (extraBounds) points.push(...extraBounds);
  return points;
}

/**
 * Renders coloured triangles from several fixed angles.
 *
 * Returns RGB PNGs plus the cameras used, so callers can overlay vector
 * graphics on the same pixels. An empty triangle list with no extra bounds
 * yields no views.
 */
export function renderTriangleViews(
  tris: ColoredTriangle[],
  opts: TriangleViewOptions = {}
): { views: RenderedView[]; cameras: ViewCamera[] } {
  const size = opts.size ?? DEFAULT_SIZE;
  const viewNames = opts.views ?? DEFAULT_VIEWS;
  const background = opts.background ?? DEFAULT_RGB_BACKGROUND;
  const points = scenePoints(tris, opts.extraBounds);
  if (points.length === 0) return { views: [], cameras: [] };

  const cameras = frameCameras(points, size, viewNames);
  const views = cameras.map((camera) => {
    const pixels = rasterize(tris, camera, { mode: 'rgb', background });
    const png = encodeRgbPng(pixels, size);
    return { name: camera.name, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  });

  return { views, cameras };
}

/**
 * Renders an ASCII STL from several fixed angles.
 *
 * Returns an empty array when the mesh has no triangles, so callers can treat
 * "nothing to look at" as a normal outcome rather than an error.
 */
export function renderStlViews(stl: string, opts: RenderOptions = {}): RenderedView[] {
  const size = opts.size ?? DEFAULT_SIZE;
  const viewNames = opts.views ?? DEFAULT_VIEWS;

  const tris = parseStlTriangles(stl);
  if (tris.length === 0) return [];

  const cameras = frameCameras(scenePoints(tris), size, viewNames);
  return cameras.map((camera) => {
    const pixels = rasterize(tris, camera, { mode: 'gray', background: DEFAULT_RGB_BACKGROUND });
    const png = encodeGrayscalePng(pixels, size);
    return { name: camera.name, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  });
}
