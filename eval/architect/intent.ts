/**
 * Intent checker: scores a spec against the hand-written intent labels
 * (intent-labels*.json) using only the spec's own geometry - no compile, no
 * model call - so every saved run can be re-scored for free.
 *
 * Each component is placed in the world the way composeAssembly places it:
 * localExtents as a box at the origin, rotated about that origin (OpenSCAD
 * X-then-Y-then-Z), then moved to its position. Directions (a cylinder's axis,
 * a plate's normal, a hole's axis, a shell's open face) are rotated the same way.
 *
 * Parts are found by role: a case-insensitive regex over name + description.
 * A fact whose role matches nothing FAILS - a missing part is a wrong design.
 * A fact whose check type is not implemented here is reported as 'unchecked',
 * never as a pass, so coverage is visible.
 *
 * Conventions shared with the labels: +Z is up; 'horizontal' is x or y and the
 * two are interchangeable; horizontal sizes are compared sorted.
 */
import type { AssemblySpec } from '@/lib/agent/assembly-spec';
import { rotatePoint, type Vec3 } from '@/lib/design/placement-geometry';

type Component = NonNullable<AssemblySpec['components']>[number];

export interface Fact {
  says: string;
  reading?: string;
  check: Record<string, unknown> | null;
}

export type Verdict = 'pass' | 'fail' | 'unchecked';

export interface FactResult {
  says: string;
  interpretation: boolean;
  verdict: Verdict;
  why: string;
}

interface Part {
  c: Component;
  min: Vec3;
  max: Vec3;
  size: Vec3;
  centre: Vec3;
  /** World direction of the cylinder/tube axis, or of the longest extent for other shapes. */
  axis: Vec3;
  /** World direction of the smallest extent: a plate's normal. */
  thin: Vec3;
}

const ZERO: Vec3 = [0, 0, 0];
const TOUCH_MM = 1.0;
const UNIT: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const FACE: Record<string, Vec3> = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };

const deg = (r: number) => (r * 180) / Math.PI;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
/** Angle between a direction and the vertical, 0..90 degrees, sign-free. */
const fromVertical = (v: Vec3) => deg(Math.acos(Math.min(1, Math.abs(v[2]) / (norm(v) || 1))));

function rot(c: Component): Vec3 {
  return (c.rotation ?? ZERO) as Vec3;
}

function place(c: Component): Part | null {
  const ext = c.localExtents as Vec3 | undefined;
  if (!ext || ext.length < 3) return null;
  const pos = (c.position ?? ZERO) as Vec3;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [0, ext[0]]) for (const y of [0, ext[1]]) for (const z of [0, ext[2]]) {
    const p = rotatePoint([x, y, z], rot(c));
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i] + pos[i]);
      max[i] = Math.max(max[i], p[i] + pos[i]);
    }
  }
  const size = [0, 1, 2].map((i) => max[i] - min[i]) as Vec3;
  const centre = [0, 1, 2].map((i) => (min[i] + max[i]) / 2) as Vec3;
  const order = [0, 1, 2].sort((a, b) => ext[a] - ext[b]);
  const local = (i: number): Vec3 => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  const shapeAxis = c.shape?.kind === 'cylinder' || c.shape?.kind === 'tube' ? c.shape.axis : undefined;
  const axis = rotatePoint(shapeAxis ? UNIT[shapeAxis] : local(order[2]), rot(c));
  const thin = rotatePoint(local(order[0]), rot(c));
  return { c, min, max, size, centre, axis, thin };
}

/**
 * Parts filling a role, largest first. Names are tried before descriptions: a
 * description like "joins the two supports" would otherwise make the cross bar
 * count as a support.
 */
function byRole(parts: Part[], role: unknown): Part[] {
  const re = new RegExp(String(role), 'i');
  const volume = (p: Part) => p.size[0] * p.size[1] * p.size[2];
  const byName = parts.filter((p) => re.test(p.c.name.replace(/_/g, ' ')));
  const found = byName.length ? byName : parts.filter((p) => re.test((p.c.description ?? '').replace(/_/g, ' ')));
  return found.sort((a, b) => volume(b) - volume(a));
}

