import { describe, it, expect } from 'vitest';
import { stlToAscii, toModelInfo } from './measurements';

describe('stlToAscii', () => {
  it('converts a binary STL to ASCII and passes ASCII through', () => {
    const buf = Buffer.alloc(84 + 50);
    buf.writeUInt32LE(1, 80);
    [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => buf.writeFloatLE(v, 84 + i * 4));
    const ascii = stlToAscii(buf.toString('base64'));
    expect(ascii).toContain('facet normal 0 0 1');
    expect(ascii.match(/vertex/g)).toHaveLength(3);
    expect(stlToAscii(Buffer.from(ascii).toString('base64'))).toBe(ascii);
  });

  it('converts a binary STL whose header starts with "solid" and mentions facet', () => {
    const buf = Buffer.alloc(84 + 50);
    buf.write('solid part exported with facet data', 0, 'latin1');
    buf.writeUInt32LE(1, 80);
    [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => buf.writeFloatLE(v, 84 + i * 4));
    expect(stlToAscii(buf.toString('base64'))).toContain('facet normal 0 0 1');
  });
});

const ASCII_STL =
  'solid model\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid model\n';

describe('toModelInfo', () => {
  it('converts brep runner output to ModelInfo', () => {
    const info = toModelInfo(
      {
        ok: true,
        solids: 1,
        ms: 10,
        bbox: { min: [0, 0, 0], max: [10, 20, 30] },
        parts: [{ label: 'base', valid: true, volume: 6000, min: [0, 0, 0], max: [10, 20, 30] }],
      },
      ASCII_STL
    );
    expect(info.shellCount).toBe(1);
    expect(info.compileTimeMs).toBe(10);
    expect(info.dimensions).toEqual({ x: 10, y: 20, z: 30 });
    expect(info.isManifold).toBe(true);
  });
});
