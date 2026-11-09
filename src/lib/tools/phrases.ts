import type { ToolOp } from './ops';

export const UNKNOWN_BASE_VERSION = 'The specified base version does not exist.';
export const BAD_OP = 'The requested modeling operation is invalid.';
export const BAD_BODY = 'The design body is invalid.';

const PATTERN_NAMES: Record<string, string> = {
  knurl: 'Knurl',
  hex: 'Hex',
  ribs: 'Ribs',
  dimples: 'Dimples',
};

export const MATERIAL_NAMES: Record<string, string> = {
  'brushed-metal': 'Brushed metal',
  'matte-plastic': 'Matte plastic',
  wood: 'Wood',
  color: 'Color',
};

export function toolEditActionPhrase(op: ToolOp | string): string {
  if (typeof op === 'string') {
    const trimmed = op.trim();
    if (trimmed.toLowerCase().startsWith('hole ')) {
      return `You added Hole ${trimmed.slice(5).trim()}`;
    }
    return `You added ${trimmed}`;
  }

  switch (op.kind) {
    case 'hole': {
      if (op.size === 'custom') {
        return `You added Hole Ø${op.diameterMm}`;
      }
      return `You added Hole ${op.size}`;
    }
    case 'cut-rect': {
      return `You added Cut-out ${op.widthMm} × ${op.heightMm}`;
    }
    case 'text': {
      if (op.mode === 'emboss') {
        return `You embossed "${op.text}"`;
      }
      return `You engraved "${op.text}"`;
    }
    case 'texture': {
      const patternName = PATTERN_NAMES[op.pattern] ?? op.pattern;
      return `You added ${patternName} texture`;
    }
    case 'material': {
      const matName = MATERIAL_NAMES[op.material] ?? op.material;
      const target = op.target === 'model' ? 'the model' : op.target;
      return `You set ${matName} on ${target}`;
    }
  }
}

export function toolEditPhrase(op: ToolOp | string, version: number): string {
  const base = toolEditActionPhrase(op);
  return `${base} · v${version}`;
}
