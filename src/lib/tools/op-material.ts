import type { ToolOp } from './ops';

export function renderMaterialOp(op: Extract<ToolOp, { kind: 'material' }>): string {
  const { kind, id, target, material, color } = op;
  const payload = { kind, id, target, material, color };
  return [
    `# cadai:op material id=${id} ${JSON.stringify(payload)}`,
    `# cadai:end ${id}`,
  ].join('\n');
}
