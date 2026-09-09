import { deflateSync } from 'zlib';

/**
 * Server-side multi-view renderer for ASCII STL.
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
 * NODE ONLY. Imported by the agent graph; never import from a client component.
 */

export type ViewName = 'front' | 'right' | 'top' | 'iso';

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

type Vec3 = [number, number, number];

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

function renderView(
  tris: Triangle[],
  center: Vec3,
  radius: number,
  eyeDir: Vec3,
  size: number
): Uint8Array {
  const { right, up, forward } = cameraBasis(eyeDir);

  const pixels = new Uint8Array(size * size).fill(BACKGROUND);
  const depth = new Float64Array(size * size).fill(Infinity);

  // One shared scale across every view, derived from the bounding sphere, so
  // the four images are directly comparable - a part that looks small from the
  // top really is small.
  const scale = radius > 0 ? ((size / 2) * (1 - MARGIN)) / radius : 1;
  const half = size / 2;

  // Light sits up and to the left of the camera. A pure headlight
  // (light along the view axis) flattens every face to the same value and
  // erases exactly the form we are trying to show.
  const light = norm([-0.4, 0.6, -1]);

  for (const tri of tris) {
    const local: Vec3[] = [sub(tri.a, center), sub(tri.b, center), sub(tri.c, center)];

    // View space: x right, y up, z into the screen.
    const view = local.map((p): Vec3 => [dot(p, right), dot(p, up), dot(p, forward)]);

    const n = norm(cross(sub(view[1], view[0]), sub(view[2], view[0])));
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue; // degenerate

    // Back faces are NOT culled: on a closed solid the z-buffer hides them
    // anyway, and on a broken one seeing the interior is the point. Flip the
    // normal toward the camera so such faces still shade sensibly.
    const facing: Vec3 = n[2] > 0 ? [-n[0], -n[1], -n[2]] : n;
    const intensity = AMBIENT + (1 - AMBIENT) * Math.max(0, dot(facing, light));
    const shade = Math.max(0, Math.min(255, Math.round(40 + intensity * 215)));

    // Screen space. Y is negated because image rows run downward.
    const sx = view.map((p) => half + p[0] * scale);
    const sy = view.map((p) => half - p[1] * scale);

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
          pixels[idx] = shade;
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
    for (let i = 0; i < pixels.length; i++) {
      if (depth[i] === Infinity) continue;
      const t = (depth[i] - nearest) / span; // 0 near, 1 far
      const lit = pixels[i] * (1 - DEPTH_CUE * t);
      pixels[i] = Math.max(0, Math.min(255, Math.round(lit)));
    }
  }

  return pixels;
}

// ---- Minimal PNG encoder (grayscale, 8-bit) ----

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

/**
 * Renders an ASCII STL from several fixed angles.
 *
 * Returns an empty array when the mesh has no triangles, so callers can treat
 * "nothing to look at" as a normal outcome rather than an error.
 */
export function renderStlViews(stl: string, opts: RenderOptions = {}): RenderedView[] {
  const size = opts.size ?? DEFAULT_SIZE;
  const views = opts.views ?? DEFAULT_VIEWS;

  const tris = parseStlTriangles(stl);
  if (tris.length === 0) return [];

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const v of [t.a, t.b, t.c]) {
      for (let i = 0; i < 3; i++) {
        if (v[i] < min[i]) min[i] = v[i];
        if (v[i] > max[i]) max[i] = v[i];
      }
    }
  }

  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];

  let radius = 0;
  for (const t of tris) {
    for (const v of [t.a, t.b, t.c]) {
      const d = Math.hypot(v[0] - center[0], v[1] - center[1], v[2] - center[2]);
      if (d > radius) radius = d;
    }
  }

  return views.map((name) => {
    const pixels = renderView(tris, center, radius, EYE_DIRECTIONS[name], size);
    const png = encodeGrayscalePng(pixels, size);
    return { name, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
  });
}
