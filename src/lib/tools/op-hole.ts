import type { ToolOp } from './ops';

export interface HolePreset {
  clearanceMm: number;
  counterboreDiaMm: number;
  counterboreDepthMm: number;
  countersinkDiaMm: number;
}

export const HOLE_PRESETS: Record<'M3' | 'M4' | 'M5' | 'M6' | 'M8', HolePreset> = {
  M3: { clearanceMm: 3.4, counterboreDiaMm: 6.5, counterboreDepthMm: 3.4, countersinkDiaMm: 6.3 },
  M4: { clearanceMm: 4.5, counterboreDiaMm: 8.0, counterboreDepthMm: 4.4, countersinkDiaMm: 8.4 },
  M5: { clearanceMm: 5.5, counterboreDiaMm: 10.0, counterboreDepthMm: 5.4, countersinkDiaMm: 10.4 },
  M6: { clearanceMm: 6.6, counterboreDiaMm: 11.0, counterboreDepthMm: 6.4, countersinkDiaMm: 12.6 },
  M8: { clearanceMm: 9.0, counterboreDiaMm: 14.5, counterboreDepthMm: 8.4, countersinkDiaMm: 17.3 },
};

function formatNum(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

export function renderPlaneParams(op: {
  id: string;
  plane: { origin: [number, number, number]; normal: [number, number, number]; xDir: [number, number, number] };
  offset: [number, number];
  rotationDeg: number;
}): string[] {
  const { id, plane, offset, rotationDeg } = op;
  return [
    `${id}_plane_orig_x = ${formatNum(plane.origin[0])}  # plane origin x mm`,
    `${id}_plane_orig_y = ${formatNum(plane.origin[1])}  # plane origin y mm`,
    `${id}_plane_orig_z = ${formatNum(plane.origin[2])}  # plane origin z mm`,
    `${id}_plane_norm_x = ${formatNum(plane.normal[0])}  # plane normal x`,
    `${id}_plane_norm_y = ${formatNum(plane.normal[1])}  # plane normal y`,
    `${id}_plane_norm_z = ${formatNum(plane.normal[2])}  # plane normal z`,
    `${id}_plane_xdir_x = ${formatNum(plane.xDir[0])}  # plane x_dir x`,
    `${id}_plane_xdir_y = ${formatNum(plane.xDir[1])}  # plane x_dir y`,
    `${id}_plane_xdir_z = ${formatNum(plane.xDir[2])}  # plane x_dir z`,
    `${id}_offset_x = ${formatNum(offset[0])}  # offset x mm`,
    `${id}_offset_y = ${formatNum(offset[1])}  # offset y mm`,
    `${id}_rotation = ${formatNum(rotationDeg)}  # rotation deg`,
  ];
}

export function renderPlaneDef(id: string): string {
  return `${id}_plane = Plane(origin=(${id}_plane_orig_x, ${id}_plane_orig_y, ${id}_plane_orig_z), z_dir=(${id}_plane_norm_x, ${id}_plane_norm_y, ${id}_plane_norm_z), x_dir=(${id}_plane_xdir_x, ${id}_plane_xdir_y, ${id}_plane_xdir_z))`;
}

export function renderHoleOp(op: Extract<ToolOp, { kind: 'hole' }>): string {
  const { id, part, size, head, depthMm } = op;
  const isThrough = depthMm === 'through';
  const depthVal = isThrough ? 1000.0 : depthMm;

  let diameter = op.diameterMm;
  let cbDia = 10.0;
  let cbDepth = 5.4;
  let csDia = 10.4;

  if (size !== 'custom' && HOLE_PRESETS[size]) {
    const preset = HOLE_PRESETS[size];
    diameter = preset.clearanceMm;
    cbDia = preset.counterboreDiaMm;
    cbDepth = preset.counterboreDepthMm;
    csDia = preset.countersinkDiaMm;
  }

  const marker = {
    id: op.id,
    part: op.part,
    plane: op.plane,
    offset: op.offset,
    rotationDeg: op.rotationDeg,
    kind: 'hole' as const,
    size: op.size,
    diameterMm: op.diameterMm,
    head: op.head,
    depthMm: op.depthMm,
  };

  const lines: string[] = [
    `# cadai:op hole id=${id} ${JSON.stringify(marker)}`,
    ...renderPlaneParams(op),
    `${id}_diameter = ${formatNum(diameter)}  # clearance mm`,
    isThrough
      ? `${id}_depth = ${formatNum(depthVal)}  # depth mm (through)`
      : `${id}_depth = ${formatNum(depthVal)}  # depth mm`,
    `${id}_overshoot = 0.01  # cutter overshoot mm`,
  ];

  if (head === 'counterbore') {
    lines.push(
      `${id}_cb_diameter = ${formatNum(cbDia)}  # counterbore diameter mm`,
      `${id}_cb_depth = ${formatNum(cbDepth)}  # counterbore depth mm`
    );
  } else if (head === 'countersink') {
    lines.push(
      `${id}_cs_diameter = ${formatNum(csDia)}  # countersink diameter mm`,
      `${id}_cs_depth = (${id}_cs_diameter - ${id}_diameter) / 2  # countersink depth mm (90 deg)`
    );
  }

  lines.push(renderPlaneDef(id));

  if (head === 'counterbore') {
    lines.push(
      `${id}_cutter = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, 0) * Rot(0, 0, ${id}_rotation) * (Pos(0, 0, -${id}_depth) * Cylinder(radius=${id}_diameter / 2, height=${id}_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)) + Pos(0, 0, -${id}_cb_depth) * Cylinder(radius=${id}_cb_diameter / 2, height=${id}_cb_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)))`
    );
  } else if (head === 'countersink') {
    lines.push(
      `${id}_cutter = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, 0) * Rot(0, 0, ${id}_rotation) * (Pos(0, 0, -${id}_depth) * Cylinder(radius=${id}_diameter / 2, height=${id}_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)) + Pos(0, 0, -${id}_cs_depth) * Cone(bottom_radius=${id}_diameter / 2, top_radius=${id}_cs_diameter / 2, height=${id}_cs_depth, align=(Align.CENTER, Align.CENTER, Align.MIN)) + Pos(0, 0, 0) * Cylinder(radius=${id}_cs_diameter / 2, height=${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)))`
    );
  } else {
    lines.push(
      `${id}_cutter = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_depth) * Rot(0, 0, ${id}_rotation) * Cylinder(radius=${id}_diameter / 2, height=${id}_depth + ${id}_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN))`
    );
  }

  lines.push(`${part} = ${part} - ${id}_cutter`);
  lines.push(`# cadai:end ${id}`);

  return lines.join('\n');
}

export function renderCutRectOp(op: Extract<ToolOp, { kind: 'cut-rect' }>): string {
  const { id, part, widthMm, heightMm, cornerRadiusMm, depthMm } = op;
  const isThrough = depthMm === 'through';
  const depthVal = isThrough ? 1000.0 : depthMm;

  const marker = {
    id: op.id,
    part: op.part,
    plane: op.plane,
    offset: op.offset,
    rotationDeg: op.rotationDeg,
    kind: 'cut-rect' as const,
    widthMm: op.widthMm,
    heightMm: op.heightMm,
    cornerRadiusMm: op.cornerRadiusMm,
    depthMm: op.depthMm,
  };

  const lines: string[] = [
    `# cadai:op cut-rect id=${id} ${JSON.stringify(marker)}`,
    ...renderPlaneParams(op),
    `${id}_width = ${formatNum(widthMm)}  # width mm`,
    `${id}_height = ${formatNum(heightMm)}  # height mm`,
    `${id}_corner_radius = ${formatNum(cornerRadiusMm)}  # corner radius mm`,
    isThrough
      ? `${id}_depth = ${formatNum(depthVal)}  # depth mm (through)`
      : `${id}_depth = ${formatNum(depthVal)}  # depth mm`,
    `${id}_overshoot = 0.01  # cutter overshoot mm`,
    renderPlaneDef(id),
    `${id}_shape = RectangleRounded(${id}_width, ${id}_height, ${id}_corner_radius) if ${id}_corner_radius > 0 else Rectangle(${id}_width, ${id}_height)`,
    `${id}_cutter = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_depth) * Rot(0, 0, ${id}_rotation) * extrude(${id}_shape, ${id}_depth + ${id}_overshoot)`,
    `${part} = ${part} - ${id}_cutter`,
    `# cadai:end ${id}`,
  ];

  return lines.join('\n');
}