const horizontal = (v: Vec3) => fromVertical(v) > 60;
const vertical = (v: Vec3) => fromVertical(v) < 30;
const sortedPlan = (p: Part) => [p.size[0], p.size[1]].sort((a, b) => b - a);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

function overlap1(p: Part, q: Part, i: number, gap = TOUCH_MM) {
  return p.min[i] <= q.max[i] + gap && q.min[i] <= p.max[i] + gap;
}
function touching(p: Part, q: Part) {
  return [0, 1, 2].every((i) => overlap1(p, q, i));
}
function planInside(p: Part, q: Part, tol = TOUCH_MM) {
  return [0, 1].every((i) => p.min[i] >= q.min[i] - tol && p.max[i] <= q.max[i] + tol);
}

/** Interior diameter of a holding feature: a tube's bore, or a shell's smaller inner span. */
function innerD(p: Part): number | null {
  const s = p.c.shape;
  if (s?.kind === 'tube' && typeof s.innerD === 'number') return s.innerD;
  if (s?.kind === 'shell' && typeof s.wall === 'number') {
    const ext = p.c.localExtents as Vec3;
    const open = s.openFace?.[1]?.toLowerCase();
    const spans = [0, 1, 2].filter((i) => 'xyz'[i] !== open).map((i) => ext[i] - 2 * s.wall!);
    return Math.min(...spans);
  }
  return null;
}

/** World normal of a shell's open face. */
function openNormal(p: Part): Vec3 | null {
  const f = p.c.shape?.kind === 'shell' ? p.c.shape.openFace : undefined;
  return f ? rotatePoint(FACE[f], rot(p.c)) : null;
}

/** World-space edges of a profile outline, as [length, degrees from horizontal]. */
function profileEdges(p: Part): [number, number][] {
  const s = p.c.shape;
  if (s?.kind !== 'profile' || !s.points || !s.plane) return [];
  const to3 = ([u, v]: number[]): Vec3 => (s.plane === 'xy' ? [u, v, 0] : s.plane === 'xz' ? [u, 0, v] : [0, u, v]);
  const pts = s.points.map((q) => rotatePoint(to3(q), rot(p.c)));
  return pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    return [norm(d), 90 - fromVertical(d)] as [number, number];
  });
}

/** The tilt of a part from horizontal, in degrees: a profile's long sloped edges, or a plate's face. */
function tilts(p: Part): number[] {
  const edges = profileEdges(p);
  if (edges.length) {
    const longest = Math.max(...edges.map((e) => e[0]));
    return edges.filter((e) => e[0] >= 0.3 * longest).map((e) => e[1]);
  }
  return [fromVertical(p.thin)];
}

type Check = Record<string, unknown>;
type Result = [Verdict, string];

