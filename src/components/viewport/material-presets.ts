import type { ToolOp } from '@/lib/tools/ops';

export type MaterialId = 'brushed-metal' | 'matte-plastic' | 'wood' | 'color';

export interface MaterialPresetDef {
  metalness: number;
  roughness: number;
  defaultColor: string;
}

export const MATERIAL_PRESETS: Record<MaterialId, MaterialPresetDef> = {
  'brushed-metal': { metalness: 0.9, roughness: 0.35, defaultColor: '#a0a4ab' },
  'matte-plastic': { metalness: 0, roughness: 0.85, defaultColor: '#94a3b8' },
  wood: { metalness: 0, roughness: 0.7, defaultColor: '#a0703c' },
  color: { metalness: 0.08, roughness: 0.3, defaultColor: '#94a3b8' },
};

export const DEFAULT_VIEWER_MATERIAL = {
  color: '#94a3b8',
  roughness: 0.3,
  metalness: 0.08,
};

export function viewerMaterial(
  ops: ToolOp[],
  parts: string[]
): { color: string; metalness: number; roughness: number } {
  const materialOps = ops.filter(
    (op): op is Extract<ToolOp, { kind: 'material' }> => op.kind === 'material'
  );

  // The last material op with target: 'model' wins
  for (let i = materialOps.length - 1; i >= 0; i--) {
    const op = materialOps[i];
    if (op.target === 'model') {
      const preset = MATERIAL_PRESETS[op.material] ?? MATERIAL_PRESETS.color;
      return {
        color: op.color,
        metalness: preset.metalness,
        roughness: preset.roughness,
      };
    }
  }

  // Else, when the model has exactly one part, the last material op targeting that part
  if (parts.length === 1) {
    const singlePart = parts[0];
    for (let i = materialOps.length - 1; i >= 0; i--) {
      const op = materialOps[i];
      if (op.target === singlePart) {
        const preset = MATERIAL_PRESETS[op.material] ?? MATERIAL_PRESETS.color;
        return {
          color: op.color,
          metalness: preset.metalness,
          roughness: preset.roughness,
        };
      }
    }
  }

  // Else the default (today's values)
  return { ...DEFAULT_VIEWER_MATERIAL };
}
