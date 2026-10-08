import type { AssemblySpec } from '../agent/assembly-spec';
import {
  projectToView,
  renderTriangleViews,
  type Vec3,
  type ViewCamera,
  type ViewName,
} from '../engine/stl-renderer';
import { guideGeometry, specGeometry } from './geometry';

/**
 * One concept sheet for a variant: four rendered views, dashed guides,
 * overall dimensions, a part legend and up to three notes.
 */

export interface SheetInput {
  id: 'A' | 'B' | 'C';
  name: string;
  idea?: string;
  spec: AssemblySpec;
  notes?: string[];
}

const VIEWS: ViewName[] = ['front', 'right', 'top', 'iso'];
const CAPTION: Record<ViewName, string> = {
  front: 'FRONT',
  right: 'RIGHT',
  top: 'TOP',
  iso: 'ISO',
};

const FONT = {
  title: 20,
  size: 14,
  idea: 13,
  caption: 12,
  legend: 13,
  note: 12,
  dim: 12,
  guide: 11,
} as const;

const FAMILY = 'DejaVu Sans, Arial, sans-serif';

/** Solid dark grey, distinct from dimension ink and dashed guides. */
const GROUND_STROKE = '#5a564f';
/** How far the ground line runs past the footprint, so it is not hidden on the silhouette. */
const GROUND_PAD = 0.18;