function judge(check: Check, parts: Part[], spec: AssemblySpec): Result {
  const find = (role: unknown) => byRole(parts, role);
  const need = (role: unknown): Part[] | Result => {
    const got = find(role);
    return got.length ? got : ['fail', `no part matches /${role}/`];
  };
  const isResult = (x: Part[] | Result): x is Result => typeof x[0] === 'string';

  switch (check.type) {
    case 'componentCount': {
      const n = parts.length;
      return n >= (check.min as number) && n <= (check.max as number) ? ['pass', `${n} parts`] : ['fail', `${n} parts`];
    }
    case 'exists': {
      const got = find(check.role);
      return got.length ? ['pass', got.map((p) => p.c.name).join(', ')] : ['fail', `no part matches /${check.role}/`];
    }
    case 'count': {
      const got = need(check.role);
      if (isResult(got)) return got;
      if (got.length < (check.min as number) || got.length > (check.max as number)) return ['fail', `${got.length} matching parts`];
      if (check.thin === 'horizontal' && !got.every((p) => horizontal(p.thin))) return ['fail', 'not all stand upright'];
      if (check.axis === 'vertical' && !got.every((p) => vertical(p.axis))) return ['fail', 'not all have a vertical axis'];
      if (check.onPlate && !got.every((p) => near(p.min[2], 0, TOUCH_MM))) return ['fail', 'not all rest on z = 0'];
      if (check.openTop && !got.every((p) => p.c.shape?.kind === 'tube' || (openNormal(p)?.[2] ?? 0) > 0.9)) return ['fail', 'not all open at the top'];
      if (check.spacedApart && got.length >= 2 && touching(got[0], got[1])) return ['fail', 'the two touch'];
      if (typeof check.within === 'string') {
        const host = need(check.within);
        if (isResult(host)) return host;
        if (!got.every((p) => planInside(p, host[0]))) return ['fail', 'not inside the host'];
      }
      return ['pass', `${got.length} matching parts`];
    }
    case 'onPlate': {
      const got = need(check.role);
      if (isResult(got)) return got;
      const p = got[0];
      if (!near(p.min[2], 0, TOUCH_MM)) return ['fail', `lowest z ${p.min[2].toFixed(1)}`];
      if (check.thin === 'vertical' && !vertical(p.thin)) return ['fail', 'not lying flat'];
      return ['pass', 'on z = 0'];
    }
    case 'size': {
      const got = need(check.role);
      if (isResult(got)) return got;
      const tol = (check.tol as number) ?? 1;
      const p = got[0];
      if (check.onPlate && !near(p.min[2], 0, TOUCH_MM)) return ['fail', 'not on z = 0'];
      if (check.thin === 'vertical' && !vertical(p.thin)) return ['fail', 'not lying flat'];
      switch (check.measure) {
        case 'innerD':
        case 'seatD': {
          const ok = got.map(innerD).filter((d): d is number => d !== null);
          // A clip seat drawn as a profile outline has no declared bore to read: judged by eye.
          if (!ok.length) return check.measure === 'seatD' ? ['unchecked', 'seat drawn as an outline'] : ['fail', 'no bore declared (tube innerD or shell)'];
          return ok.every((d) => near(d, check.value as number, tol)) ? ['pass', `inner ${ok.join(', ')}`] : ['fail', `inner ${ok.join(', ')}`];
        }
        case 'footprint': {
          const want = [...(check.value as number[])].sort((a, b) => b - a);
          const have = sortedPlan(p);
          return near(have[0], want[0], tol) && near(have[1], want[1], tol) ? ['pass', `${have.join(' x ')}`] : ['fail', `${have.map((n) => n.toFixed(1)).join(' x ')}`];
        }
        case 'extents': {
          const want = [...(check.footprint as number[])].sort((a, b) => b - a);
          const have = sortedPlan(p);
          const ok = near(have[0], want[0], tol) && near(have[1], want[1], tol) && near(p.size[2], check.height as number, tol);
          return [ok ? 'pass' : 'fail', `${have.map((n) => n.toFixed(1)).join(' x ')} x ${p.size[2].toFixed(1)}`];
        }
        case 'cylinder': {
          const ext = p.c.localExtents as Vec3;
          const a = p.c.shape?.axis;
          if (!(p.c.shape?.kind === 'cylinder' || p.c.shape?.kind === 'tube') || !a) return ['fail', `shape is ${p.c.shape?.kind ?? 'box'}`];
          const i = 'xyz'.indexOf(a);
          const d = ext[(i + 1) % 3], len = ext[i];
          return near(d, check.diameter as number, tol) && near(len, check.length as number, tol) ? ['pass', `d ${d} x ${len}`] : ['fail', `d ${d} x ${len}`];
        }
        case 'innerFootprintMin': {
          const s = p.c.shape;
          if (s?.kind !== 'shell' || typeof s.wall !== 'number') return ['fail', 'not a shell'];
          const inside = sortedPlan(p).map((n) => n - 2 * s.wall!);
          const want = [...(check.value as number[])].sort((a, b) => b - a);
          return inside[0] >= want[0] - tol && inside[1] >= want[1] - tol ? ['pass', `inside ${inside.join(' x ')}`] : ['fail', `inside ${inside.map((n) => n.toFixed(1)).join(' x ')}`];
        }
      }
      return ['unchecked', `measure ${check.measure}`];
    }
    case 'axis': {
      const got = need(check.role);
      if (isResult(got)) return got;
      const p = got[0];
      const tilt = fromVertical(p.axis);
      const tol = (check.tiltTolDeg as number) ?? 30;
      if (check.axis === 'vertical' && tilt > tol) return ['fail', `axis ${tilt.toFixed(0)} deg from vertical`];
      if (check.axis === 'horizontal' && tilt < 90 - tol) return ['fail', `axis ${tilt.toFixed(0)} deg from vertical`];
      if (typeof check.length === 'number') {
        const len = Math.abs(dot(p.axis, p.size)) || Math.max(...p.size);
        const reach = check.orReach ? Math.max(...p.size) : len;
        if (!near(len, check.length, (check.tol as number) ?? 1) && !near(reach, check.length, (check.tol as number) ?? 1)) return ['fail', `length ${len.toFixed(1)}`];
      }
      return ['pass', `axis ${tilt.toFixed(0)} deg from vertical`];
    }
    case 'angle':
    case 'topSlope': {
      const got = need(check.role);
      if (isResult(got)) return got;
      const want = check.degFromHorizontal as number, tol = (check.tol as number) ?? 3;
      const found = got.flatMap(tilts);
      return found.some((t) => near(t, want, tol)) ? ['pass', `found ${want} deg`] : ['fail', `tilts ${[...new Set(found.map((t) => Math.round(t)))].join(', ')} deg`];
    }
    case 'holes': {
      const got = need(check.role);
      if (isResult(got)) return got;
      const p = got[0];
      const holes = p.c.holes ?? [];
      const along = check.alongThin ? holes.filter((h) => Math.abs(dot(rotatePoint(UNIT[h.axis], rot(p.c)), p.thin)) > 0.9) : holes;
      return along.length >= (check.min as number) ? ['pass', `${along.length} holes`] : ['fail', `${along.length} holes through the thickness`];
    }
    case 'touches':
    case 'covers':
    case 'attachedOffset':
    case 'slotsInto':
    case 'inside': {
      const a = need(check.a), b = need(check.b);
      if (isResult(a)) return a;
      if (isResult(b)) return b;
      const p = a[0], q = b[0];
      if (check.type === 'inside') {
        const ok = [0, 1, 2].every((i) => p.min[i] >= q.min[i] - TOUCH_MM && p.max[i] <= q.max[i] + TOUCH_MM);
        if (!ok) return ['fail', 'not inside'];
        if (check.openFace === '+Z' && (openNormal(p)?.[2] ?? 0) < 0.9) return ['fail', 'not open at the top'];
        return ['pass', 'inside'];
      }
      if (check.type === 'slotsInto') {
        const joint = (spec.jointContracts ?? []).some((j) => [j.partA, j.partB].includes(p.c.name) && [j.partA, j.partB].includes(q.c.name));
        const sunk = p.min[2] < q.max[2] - 0.5 && overlap1(p, q, 0, 0) && overlap1(p, q, 1, 0);
        return joint || sunk ? ['pass', joint ? 'joint declared' : 'foot sits below the base top'] : ['fail', 'only touches'];
      }
      if (check.type === 'attachedOffset') {
        // The free side of an upright plate is its front; the attached part must sit off it.
        // Touching is not required: a ring held off the wall by an arm is attached through
        // the arm, and a part attached to nothing is the floating audit's finding, not this one.
        const n = q.thin.map(Math.abs) as Vec3;
        const i = n.indexOf(Math.max(...n));
        // By centre, so a ring fused a few mm into the plate still counts as in front of it.
        const off = p.centre[i] >= q.max[i] || p.centre[i] <= q.min[i];
        return off ? ['pass', 'in front of the plate'] : ['fail', 'passes through or behind the plate'];
      }
      if (!a.every((x) => touching(x, q))) return ['fail', 'not touching'];
      if (check.type === 'covers') {
        const above = p.min[2] >= q.max[2] - (q.size[2] * 0.5);
        const cover = sortedPlan(p)[0] >= sortedPlan(q)[0] - 2 && sortedPlan(p)[1] >= sortedPlan(q)[1] - 2;
        return above && cover ? ['pass', 'covers'] : ['fail', above ? 'smaller than the body' : 'not on top'];
      }
      switch (check.side) {
        case 'above': {
          const ok = a.every((x) => x.min[2] >= q.max[2] - TOUCH_MM - 0.01);
          if (!ok) return ['fail', 'not above'];
          if (check.within && !a.every((x) => planInside(x, q))) return ['fail', 'outside the footprint'];
          return ['pass', 'above'];
        }
        case 'top':
        case 'upperHalf': {
          const mid = q.min[2] + q.size[2] / 2;
          return p.centre[2] >= mid ? ['pass', 'upper half'] : ['fail', 'lower half'];
        }
        default:
          return ['pass', 'touching'];
      }
    }
    case 'spans': {
      const a = need(check.role), b = need(check.between);
      if (isResult(a)) return a;
      if (isResult(b)) return b;
      const others = b.filter((q) => !a.includes(q));
      const p = a[0];
      if (others.length < 2) return ['fail', `${others.length} supports`];
      if (!others.slice(0, 2).every((q) => touching(p, q))) return ['fail', 'does not reach both'];
      return horizontal(p.axis) ? ['pass', 'spans both'] : ['fail', 'not horizontal'];
    }
    case 'perpendicular': {
      const a = need(check.a), b = need(check.b);
      if (isResult(a)) return a;
      if (isResult(b)) return b;
      const ang = deg(Math.acos(Math.min(1, Math.abs(dot(a[0].axis, b[0].axis)) / (norm(a[0].axis) * norm(b[0].axis)))));
      return near(ang, 90, (check.tolDeg as number) ?? 2) ? ['pass', `${ang.toFixed(0)} deg`] : ['fail', `${ang.toFixed(0)} deg`];
    }
    case 'pattern': {
      const got = need(check.role);
      if (isResult(got)) return got;
      const xs = [...new Set(got.map((p) => Math.round(p.centre[0])))].sort((m, n) => m - n);
      const ys = [...new Set(got.map((p) => Math.round(p.centre[1])))].sort((m, n) => m - n);
      if (xs.length !== 2 || ys.length !== 2) return ['fail', 'not a 2 x 2 grid'];
      const have = [xs[1] - xs[0], ys[1] - ys[0]].sort((m, n) => n - m);
      const want = [...(check.spacing as number[])].sort((m, n) => n - m);
      const tol = (check.tol as number) ?? 1;
      return near(have[0], want[0], tol + 1) && near(have[1], want[1], tol + 1) ? ['pass', `${have.join(' x ')}`] : ['fail', `${have.join(' x ')}`];
    }
    case 'atTop': {
      const a = need(check.role), b = need(check.of);
      if (isResult(a)) return a;
      if (isResult(b)) return b;
      const top = Math.max(...b.filter((q) => !a.includes(q)).map((q) => q.max[2]));
      return a[0].centre[2] >= 0.6 * top ? ['pass', 'raised'] : ['fail', `centre at ${a[0].centre[2].toFixed(0)} of ${top.toFixed(0)}`];
    }
    case 'taper': {
      const got = need(check.role);
      if (isResult(got)) return got;
      const s = got[0].c.shape;
      if (s?.kind !== 'profile' || !s.points?.length) return ['fail', `shape is ${s?.kind ?? 'box'}, not a tapered profile`];
      if (s.plane === 'xy') return ['fail', 'outline lies flat'];
      const vs = s.points.map((q) => q[1]);
      const lo = Math.min(...vs), hi = Math.max(...vs), band = (hi - lo) * 0.15;
      const width = (pred: (v: number) => boolean) => {
        const us = s.points!.filter((q) => pred(q[1])).map((q) => q[0]);
        return us.length ? Math.max(...us) - Math.min(...us) : 0;
      };
      const bottom = width((v) => v <= lo + band), top = width((v) => v >= hi - band);
      return bottom > top + 1 ? ['pass', `foot ${bottom.toFixed(0)} > top ${top.toFixed(0)}`] : ['fail', `foot ${bottom.toFixed(0)}, top ${top.toFixed(0)}`];
    }
    case 'diagonalBetween': {
      const g = need(check.role), a = need(check.a), b = need(check.b);
      for (const r of [g, a, b]) if (isResult(r)) return r;
      const p = (g as Part[])[0];
      const slanted = tilts(p).some((t) => t > 15 && t < 75);
      const joins = touching(p, (a as Part[])[0]) && touching(p, (b as Part[])[0]);
      return slanted && joins ? ['pass', 'diagonal, joins both'] : ['fail', !slanted ? 'not diagonal' : 'does not join both'];
    }
    case 'openFace': {
      const got = need(check.role);
      if (isResult(got)) return got;
      const n = openNormal(got[0]);
      if (!n) return ['fail', `shape is ${got[0].c.shape?.kind ?? 'box'}, not an open shell`];
      if (check.onPlate && !near(got[0].min[2], 0, TOUCH_MM)) return ['fail', 'not on z = 0'];
      if (check.face === '+Z') return n[2] > 0.9 ? ['pass', 'open at the top'] : ['fail', 'opening does not face up'];
      if (check.face === 'vertical') return Math.abs(n[2]) < 0.1 ? ['pass', 'open at the side'] : ['fail', 'opening faces up or down'];
      return ['unchecked', `face ${check.face}`];
    }
    case 'protrudes': {
      const a = need(check.a), b = need(check.from);
      if (isResult(a)) return a;
      if (isResult(b)) return b;
      if (!touching(a[0], b[0])) return ['fail', 'not attached to the drawer'];
      const shell = parts.find((p) => p.c.shape?.kind === 'shell' && p !== b[0]);
      if (!shell) return ['unchecked', 'no outer shell to compare against'];
      const outside = [0, 1].some((i) => a[0].min[i] < shell.min[i] - 0.5 || a[0].max[i] > shell.max[i] + 0.5);
      return outside ? ['pass', 'sticks out of the shell'] : ['fail', 'hidden inside the shell'];
    }
    case 'axisAngle': {
      // A peg or arm's own axis, in degrees above horizontal.
      const got = need(check.role);
      if (isResult(got)) return got;
      const want = check.degFromHorizontal as number, tol = (check.tol as number) ?? 5;
      const found = got.map((p) => 90 - fromVertical(p.axis));
      return found.every((t) => near(t, want, tol)) ? ['pass', `${want} deg`] : ['fail', `axes at ${found.map((t) => Math.round(t)).join(', ')} deg`];
    }
    case 'opensUp': {
      // Something drops in from above: a tube standing on end, or a shell open at the top.
      const got = need(check.role);
      if (isResult(got)) return got;
      const p = got[0];
      const up = (p.c.shape?.kind === 'tube' && vertical(p.axis)) || (openNormal(p)?.[2] ?? 0) > 0.9;
      return up ? ['pass', 'opens upward'] : ['fail', `${p.c.shape?.kind ?? 'box'} does not open upward`];
    }
    case 'heightEither':
    case 'atTallEnd':
      return ['unchecked', `${check.type} is judged by eye`];
  }
  return ['unchecked', `unknown check ${String(check.type)}`];
}

export function checkIntent(spec: AssemblySpec, facts: Fact[]): FactResult[] {
  const parts = (spec.components ?? []).map(place).filter((p): p is Part => p !== null);
  return facts.map((f) => {
    const [verdict, why] = f.check ? judge(f.check, parts, spec) : (['unchecked', 'judged by eye'] as Result);
    return { says: f.says, interpretation: f.reading === 'interpretation', verdict, why };
  });
}

/** Share of checked facts that pass, and whether every checked fact passed. */
export function intentScore(results: FactResult[]): { checked: number; passed: number; allPass: boolean } {
  const checked = results.filter((r) => r.verdict !== 'unchecked');
  const passed = checked.filter((r) => r.verdict === 'pass').length;
  return { checked: checked.length, passed, allPass: checked.length > 0 && passed === checked.length };
}
