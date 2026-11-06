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
 * sinks once per axis. When several supports on that axis want a move, the
 * part takes the largest of them, so a lintel follows a support that already
 * sank instead of staying tangent on it. The move is refused when it would
 * open a gap, or turn an overlap into a flush face, or drop the part below
 * z = 0. Two grounded parts that only meet on the side still sink: the
 * ungrounded one, else the later one in spec order, moves.
 *
 * Parts are tracked by spec index. Duplicate names cannot stall the walk.
 */

const CONTACT_MM = 0.05;
const SINK_MM = 0.02;
/** A part whose lowest point is above this is not resting on the floor. */
const GROUND_Z = 0.01;
const FACE_EPS = 1e-6;

type Sink = [number, number, number];

interface AxisMove {
  axis: number;
  delta: number;
  partner: string;
  partnerDelta: number;
}

export interface ContactSinkPlan {
  sinks: Map<string, Sink>;
  /** Emitted comment for each moved part, without the leading slashes. */
  notes: Map<string, string>;
}

export function contactSinks(spec: AssemblySpec): Map<string, Sink> {
  return contactSinkPlan(spec).sinks;
}

export function contactSinkPlan(spec: AssemblySpec): ContactSinkPlan {
  const parts = partBoxes(spec);
  const acc = new Map<number, Sink>();
  const used = new Map<number, [boolean, boolean, boolean]>();
  const reasons = new Map<number, AxisMove[]>();
  const placed = new Set<number>();
  const queued = new Set<number>();

  const vecOf = (index: number): Sink => {
    let row = acc.get(index);
    if (!row) {
      row = [0, 0, 0];
      acc.set(index, row);
    }
    return row;
  };
  const usedOf = (index: number): [boolean, boolean, boolean] => {
    let row = used.get(index);
    if (!row) {
      row = [false, false, false];
      used.set(index, row);
    }
    return row;
  };
  const interval = (part: Part, axis: number) => {
    const d = acc.get(part.index)?.[axis] ?? 0;
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
    if (a.index === b.index || joined(spec, a.name, b.name)) return false;
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
  const opensGap = (mover: Part, axis: number, delta: number, consider: Set<number>): boolean => {
    const prev = acc.get(mover.index);
    const proposed: Sink = prev ? [prev[0], prev[1], prev[2]] : [0, 0, 0];
    proposed[axis] = delta;
    for (const other of parts) {
      if (other.index === mover.index || !consider.has(other.index)) continue;
      if (joined(spec, mover.name, other.name)) continue;
      const before = faceGap(mover, other, axis);
      // Only a face that was flush or overlapping can be pulled apart.
      if (before === null || before > 1e-9) continue;
      acc.set(mover.index, proposed);
      const after = faceGap(mover, other, axis);
      if (prev) acc.set(mover.index, prev);
      else acc.delete(mover.index);
      if (after === null || after > 1e-9) return true;
      // An overlap that lands exactly flush is the same tangent the float split.
      if (before < -1e-9 && !(after < -1e-9)) return true;
    }
    return false;
  };
  const tryCommit = (mover: Part, other: Part, axis: number, delta: number, consider: Set<number>): boolean => {
    if (usedOf(mover.index)[axis]) return false;
    if (axis === 2 && mover.min[2] + delta < -1e-9) return false;
    if (opensGap(mover, axis, delta, consider)) return false;
    vecOf(mover.index)[axis] = delta;
    usedOf(mover.index)[axis] = true;
    const list = reasons.get(mover.index) ?? [];
    list.push({
      axis,
      delta,
      partner: other.name,
      partnerDelta: acc.get(other.index)?.[axis] ?? 0,
    });
    reasons.set(mover.index, list);
    return true;
  };
  const commitLargest = (
    part: Part,
    options: { other: Part; axis: number; gap: number }[],
    consider: Set<number>,
    preferRest: boolean,
  ): boolean => {
    const grouped = new Map<string, { other: Part; axis: number; delta: number }>();
    for (const opt of options) {
      const delta = toward(part, opt.other, opt.axis, opt.gap);
      const key = `${opt.axis}:${delta < 0 ? 0 : 1}`;
      const prev = grouped.get(key);
      if (!prev || Math.abs(delta) > Math.abs(prev.delta)) grouped.set(key, { other: opt.other, axis: opt.axis, delta });
    }
    const ordered = [...grouped.values()].sort((a, b) => {
      if (preferRest) {
        const aRest = a.axis === 2 && isHigher(part, a.other, 2) ? 0 : 1;
        const bRest = b.axis === 2 && isHigher(part, b.other, 2) ? 0 : 1;
        if (aRest !== bRest) return aRest - bRest;
      }
      if (Math.abs(a.delta) !== Math.abs(b.delta)) return Math.abs(b.delta) - Math.abs(a.delta);
      return a.axis - b.axis || a.other.index - b.other.index;
    });
    for (const opt of ordered) {
      if (tryCommit(part, opt.other, opt.axis, opt.delta, consider)) return true;
    }
    return false;
  };
  const sinkTowardSupport = (part: Part) => {
    const options: { other: Part; axis: number; gap: number }[] = [];
    for (const other of parts) {
      if (!placed.has(other.index) || other.index === part.index || joined(spec, part.name, other.name)) continue;
      for (let axis = 0; axis < 3; axis++) {
        const gap = sinkable(part, other, axis);
        if (gap === null) continue;
        options.push({ other, axis, gap });
      }
    }
    commitLargest(part, options, placed, true);
  };

  const launch = (roots: Part[]) => {
    const rootIds = new Set<number>();
    const queue: Part[] = [];
    for (const root of roots) {
      if (queued.has(root.index)) continue;
      queued.add(root.index);
      rootIds.add(root.index);
      queue.push(root);
      placed.add(root.index);
    }
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (!rootIds.has(cur.index)) {
        sinkTowardSupport(cur);
        placed.add(cur.index);
      }
      for (const other of parts) {
        if (queued.has(other.index) || !adjacent(cur, other)) continue;
        queued.add(other.index);
        queue.push(other);
      }
    }
  };

  const grounded = parts.filter((part) => part.min[2] <= GROUND_Z);
  if (grounded.length > 0) launch(grounded);
  while (queued.size < parts.length) {
    const rest = parts.filter((part) => !queued.has(part.index));
    if (rest.length === 0) break;
    let minZ = Infinity;
    for (const part of rest) if (part.min[2] < minZ) minZ = part.min[2];
    const roots = rest.filter((part) => part.min[2] <= minZ + 1e-9);
    const before = queued.size;
    launch(roots);
    if (queued.size === before) break;
  }

  // Lateral contacts between parts that were already placed (two grounded
  // neighbours, or a second axis the support move did not use).
  const everyone = new Set(parts.map((part) => part.index));
  const designatedMover = (part: Part, other: Part): boolean => {
    const partUp = part.min[2] > GROUND_Z;
    const otherUp = other.min[2] > GROUND_Z;
    if (partUp !== otherUp) return partUp;
    return part.index > other.index;
  };
  for (const part of parts) {
    for (let axis = 0; axis < 3; axis++) {
      if (usedOf(part.index)[axis]) continue;
      const options: { other: Part; gap: number }[] = [];
      for (const other of parts) {
        if (other.index === part.index || joined(spec, part.name, other.name)) continue;
        if (!designatedMover(part, other)) continue;
        const gap = sinkable(part, other, axis);
        if (gap === null) continue;
        options.push({ other, gap });
      }
      commitLargest(
        part,
        options.map((opt) => ({ ...opt, axis })),
        everyone,
        false,
      );
    }
  }

  const sinks = new Map<string, Sink>();
  const notes = new Map<string, string>();
  for (const part of parts) {
    const sink = acc.get(part.index);
    if (!sink || sink.every((n) => n === 0)) continue;
    const copy: Sink = [sink[0], sink[1], sink[2]];
    sinks.set(part.name, copy);
    const moves = reasons.get(part.index);
    if (moves?.length) notes.set(part.name, describeMoves(moves));
  }
  return { sinks, notes };
}

function describeMoves(moves: AxisMove[]): string {
  return [...moves]
    .sort((a, b) => a.axis - b.axis)
    .map((move) => {
      const mag = mm(move.delta);
      if (move.partnerDelta === 0) return `sinks ${mag} mm into ${move.partner}`;
      const into = mm(move.delta - move.partnerDelta);
      return `sinks ${mag} mm: ${into} into ${move.partner}, which sank ${mm(move.partnerDelta)}`;
    })
    .join('; ');
}

function mm(n: number): string {
  return String(Math.round(Math.abs(n) * 1000) / 1000);
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
