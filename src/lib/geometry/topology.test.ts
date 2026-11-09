import { describe, it, expect } from 'vitest';
import { decodeTopology, faceAtTriangle, type Topology } from './topology';

describe('topology', () => {
  it('decodeTopology round-trips typed arrays', () => {
    const raw = {
      mesh: {
        positions: [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
        indices: [0, 1, 2],
        faceIds: [42],
      },
      faces: [
        {
          id: 42,
          part: 'body',
          kind: 'plane',
          area: 100,
          center: [1, 2, 3],
          normal: [0, 0, 1],
        },
      ],
      edges: [
        {
          id: 1,
          kind: 'line',
          length: 10,
          faces: [42, 42],
        },
      ],
      parts: [
        {
          label: 'body',
          min: [0, 0, 0],
          max: [10, 10, 10],
        },
      ],
    };

    const decoded = decodeTopology(raw);

    expect(decoded.mesh.positions).toBeInstanceOf(Float32Array);
    expect(Array.from(decoded.mesh.positions)).toEqual(raw.mesh.positions);

    expect(decoded.mesh.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(decoded.mesh.indices)).toEqual(raw.mesh.indices);

    expect(decoded.mesh.faceIds).toBeInstanceOf(Uint32Array);
    expect(Array.from(decoded.mesh.faceIds)).toEqual(raw.mesh.faceIds);

    expect(decoded.faces).toEqual(raw.faces);
    expect(decoded.edges).toEqual(raw.edges);
    expect(decoded.parts).toEqual(raw.parts);
  });

  it('faceAtTriangle returns the face of that triangle', () => {
    const topo: Topology = {
      mesh: {
        positions: new Float32Array([
          0, 0, 0, 1, 0, 0, 0, 1, 0,
          1, 0, 0, 1, 1, 0, 0, 1, 0,
        ]),
        indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
        faceIds: new Uint32Array([10, 20]),
      },
      faces: [
        { id: 10, part: 'base', kind: 'plane', area: 50, center: [0.33, 0.33, 0] },
        { id: 20, part: 'lid', kind: 'cylinder', area: 50, center: [0.66, 0.66, 0], radius: 5, axis: [0, 0, 1] },
      ],
      edges: [],
      parts: [
        { label: 'base', min: [0, 0, 0], max: [1, 1, 0] },
        { label: 'lid', min: [0, 0, 0], max: [1, 1, 0] },
      ],
    };

    expect(faceAtTriangle(topo, 0)).toEqual(topo.faces[0]);
    expect(faceAtTriangle(topo, 1)).toEqual(topo.faces[1]);
    expect(faceAtTriangle(topo, -1)).toBeNull();
    expect(faceAtTriangle(topo, 2)).toBeNull();
    expect(faceAtTriangle(topo, 99)).toBeNull();
  });
});
