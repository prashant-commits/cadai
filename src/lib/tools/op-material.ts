import type { ToolOp } from './ops';

export function renderMaterialOp(op: Extract<ToolOp, { kind: 'material' }>): string {
  const { id } = op;
  return [
    `# cadai:op material id=${id} ${JSON.stringify(op)}`,
    `# cadai:end ${id}`,
  ].join('\n');
}
