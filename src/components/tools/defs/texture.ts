import type { ToolDef } from '../tool-registry';
import type { TopoFace } from '@/lib/geometry/topology';
import type { FacePlane, ToolOp } from '@/lib/tools/ops';
import { Grip } from 'lucide-react';
import { TextureSettings } from '../texture-tool';
import { textureDensityError } from '@/lib/tools/op-texture';

export function initialDraft(face: TopoFace, plane: FacePlane): ToolOp {
  const side = Math.round(Math.min(20, 0.8 * Math.sqrt(face.area)) * 10) / 10;
  return {
    kind: 'texture',
    id: '',
    part: '',
    plane,
    pattern: 'knurl',
    pitchMm: 2.0,
    depthMm: 0.4,
    offset: [0, 0],
    rotationDeg: 0,
    areaMm: [side, side],
  };
}

export function applyBlocker(draft: ToolOp | null): string | null {
  if (draft && draft.kind === 'texture') {
    return textureDensityError(draft);
  }
  return null;
}

export const toolDef: ToolDef = {
  id: 'texture',
  icon: Grip,
  label: 'Texture',
  needsFace: true,
  modifies: true,
  opKinds: ['texture', 'material'],
  Settings: TextureSettings,
  initialDraft,
  applyBlocker,
};
