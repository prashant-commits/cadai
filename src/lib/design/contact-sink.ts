import type { AssemblySpec } from '../agent/assembly-spec';
import { placedBounds, type Vec3 } from './placement-geometry';

/**
 * Flush contacts are a placement problem, and placement is emitted by code.
 * Parts with no jointContract whose faces are separated by 0 to 0.05 mm are
 * pushed together until they overlap by 0.02 mm. A real overlap, or a gap
 * above 0.05 mm, is left alone.
 *
 * Sinks are applied in breadth-first order from the grounded parts (lowest
 * z <= 0.01), on the positions already decided, so a stack overlaps at every
 * joint instead of each part shifting by the same absolute amount. A part
 * sinks once per axis, toward the neighbour it is supported by. The move is
 * refused when it would open a gap to another part that was already flush or
 * overlapping (a crossbar between two uprights stays put) or when it would
 * drop the part below z = 0. Two grounded parts that only meet on the side
 * still sink: the ungrounded one, else the later one in spec order, moves.
 */

const CONTACT_MM = 0.05;
const SINK_MM = 0.02;
/** A part whose lowest point is above this is not resting on the floor. */
const GROUND_Z = 0.01;
const FACE_EPS = 1e-6;

type Sink = [number, number, number];

export function contactSinks(spec: AssemblySpec): Map<string, Sink> {
  const parts = partBoxes(spec);
  const acc = new Map<string, Sink>();
  const used = new Map<string, [boolean, boolean, boolean]>();
  const placed = new Set<string>();
  const queued = new Set<string>();

  const vecOf = (name: string): Sink => {
    let row = acc.get(name);
    if (!row) {
      row = [0, 0, 0];
      acc.set(name, row);
    }
    return row;
  };
  const usedOf = (name: string): [boolean, boolean, boolean] => {
    let row = used.get(name);
    if (!row) {
      row = [false, false, false];
      used.set(name, row);
    }
    return row;
  };
  const interval = (part: Part, axis: number) => {
    const d = acc.get(part.name)?.[axis] ?? 0;
    return { min: part.min[axis] + d, max: part.max[axis] + d };
  };
  const areaOverlap = (a: Part, b: Part, axis: number): boolean => {
    for (let k = 0; k < 3; k++) {
      if (k === axis) continue;
      const as = interval(a, k);
      const bs = interval(b, k);
      if (Math.min(as.max, bs.max) - Math.max(as.min, bs.min) <= FACE_EPS) return false;
    }
    return true;
  };
  /** Signed separation on `axis`: positive is a gap, negative is an overlap. */
  const faceGap = (a: Part, b: Part, axis: number): number | null => {
    if (!areaOverlap(a, b, axis)) return null;
    const as = interval(a, axis);
    const bs = interval(b, axis);
    return Math.max(bs.min - as.max, as.min - bs.max);
  };
  const adjacent = (a: Part, b: Part): boolean => {
    if (joined(spec, a.name, b.name)) return false;
    for (let axis = 0; axis < 3; axis++) {
      const gap = faceGap(a, b, axis);
      if (gap !== null && gap <= CONTACT_MM + FACE_EPS) return true;
    }
    return false;
  };
  /** Gap in [0, 0.05], or null when the faces are not a sink candidate. */
  const sinkable = (a: Part, b: Part, axis: number): number | null => {
    const gap = faceGap(a, b, axis);
    if (gap === null || gap < -1e-6 || gap > CONTACT_MM + FACE_EPS) return null;
    return gap < 1e-6 ? 0 : gap;
  };
  const isHigher = (a: Part, b: Part, axis: number): boolean => {
    const as = interval(a, axis);
    const bs = interval(b, axis);
    return as.min - bs.max >= bs.min - as.max;
  };
  const toward = (mover: Part, other: Part, axis: number, gap: number): number => {
    const mag = Math.round((gap + SINK_MM) * 1000) / 1000;
    return isHigher(mover, other, axis) ? -mag : mag;
  };
  const opensGap = (mover: Part, axis: number, delta: number, consider: Set<string>): boolean => {
    const prev = acc.get(mover.name);
    const proposed: Sink = prev ? [prev[0], prev[1], prev[2]] : [0, 0, 0];
    proposed[axis] = delta;
    for (const other of parts) {
      if (other.name === mover.name || !consider.has(other.name)) continue;
      if (joined(spec, mover.name, other.name)) continue;
      const before = faceGap(mover, other, axis);
      // Only a face that was flush or overlapping can be pulled apart.
      if (before === null || before > 1e-9) continue;
      acc.set(mover.name, proposed);
      const after = faceGap(mover, other, axis);
      if (prev) acc.set(mover.name, prev);
      else acc.delete(mover.name);
      if (after !== null && after > 1e-9) return true;
    }
    return false;
  };
  const tryCommit = (mover: Part, axis: number, delta: number, consider: Set<string>): boolean => {
    if (usedOf(mover.name)[axis]) return false;
    if (axis === 2 && mover.min[2] + delta < -1e-9) return false;
    if (opensGap(mover, axis, delta, consider)) return false;
    vecOf(mover.name)[axis] = delta;
    usedOf(mover.name)[axis] = true;
    return true;
  };
  const sinkTowardSupport = (part: Part) => {
    const options: { other: Part; axis: number; gap: number }[] = [];
    for (const other of parts) {
      if (!placed.has(other.name) || joined(spec, part.name, other.name)) continue;
      for (let axis = 0; axis < 3; axis++) {
        const gap = sinkable(part, other, axis);
        if (gap === null) continue;
        options.push({ other, axis, gap });
      }
    }
    options.sort((a, b) => {
      const aRest = a.axis === 2 && isHigher(part, a.other, 2) ? 0 : 1;
      const bRest = b.axis === 2 && isHigher(part, b.other, 2) ? 0 : 1;
      if (aRest !== bRest) return aRest - bRest;
      if (a.gap !== b.gap) return a.gap - b.gap;
      return a.axis - b.axis || a.other.index - b.other.index;
    });
    for (const opt of options) {
      if (tryCommit(part, opt.axis, toward(part, opt.other, opt.axis, opt.gap), placed)) return;
    }
  };

  const launch = (roots: Part[]) => {
    const rootNames = new Set<string>();
    const queue: Part[] = [];
    for (const root of roots) {
      if (queued.has(root.name)) continue;
      queued.add(root.name);
      rootNames.add(root.name);
      queue.push(root);
      placed.add(root.name);
    }
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (!rootNames.has(cur.name)) {
        sinkTowardSupport(cur);
        placed.add(cur.name);
      }
      for (const other of parts) {
        if (queued.has(other.name) || !adjacent(cur, other)) continue;
        queued.add(other.name);
        queue.push(other);
      }
    }
  };

  const grounded = parts.filter((part) => part.min[2] <= GROUND_Z);
  if (grounded.length > 0) launch(grounded);
  while (queued.size < parts.length) {
    let minZ = Infinity;
    for (const part of parts) {
      if (!queued.has(part.name) && part.min[2] < minZ) minZ = part.min[2];
    }
    launch(parts.filter((part) => !queued.has(part.name) && part.min[2] <= minZ + 1e-9));
  }

  // Lateral contacts between parts that were already placed (two grounded
  // neighbours, or a second axis the support move did not use).
  const everyone = new Set(parts.map((part) => part.name));
  const designatedMover = (part: Part, other: Part): boolean => {
    const partUp = part.min[2] > GROUND_Z;
    const otherUp = other.min[2] > GROUND_Z;
    if (partUp !== otherUp) return partUp;
    return part.index > other.index;
  };
  for (const part of parts) {
    for (let axis = 0; axis < 3; axis++) {
      if (usedOf(part.name)[axis]) continue;
      const options: { other: Part; gap: number }[] = [];
      for (const other of parts) {
        if (other.name === part.name || joined(spec, part.name, other.name)) continue;
        if (!designatedMover(part, other)) continue;
        const gap = sinkable(part, other, axis);
        if (gap === null) continue;
        options.push({ other, gap });
      }
      options.sort((a, b) => a.gap - b.gap || a.other.index - b.other.index);
      for (const opt of options) {
        if (tryCommit(part, axis, toward(part, opt.other, axis, opt.gap), everyone)) break;
      }
    }
  }

  const out = new Map<string, Sink>();
  for (const [name, sink] of acc) {
    if (sink.some((n) => n !== 0)) out.set(name, [sink[0], sink[1], sink[2]]);
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
