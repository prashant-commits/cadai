import type { ToolOp } from './ops';
import { renderPlaneParams, renderPlaneDef } from './op-hole';
import { renderMaterialOp } from './op-material';

export const FONT_IDS = ['inter-bold', 'roboto-mono-bold', 'oswald-semibold'] as const;

function formatNum(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

export function renderTextOp(op: Extract<ToolOp, { kind: 'text' }>): string {
  const { id, part, text, font, sizeMm, mode, depthMm, align, color } = op;
  const isEmboss = mode === 'emboss';
  const halign = align === 'left' ? 'LEFT' : align === 'right' ? 'RIGHT' : 'CENTER';

  const lines: string[] = [
    `# cadai:op text id=${id} ${JSON.stringify(op)}`,
    ...renderPlaneParams(op),
    `${id}_size = ${formatNum(sizeMm)}  # text size mm`,
    `${id}_depth = ${formatNum(depthMm)}  # text depth mm`,
    `${id}_overshoot = 0.01  # overshoot mm`,
    `${id}_halign = TextAlign.${halign}  # text align`,
    renderPlaneDef(id),
  ];

  const textExpr = `Text(${JSON.stringify(text)}, ${id}_size, font_path=CADAI_FONTS + "/${font}.ttf", text_align=(${id}_halign, TextAlign.CENTER))`;

  if (isEmboss) {
    lines.push(
      `${id}_feature = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_overshoot) * Rot(0, 0, ${id}_rotation) * extrude(${textExpr}, ${id}_depth + ${id}_overshoot)`,
      `${part} = ${part} + ${id}_feature`,
      `${part}.label = "${part}"`
    );
  } else {
    lines.push(
      `${id}_cutter = ${id}_plane * Pos(${id}_offset_x, ${id}_offset_y, -${id}_depth) * Rot(0, 0, ${id}_rotation) * extrude(${textExpr}, ${id}_depth + ${id}_overshoot)`,
      `${part} = ${part} - ${id}_cutter`
    );
  }

  if (color) {
    lines.push(
      renderMaterialOp({
        kind: 'material',
        id: `${id}_color`,
        target: part,
        material: 'color',
        color,
      })
    );
  }

  lines.push(`# cadai:end ${id}`);
  return lines.join('\n');
}
