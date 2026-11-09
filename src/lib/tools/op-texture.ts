import type { ToolOp } from './ops';
import { renderPlaneParams, renderPlaneDef } from './op-hole';

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
      `${id}_cutter = Compound(${id}_cutters)`
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
