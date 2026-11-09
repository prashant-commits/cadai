import type { ToolOp } from './ops';
import { renderPlaneParams, renderPlaneDef } from './op-hole';

function formatNum(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

export function renderTextOp(op: Extract<ToolOp, { kind: 'text' }>): string {
  const { id, part, text, sizeMm, mode, depthMm } = op;
  const isEmboss = mode === 'emboss';

  const lines: string[] = [
    `# cadai:op text id=${id} ${JSON.stringify(op)}`,
    ...renderPlaneParams(op),
    `${id}_size = ${formatNum(sizeMm)}  # text size mm`,
    `${id}_depth = ${formatNum(depthMm)}  # text depth mm`,
    `${id}_overshoot = 0.01  # overshoot mm`,
    renderPlaneDef(id),
  ];

  if (isEmboss) {
    lines.push(
      `${id}_feature = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_overshoot) * Rot(0, 0, ${id}_rotation) * extrude(Text(${JSON.stringify(text)}, ${id}_size), ${id}_depth + ${id}_overshoot)`,
      `${part} = ${part} + ${id}_feature`,
      `${part}.label = "${part}"`
    );
  } else {
    lines.push(
      `${id}_cutter = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_depth) * Rot(0, 0, ${id}_rotation) * extrude(Text(${JSON.stringify(text)}, ${id}_size), ${id}_depth + ${id}_overshoot)`,
      `${part} = ${part} - ${id}_cutter`
    );
  }

  lines.push(`# cadai:end ${id}`);
  return lines.join('\n');
}
