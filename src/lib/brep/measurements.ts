import type { AssemblySpec } from '../agent/assembly-spec';
import type { ModelInfo } from '@/types';
import type { BrepResult } from '../engine/brep-runner';
import type { ModuleFrame } from '../engine/module-frames';
import { analyzeStl } from '../engine/geometry-utils';
import { placedBounds, type Vec3 } from '../design/placement-geometry';
import { buildPlacementComponents, type PlacementReport } from '../design/placement-report';

/**
 * Adapters from a B-rep run to the shapes the OpenSCAD audits already take:
 * `ModuleFrame[]` (per-part boxes), `ModelInfo` (whole-model measurements) and
 * `PlacementReport` (what placement-audit consumes).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const round2v = (v: readonly number[]): Vec3 => [round2(v[0]), round2(v[1]), round2(v[2])];

/** Decodes a base64 STL to ASCII; a binary STL is converted facet by facet. */
export function stlToAscii(base64: string): string {
  const buf = Buffer.from(base64, 'base64');
  // A binary STL is an 80-byte header, a u32 facet count and 50 bytes per facet,
  // exactly. The header may start with "solid", so the size is the only reliable test.
  if (buf.length >= 84) {
    const count = buf.readUInt32LE(80);
    if (count > 0 && buf.length === 84 + count * 50) return binaryToAscii(buf, count);
  }
  return buf.toString('utf-8');
}

function binaryToAscii(buf: Buffer, count: number): string {
  const lines: string[] = ['solid model'];
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50;
    const f = (k: number) => buf.readFloatLE(o + k * 4);
    lines.push(`facet normal ${f(0)} ${f(1)} ${f(2)}`, 'outer loop');
    for (let v = 0; v < 3; v++) lines.push(`vertex ${f(3 + v * 3)} ${f(4 + v * 3)} ${f(5 + v * 3)}`);
    lines.push('endloop', 'endfacet');
  }
  lines.push('endsolid model');
  return `${lines.join('\n')}\n`;
}

/** One frame per measured part, in assembly coordinates (the runner measures parts after placement). */
export function toModuleFrames(r: BrepResult): ModuleFrame[] {
  return r.parts.map((part) => ({
    name: part.label,
    valid: part.valid && part.volume > 0,
    min: round2v(part.min),
    max: round2v(part.max),
    size: round2v([part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]]),
  }));
}

/** Whole-model measurements: the mesh analysis, with the kernel's own box and validity on top. */
export function toModelInfo(r: BrepResult, asciiStl: string): ModelInfo {
  const info = analyzeStl(asciiStl);
  info.isManifold = r.parts.every((part) => part.valid);
  info.shellCount = r.solids;
  info.compileTimeMs = r.ms;
  if (r.bbox) {
    const min = round2v(r.bbox.min);
    const max = round2v(r.bbox.max);
    info.dimensions = { x: round2(max[0] - min[0]), y: round2(max[1] - min[1]), z: round2(max[2] - min[2]) };
    info.boundingBox = { min, max };
  }
  return info;
}

/**
 * The placement report for a B-rep run. The local size is reconstructed from
 * the placed size, which is exact for an unrotated part but can miss a swapped
 * size on a rotated one. When the script also lists each component's own-frame
 * solid (`local`), that size is compared too, and per axis the one farther from
 * the spec is reported.
 */
export function toPlacementReport(spec: AssemblySpec, frames: ModuleFrame[], localFrames?: ModuleFrame[]): PlacementReport {
  const byName = new Map(frames.map((f) => [f.name, f]));
  const localByName = new Map((localFrames ?? []).map((f) => [f.name, f]));
  const local: ModuleFrame[] = [];
  const placed = new Map<string, { min: Vec3; max: Vec3 }>();
  for (const comp of spec.components ?? []) {
    const frame = byName.get(comp.name);
    const ext = comp.localExtents as Vec3 | undefined;
    if (!frame || !frame.valid || !ext) continue;
    const position = (comp.position ?? [0, 0, 0]) as Vec3;
    const rotation = (comp.rotation ?? [0, 0, 0]) as Vec3;
    const expected = placedBounds({ min: [0, 0, 0], max: [ext[0], ext[1], ext[2]] }, position, rotation);
    const fromPlaced = [0, 1, 2].map((i) => round2(ext[i] + (frame.size[i] - (expected.max[i] - expected.min[i])))) as Vec3;
    // Both measurements must agree with the spec: per axis keep whichever is farther from it, so a
    // wrong own-frame size (hidden by a rotation) and a wrong placed box are both reported.
    const own = localByName.get(comp.name);
    const size = own?.valid
      ? ([0, 1, 2].map((i) => (Math.abs(own.size[i] - ext[i]) >= Math.abs(fromPlaced[i] - ext[i]) ? own.size[i] : fromPlaced[i])) as Vec3)
      : fromPlaced;
    local.push({ name: comp.name, valid: true, min: [0, 0, 0], max: size, size });
    placed.set(comp.name, { min: frame.min, max: frame.max });
  }
  const components = buildPlacementComponents(spec, local, false).map((c) => {
    const box = placed.get(c.name);
    return box ? { ...c, placedMin: box.min, placedMax: box.max } : c;
  });
  return { composed: true, removedStatements: 0, components };
}
