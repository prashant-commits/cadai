import { parseOpBlocks, type ToolOp } from './ops';

export interface Layer {
  id: string;
  name: string;
  kind: 'part' | ToolOp['kind'];
}

const PATTERN_NAMES: Record<string, string> = {
  knurl: 'Knurl',
  hex: 'Hex',
  ribs: 'Ribs',
  dimples: 'Dimples',
};

const MATERIAL_NAMES: Record<string, string> = {
  'brushed-metal': 'Brushed metal',
  'matte-plastic': 'Matte plastic',
  wood: 'Wood',
  color: 'Color',
};

export function opLayerName(op: ToolOp): string {
  switch (op.kind) {
    case 'hole':
      return op.size === 'custom' ? `Hole Ø${op.diameterMm}` : `Hole ${op.size}`;
    case 'cut-rect':
      return `Cut-out ${op.widthMm} × ${op.heightMm}`;
    case 'text':
      return `Text "${op.text}"`;
    case 'texture': {
      const patternName = PATTERN_NAMES[op.pattern] ?? op.pattern;
      return `${patternName} texture`;
    }
    case 'material':
      return MATERIAL_NAMES[op.material] ?? op.material;
  }
}

export function listLayers(body: string, parts: string[]): Layer[] {
  const layers: Layer[] = [];

  for (const part of parts) {
    layers.push({
      id: part,
      name: part,
      kind: 'part',
    });
  }

  const parsed = parseOpBlocks(body);
  for (const item of parsed) {
    layers.push({
      id: item.op.id,
      name: opLayerName(item.op),
      kind: item.op.kind,
    });
  }

  return layers;
}
