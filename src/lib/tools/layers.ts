import { parseOpBlocks, type ToolOp } from './ops';
import type { PartInfo } from '@/lib/contract/run-contract';
import type { ServerThreadVersion } from '@/lib/client/server-thread';

export interface LayerRow {
  id: string;
  label: string;
  box: { min: [number, number, number]; max: [number, number, number] } | null;
}

export function layerRows(
  parts: PartInfo[],
  viewingVersion: ServerThreadVersion | undefined
): LayerRow[] {
  if (parts.length > 0) {
    const counts = new Map<string, number>();
    return parts.map((p) => {
      const count = (counts.get(p.label) ?? 0) + 1;
      counts.set(p.label, count);
      const dedupLabel = count === 1 ? p.label : `${p.label} ${count}`;
      return {
        id: dedupLabel,
        label: dedupLabel,
        box: { min: p.min, max: p.max },
      };
    });
  }

  const versionLabels = viewingVersion?.partLabels ?? [];
  if (versionLabels.length > 0) {
    const counts = new Map<string, number>();
    return versionLabels.map((lbl) => {
      const count = (counts.get(lbl) ?? 0) + 1;
      counts.set(lbl, count);
      const dedupLabel = count === 1 ? lbl : `${lbl} ${count}`;
      return {
        id: dedupLabel,
        label: dedupLabel,
        box: null,
      };
    });
  }

  return [];
}

export function resolveSelectedLayer(
  code: string,
  parts: PartInfo[],
  viewingVersion: ServerThreadVersion | undefined,
  selectedLayerId: string | null
): { id: string; name: string } | null {
  if (!selectedLayerId) return null;
  const partRows = layerRows(parts, viewingVersion);
  const allLayers = listLayers(code, partRows.map((r) => r.label));
  const found = allLayers.find((l) => l.id === selectedLayerId);
  return found ? { id: found.id, name: found.name } : null;
}

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
