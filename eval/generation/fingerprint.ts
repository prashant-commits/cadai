import { createHash } from 'node:crypto';
import { stlToAscii } from '@/lib/brep/measurements';

/**
 * A geometry fingerprint of an STL (base64, binary or ASCII): sha256 over the
 * triangles with every vertex rounded to 1e-4 and both the vertices within a
 * triangle and the triangles themselves sorted, so tessellation order and float
 * formatting do not matter but any moved face, hole or edge does. It sees what
 * a bbox or volume cannot, such as a through-hole sliding inside a plate.
 */
export function stlFingerprint(stlBase64: string): string {
  const text = stlToAscii(stlBase64);
  const round = (n: string) => (Math.round(Number(n) * 1e4) / 1e4 + 0).toFixed(4);
  const triangles: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('vertex')) continue;
    const [, x, y, z] = t.split(/\s+/);
    current.push(`${round(x)},${round(y)},${round(z)}`);
    if (current.length === 3) {
      triangles.push(current.sort().join(';'));
      current = [];
    }
  }
  return createHash('sha256').update(triangles.sort().join('\n')).digest('hex');
}
