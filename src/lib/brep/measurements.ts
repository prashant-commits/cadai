import type { ModelInfo } from '@/types';
import type { BrepResult } from '../engine/brep-runner';
import { analyzeStl } from '../engine/geometry-utils';

type Vec3 = [number, number, number];

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