export function renderVariantSheet(
  input: SheetInput,
  opts?: { viewSize?: number }
): { svg: string; skipped: { name: string; reason: string }[] } {
  const viewSize = opts?.viewSize ?? 320;
  const geo = specGeometry(input.spec);
  const guides = guideGeometry(input.spec);
  const guidePoints = guides.flatMap((guide) => guide.polylines.flat());
  const ground = groundSegment(geo.bounds);
  const rendered = renderTriangleViews(geo.tris, {
    size: viewSize,
    views: VIEWS,
    background: [255, 255, 255],
    extraBounds: [...guidePoints, ground[0], ground[1]],
  });

  const idea = input.idea?.trim() ?? '';
  const legendLines = [
    ...(input.spec.guides?.length ? ['Dashed = guide (not built)'] : []),
    ...((input.spec.components ?? []).some((component) => (component.holes?.length ?? 0) > 0)
      ? ['Dark discs = holes']
      : []),
  ];
  const notes = [
    ...(input.notes ?? []).map((note) => note.trim()).filter((note) => note.length > 0),
    ...geo.skipped.map((item) => `${item.name}: ${item.reason}`),
  ].slice(0, 3);

  const margin = 28;
  const colGap = 40;
  const rowGap = 24;
  const captionH = 22;
  const titleH = idea ? 92 : 70;
  const legendRows = geo.parts.length + legendLines.length;
  const legendH = 12 + legendRows * 22;
  const notesH = notes.length > 0 ? 8 + notes.length * 20 : 0;
  const gridW = viewSize * 2 + colGap;
  const gridH = (viewSize + captionH) * 2 + rowGap;
  const width = margin * 2 + gridW;
  const height = titleH + gridH + legendH + notesH + margin;

  const bounds = geo.bounds;
  const span = {
    x: bounds ? bounds.max[0] - bounds.min[0] : 0,
    y: bounds ? bounds.max[1] - bounds.min[1] : 0,
    z: bounds ? bounds.max[2] - bounds.min[2] : 0,
  };
  const sizeLine = `${mm(span.x)} x ${mm(span.y)} x ${mm(span.z)} mm`;
  const dims: Record<ViewName, { axis: 'x' | 'y' | 'z'; text: string }[]> = {
    front: [
      { axis: 'x', text: mm(span.x) },
      { axis: 'z', text: mm(span.z) },
    ],
    right: [
      { axis: 'y', text: mm(span.y) },
      { axis: 'z', text: mm(span.z) },
    ],
    top: [
      { axis: 'x', text: mm(span.x) },
      { axis: 'y', text: mm(span.y) },
    ],
    iso: [],
  };

  const body: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FAMILY}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#f4f2ee"/>`,
    `<rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#d9d4cc" stroke-width="1"/>`,
    text(margin, 36, FONT.title, `${input.id} - ${input.name}`, 'font-weight="600" fill="#1c1b19"'),
    text(margin, 58, FONT.size, sizeLine, 'fill="#3c3a36"'),
  ];
  if (idea) body.push(text(margin, 80, FONT.idea, idea, 'font-style="italic" fill="#5c5852"'));

  VIEWS.forEach((name, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = margin + col * (viewSize + colGap);
    const y = titleH + row * (viewSize + captionH + rowGap);
    const view = rendered.views[index];
    const camera = rendered.cameras[index];
    if (view) {
      body.push(
        `<image href="${view.dataUrl}" x="${n(x)}" y="${n(y)}" width="${viewSize}" height="${viewSize}"/>`
      );
    }
    body.push(
      text(x + viewSize / 2, y + viewSize + 16, FONT.caption, CAPTION[name], 'text-anchor="middle" fill="#3a3834"')
    );
    if (!camera) return;

    if (name === 'front' || name === 'right' || name === 'iso') {
      body.push(groundLine(camera, ground, x, y));
    }

    for (const guide of guides) {
      const d = guidePath(guide.polylines, camera, x, y);
      if (!d) continue;
      body.push(
        `<path d="${d}" fill="none" stroke="#8a8680" stroke-width="1.25" stroke-dasharray="6 4"/>`
      );
      const origin = guide.polylines[0]?.[0];
      if (!origin) continue;
      const [lx, ly] = projectToView(camera, origin);
      body.push(
        text(
          x + lx + 6,
          y + ly - 12,
          FONT.guide,
          guide.label,
          'fill="#3a3834" stroke="#ffffff" stroke-width="3" paint-order="stroke"'
        )
      );
    }

    if (!bounds) return;
    const box = projectBounds(camera, bounds, x, y);
    for (const dim of dims[name]) {
      body.push(dimension(box, aligns(camera.right, dim.axis), dim.text, x, y, viewSize));
    }
  });

  let legendY = titleH + gridH + 8;
  geo.parts.forEach((part, index) => {
    const y = legendY + index * 22;
    const [r, g, b] = part.color;
    body.push(`<rect x="${margin}" y="${y}" width="12" height="12" fill="rgb(${r},${g},${b})"/>`);
    body.push(text(margin + 20, y + 11, FONT.legend, part.name, 'fill="#1c1b19"'));
  });
  legendY += geo.parts.length * 22;
  legendLines.forEach((line, index) => {
    body.push(text(margin, legendY + 12 + index * 22, FONT.legend, line, 'fill="#5e5a54"'));
  });

  notes.forEach((note, index) => {
    const y = titleH + gridH + legendH + index * 20;
    body.push(text(margin, y, FONT.note, note, 'fill="#3c3a36"'));
  });

  body.push('</svg>');
  return { svg: body.join('\n'), skipped: geo.skipped };
}

/** A z = 0 segment across the footprint. A diagonal reads as a horizontal line in front and right. */
function groundSegment(bounds: { min: Vec3; max: Vec3 } | null): [Vec3, Vec3] {
  if (!bounds) return [[-20, -20, 0], [20, 20, 0]];
  const spanX = Math.max(bounds.max[0] - bounds.min[0], 1);
  const spanY = Math.max(bounds.max[1] - bounds.min[1], 1);
  const padX = spanX * GROUND_PAD;
  const padY = spanY * GROUND_PAD;
  return [
    [bounds.min[0] - padX, bounds.min[1] - padY, 0],
    [bounds.max[0] + padX, bounds.max[1] + padY, 0],
  ];
}

