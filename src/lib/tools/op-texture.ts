import type { ToolOp, FacePlane } from './ops';
import { renderPlaneParams, renderPlaneDef } from './op-hole';
import type { Topology } from '@/lib/geometry/topology';

export const MAX_TEXTURE_FEATURES = 400;
export const TOO_DENSE = 'Too dense: raise the pitch or shrink the area.';

export interface TextureOpParams {
  pattern: 'knurl' | 'hex' | 'ribs' | 'dimples';
  pitchMm: number;
  areaMm: [number, number];
}

export function textureFeatureCount(op: TextureOpParams): number {
  const { pattern, pitchMm, areaMm } = op;
  const [areaW, areaH] = areaMm;

  if (pitchMm <= 0 || areaW <= 0 || areaH <= 0) {
    return 0;
  }

  if (pattern === 'dimples' || pattern === 'hex') {
    const nx = Math.max(1, Math.floor(areaW / pitchMm));
    const ny = Math.max(1, Math.floor(areaH / pitchMm));
    return nx * ny;
  }

  if (pattern === 'ribs') {
    return Math.max(1, Math.floor(areaH / pitchMm));
  }

  if (pattern === 'knurl') {
    // The knurl's cost grows with the crossings, so its features are the n × n diamonds.
    const diag = Math.hypot(areaW, areaH);
    const n = Math.max(1, Math.floor(diag / pitchMm));
    return n * n;
  }

  return 0;
}

export function textureDensityError(op: TextureOpParams): string | null {
  const count = textureFeatureCount(op);
  return count > MAX_TEXTURE_FEATURES ? TOO_DENSE : null;
}

export function clampAreaToFace(
  areaMm: [number, number],
  extent: [number, number]
): [number, number] {
  const [w, h] = areaMm;
  const [ew, eh] = extent;
  const clampedW = ew > 0 && w > ew ? Math.round(ew * 10) / 10 : w;
  const clampedH = eh > 0 && h > eh ? Math.round(eh * 10) / 10 : h;
  return [clampedW, clampedH];
}

export function faceExtentMm(
  topology: Topology,
  faceId: number,
  plane: FacePlane
): [number, number] {
  const { positions, indices, faceIds } = topology.mesh;
  const [nx, ny, nz] = plane.normal;
  const [xx, xy, xz] = plane.xDir;

  // yDir = normal x xDir
  const yx = ny * xz - nz * xy;
  const yy = nz * xx - nx * xz;
  const yz = nx * xy - ny * xx;

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  const numTriangles = faceIds.length;
  let found = false;

  for (let tri = 0; tri < numTriangles; tri++) {
    if (faceIds[tri] === faceId) {
      found = true;
      for (let j = 0; j < 3; j++) {
        const vIdx = indices[tri * 3 + j];
        const px = positions[vIdx * 3];
        const py = positions[vIdx * 3 + 1];
        const pz = positions[vIdx * 3 + 2];

        const u = px * xx + py * xy + pz * xz;
        const v = px * yx + py * yy + pz * yz;

        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
  }

  if (!found || !Number.isFinite(minU)) {
    return [0, 0];
  }

  return [maxU - minU, maxV - minV];
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

export function renderTextureOp(op: Extract<ToolOp, { kind: 'texture' }>): string {
  const { id, part, pattern, pitchMm, depthMm, areaMm } = op;

  const lines: string[] = [
    `# cadai:op texture id=${id} ${JSON.stringify(op)}`,
    ...renderPlaneParams(op),
    `${id}_pitch = ${formatNum(pitchMm)}  # pitch mm`,
    `${id}_depth = ${formatNum(depthMm)}  # depth mm`,
    `${id}_area_w = ${formatNum(areaMm[0])}  # area width mm`,
    `${id}_area_h = ${formatNum(areaMm[1])}  # area height mm`,
    `${id}_overshoot = 0.01  # cutter overshoot mm`,
    renderPlaneDef(id),
  ];

  if (pattern === 'dimples') {
    lines.push(
      `${id}_nx = max(1, int(${id}_area_w / ${id}_pitch))`,
      `${id}_ny = max(1, int(${id}_area_h / ${id}_pitch))`,
      `${id}_cutters = [${id}_plane * Pos(${id}_offset_x + (ix - (${id}_nx - 1) / 2) * ${id}_pitch, ${id}_offset_y + (iy - (${id}_ny - 1) / 2) * ${id}_pitch, -${id}_depth) * Rot(0, 0, ${id}_rotation) * Cylinder(radius=${id}_pitch / 4, height=${id}_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)) for ix in range(${id}_nx) for iy in range(${id}_ny)]`,
      `${id}_cutter = Compound(${id}_cutters)`
    );
  } else if (pattern === 'ribs') {
    lines.push(
      `${id}_ny = max(1, int(${id}_area_h / ${id}_pitch))`,
      `${id}_cutters = [${id}_plane * Pos(${id}_offset_x, ${id}_offset_y + (iy - (${id}_ny - 1) / 2) * ${id}_pitch, -${id}_depth) * Rot(0, 0, ${id}_rotation) * Box(${id}_area_w, ${id}_pitch / 2, ${id}_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)) for iy in range(${id}_ny)]`,
      `${id}_cutter = Compound(${id}_cutters)`
    );
  } else if (pattern === 'knurl') {
    lines.push(
      `${id}_diag = (${id}_area_w ** 2 + ${id}_area_h ** 2) ** 0.5`,
      `${id}_n = max(1, int(${id}_diag / ${id}_pitch))`,
      `${id}_cutters = [${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_depth) * Rot(0, 0, ${id}_rotation + 45) * Pos(0, (i - (${id}_n - 1) / 2) * ${id}_pitch, 0) * Box(${id}_diag, ${id}_pitch / 3, ${id}_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)) for i in range(${id}_n)] + [${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_depth) * Rot(0, 0, ${id}_rotation - 45) * Pos(0, (i - (${id}_n - 1) / 2) * ${id}_pitch, 0) * Box(${id}_diag, ${id}_pitch / 3, ${id}_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)) for i in range(${id}_n)]`,
      `${id}_area_box = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_depth) * Rot(0, 0, ${id}_rotation) * Box(${id}_area_w, ${id}_area_h, ${id}_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN))`,
      `${id}_cutter = Compound(${id}_cutters) & ${id}_area_box`
    );
  } else if (pattern === 'hex') {
    lines.push(
      `${id}_nx = max(1, int(${id}_area_w / ${id}_pitch))`,
      `${id}_ny = max(1, int(${id}_area_h / ${id}_pitch))`,
      `${id}_cutters = [${id}_plane * Pos(${id}_offset_x + (ix - (${id}_nx - 1) / 2) * ${id}_pitch, ${id}_offset_y + (iy - (${id}_ny - 1) / 2) * ${id}_pitch, -${id}_depth) * Rot(0, 0, ${id}_rotation) * extrude(RegularPolygon(radius=${id}_pitch / 2.5, side_count=6), ${id}_depth + ${id}_overshoot) for ix in range(${id}_nx) for iy in range(${id}_ny)]`,
      `${id}_cutter = Compound(${id}_cutters)`
    );
  }

  lines.push(`${part} = ${part} - ${id}_cutter`);
  lines.push(`# cadai:end ${id}`);

  return lines.join('\n');
}
