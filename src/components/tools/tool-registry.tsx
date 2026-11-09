import type React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ToolOp, FacePlane } from '@/lib/tools/ops';
import { parseCadaiParts } from '@/lib/tools/ops';
import type { TopoFace } from '@/lib/geometry/topology';
import { toolDef as textDef } from './defs/text';
import { toolDef as textureDef } from './defs/texture';
import { toolDef as holeDef } from './defs/hole';
import { toolDef as measureDef } from './defs/measure';
import { toolDef as sectionDef } from './defs/section';

export type ToolId = 'text' | 'texture' | 'hole' | 'measure' | 'section';

export interface ToolSettingsProps {
  draft: ToolOp | null;
  onChange: (patch: Partial<ToolOp>) => void;
}

export interface ToolDef {
  id: ToolId;
  icon: LucideIcon;
  label: string;
  needsFace: boolean;
  modifies: boolean;
  opKinds: ToolOp['kind'][];
  Settings: React.FC<ToolSettingsProps>;
  initialDraft(face: TopoFace, plane: FacePlane): ToolOp | null;
  ViewportOverlay?: React.FC;
}

// Conflict-free tool registration: each lane (Tasks 13–16) replaces only its own file under ./defs/.
export const TOOLS: ToolDef[] = [
  textDef,
  textureDef,
  holeDef,
  measureDef,
  sectionDef,
].filter((d): d is ToolDef => d !== null);

export function getTool(id: string | null): ToolDef | undefined {
  if (!id) return undefined;
  return TOOLS.find((t) => t.id === id);
}

export function toolForOpKind(kind: ToolOp['kind']): ToolDef | undefined {
  return TOOLS.find((t) => t.opKinds.includes(kind));
}

function cleanZero(n: number): number {
  return Object.is(n, -0) || n === 0 ? 0 : n;
}

export function facePlane(face: TopoFace): FacePlane | null {
  if (face.kind !== 'plane' || !face.normal) {
    return null;
  }

  const [nx, ny, nz] = face.normal;
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return null;

  const normal: [number, number, number] = [
    cleanZero(nx / len),
    cleanZero(ny / len),
    cleanZero(nz / len),
  ];
  const [x, y, z] = normal;

  let xDir: [number, number, number];
  if (Math.abs(z) > 0.9) {
    // Project [1, 0, 0] onto the plane: v - (v . normal) * normal
    // v . normal = x
    const proj: [number, number, number] = [1 - x * x, -x * y, -x * z];
    const pLen = Math.hypot(proj[0], proj[1], proj[2]);
    if (pLen === 0) return null;
    xDir = [
      cleanZero(proj[0] / pLen),
      cleanZero(proj[1] / pLen),
      cleanZero(proj[2] / pLen),
    ];
  } else {
    // normalize(cross([0, 0, 1], normal)) -> [-y, x, 0]
    const cLen = Math.hypot(-y, x);
    if (cLen === 0) return null;
    xDir = [cleanZero(-y / cLen), cleanZero(x / cLen), 0];
  }

  return {
    origin: [face.center[0], face.center[1], face.center[2]],
    normal,
    xDir,
  };
}

export function newOpId(kind: string): string {
  const letters = kind.replace(/[^a-zA-Z]/g, '').toLowerCase();
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  for (let i = 0; i < 8; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `op_${letters}${rand}`;
}

export function partVariableForLabel(body: string, label: string): string | null {
  const parts = parseCadaiParts(body);
  if (parts.length === 0) return null;

  if (parts.includes(label)) {
    return label;
  }

  const labelRegex = /^[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)\.label\s*=\s*(?:'([^']*)'|"([^"]*)")/gm;
  let match: RegExpExecArray | null;
  while ((match = labelRegex.exec(body)) !== null) {
    const varName = match[1];
    const matchedLabel = match[2] ?? match[3];
    if (matchedLabel === label && parts.includes(varName)) {
      return varName;
    }
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return null;
}

export const REBUILD_FOR_TOOLS = 'Rebuild this version to use modeling tools.';
export const BUILD_FIRST = 'Build a model to use modeling tools.';
export const PICK_FLAT_FACE = 'Pick a flat face.';
export const PICK_A_FACE = 'Click a face on the model.';
export const PART_NOT_EDITABLE = 'Tools cannot edit this part.';
export const PREVIEW_FAILED = 'The preview did not build.';
export const APPLIED = 'Applied';
export const TOOL_UNAVAILABLE = "This layer's tool is not available yet.";