function groundLine(camera: ViewCamera, segment: [Vec3, Vec3], ox: number, oy: number): string {
  const [ax, ay] = projectToView(camera, segment[0]);
  const [bx, by] = projectToView(camera, segment[1]);
  const x1 = ox + ax;
  const y1 = oy + ay;
  const x2 = ox + bx;
  const y2 = oy + by;
  return [
    `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${GROUND_STROKE}" stroke-width="1"/>`,
    text(
      (x1 + x2) / 2,
      (y1 + y2) / 2 - 10,
      FONT.guide,
      'z = 0',
      `text-anchor="middle" fill="${GROUND_STROKE}" stroke="#ffffff" stroke-width="3" paint-order="stroke"`
    ),
  ].join('\n');
}

function dimension(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  horizontal: boolean,
  label: string,
  cellX: number,
  cellY: number,
  viewSize: number
): string {
  const pad = 14;
  const ink = '#2c2a28';
  if (horizontal) {
    const y = Math.min(Math.max(box.maxY + pad, cellY + 10), cellY + viewSize - 8);
    const x1 = box.minX;
    const x2 = box.maxX;
    return [
      `<line x1="${n(x1)}" y1="${n(y)}" x2="${n(x2)}" y2="${n(y)}" stroke="${ink}" stroke-width="1"/>`,
      arrow(x1, y, -1, 0, ink),
      arrow(x2, y, 1, 0, ink),
      text((x1 + x2) / 2, y - 4, FONT.dim, label, `text-anchor="middle" fill="${ink}" stroke="#ffffff" stroke-width="3" paint-order="stroke"`),
    ].join('\n');
  }
  const x = Math.min(Math.max(box.maxX + pad, cellX + 10), cellX + viewSize - 8);
  const y1 = box.minY;
  const y2 = box.maxY;
  return [
    `<line x1="${n(x)}" y1="${n(y1)}" x2="${n(x)}" y2="${n(y2)}" stroke="${ink}" stroke-width="1"/>`,
    arrow(x, y1, 0, -1, ink),
    arrow(x, y2, 0, 1, ink),
    text(x + 5, (y1 + y2) / 2, FONT.dim, label, `fill="${ink}" stroke="#ffffff" stroke-width="3" paint-order="stroke"`),
  ].join('\n');
}

function arrow(x: number, y: number, dx: number, dy: number, fill: string): string {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const tip = [x, y];
  const left = [x - ux * 8 + px * 3, y - uy * 8 + py * 3];
  const right = [x - ux * 8 - px * 3, y - uy * 8 - py * 3];
  const points = [tip, left, right].map(([px0, py0]) => `${n(px0)},${n(py0)}`).join(' ');
  return `<polygon points="${points}" fill="${fill}"/>`;
}

function guidePath(polylines: Vec3[][], camera: ViewCamera, ox: number, oy: number): string {
  const commands: string[] = [];
  for (const line of polylines) {
    line.forEach((point, index) => {
      const [x, y] = projectToView(camera, point);
      commands.push(`${index === 0 ? 'M' : 'L'} ${n(ox + x)} ${n(oy + y)}`);
    });
  }
  return commands.join(' ');
}

function projectBounds(
  camera: ViewCamera,
  bounds: { min: Vec3; max: Vec3 },
  ox: number,
  oy: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const corners: Vec3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const [x, y] = projectToView(camera, corner);
    const px = ox + x;
    const py = oy + y;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  return { minX, minY, maxX, maxY };
}

function aligns(basis: Vec3, axis: 'x' | 'y' | 'z'): boolean {
  const u = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  return Math.abs(basis[u]) > 0.5;
}

function mm(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-6) return String(Math.round(rounded));
  return rounded.toFixed(1);
}

function text(x: number, y: number, size: number, value: string, attrs: string): string {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${size}" font-family="${FAMILY}" ${attrs}>${xmlEscape(value)}</text>`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function n(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
