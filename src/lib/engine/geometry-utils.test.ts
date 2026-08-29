import { describe, it, expect } from 'vitest';
import { parseStlToGeometry } from './geometry-utils';

const SAMPLE_CUBE_STL = `solid cube
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 10 10 0
      vertex 10 0 0
    endloop
  endfacet
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 0 10 0
      vertex 10 10 0
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 0 0 10
      vertex 10 0 10
      vertex 10 10 10
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 0 0 10
      vertex 10 10 10
      vertex 0 10 10
    endloop
  endfacet
endsolid cube`;

describe('parseStlToGeometry', () => {
  it('parses STL and extracts bounding box and triangle metrics', () => {
    const { geometry, modelInfo } = parseStlToGeometry(SAMPLE_CUBE_STL);

    expect(geometry).toBeDefined();
    expect(modelInfo.triangleCount).toBe(4);
    expect(modelInfo.vertexCount).toBe(12);
    expect(modelInfo.dimensions.x).toBe(10);
    expect(modelInfo.dimensions.y).toBe(10);
    expect(modelInfo.dimensions.z).toBe(10);
  });
});
