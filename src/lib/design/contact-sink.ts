import type { AssemblySpec } from '../agent/assembly-spec';
import { placedBounds, type Vec3 } from './placement-geometry';

/**
 * Flush contacts are a placement problem, and placement is emitted by code.
 * Two components with no jointContract whose faces are within 0.05 mm are
 * pushed 0.02 mm into each other so a tangent ring or a loop on a plate
 * shares a chord instead of a line. A real overlap, or a gap above 0.05 mm,
 * is left alone. The part that is not grounded moves; if both are grounded
 * (or both are not), the later one in spec order moves. Nothing is pushed
 * below z = 0, and each part takes at most one sink on each axis.
 */

const CONTACT_MM = 0.05;
const SINK_MM = 0.02;
/** A part whose lowest point is above this is not resting on the floor. */
const GROUND_Z = 0.01;
const FACE_EPS = 1e-6;

export function contactSinks(spec: AssemblySpec): Map<string, [number, number, number]> {
  const parts = partBoxes(spec);
  const sum = new Map<string, { v: [number, number, number]; used: [boolean, boolean, boolean]; minZ: number }>();

  const add = (part: Part, axis: number, delta: number) => {
    if (axis === 2 && part.min[2] + delta < -1e-9) return;
    let row = sum.get(part.name);
    if (!row) {
      row = { v: [0, 0, 0], used: [false, false, false], minZ: part.min[2] };
      sum.set(part.name, row);
    }
    if (row.used[axis]) return;
    row.v[axis] = delta;
    row.used[axis] = true;
  };

  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i];
      const b = parts[j];
      if (joined(spec, a.name, b.name)) continue;
      for (let axis = 0; axis < 3; axis++) {
        if (facesNear(a.max[axis], b.min[axis]) && overlapsArea(a, b, axis)) {
          const mover = pickMover(a, b);
          add(mover, axis, mover === a ? SINK_MM : -SINK_MM);
        } else if (facesNear(b.max[axis], a.min[axis]) && overlapsArea(a, b, axis)) {
          const mover = pickMover(a, b);
          add(mover, axis, mover === b ? SINK_MM : -SINK_MM);
        }
      }
    }
  }

  const out = new Map<string, [number, number, number]>();
  for (const [name, row] of sum) {
    const sink: [number, number, number] = [...row.v];
    if (row.minZ + sink[2] < -1e-9) sink[2] = 0;
    if (sink.some((n) => n !== 0)) out.set(name, sink);
  }
  return out;
}

interface Part {
  name: string;
  index: number;
  min: Vec3;
  max: Vec3;
}

function partBoxes(spec: AssemblySpec): Part[] {
  const parts: Part[] = [];
  (spec.components ?? []).forEach((component, index) => {
    const extents = asVec3(component.localExtents);
    if (!extents) return;
    const position = asVec3(component.position) ?? [0, 0, 0];
    const rotation = asVec3(component.rotation) ?? [0, 0, 0];
    const box = placedBounds({ min: [0, 0, 0], max: extents }, position, rotation);
    parts.push({ name: component.name, index, min: box.min, max: box.max });
  });
  return parts;
}

function asVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = value[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out;
}

function joined(spec: AssemblySpec, a: string, b: string): boolean {
  return (spec.jointContracts ?? []).some((joint) =>
    (joint.partA === a && joint.partB === b) || (joint.partA === b && joint.partB === a));
}

/** The ungrounded part, otherwise the later one in spec order. */
function pickMover(a: Part, b: Part): Part {
  const aUp = a.min[2] > GROUND_Z;
  const bUp = b.min[2] > GROUND_Z;
  if (aUp !== bUp) return aUp ? a : b;
  return a.index > b.index ? a : b;
}

function facesNear(a: number, b: number): boolean {
  return Math.abs(a - b) <= CONTACT_MM + FACE_EPS;
}

function overlapsArea(a: Part, b: Part, axis: number): boolean {
  for (let k = 0; k < 3; k++) {
    if (k === axis) continue;
    const overlap = Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]);
    if (overlap <= FACE_EPS) return false;
  }
  return true;
}
