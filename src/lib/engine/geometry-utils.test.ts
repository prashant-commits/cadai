import { describe, it, expect } from 'vitest';
import { analyzeStl, parseStlToGeometry } from './geometry-utils';

const CLOSED_CUBE_STL = `solid cube
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
  facet normal 0 -1 0
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 10 0 10
    endloop
  endfacet
  facet normal 0 -1 0
    outer loop
      vertex 0 0 0
      vertex 10 0 10
      vertex 0 0 10
    endloop
  endfacet
  facet normal 1 0 0
    outer loop
      vertex 10 0 0
      vertex 10 10 0
      vertex 10 10 10
    endloop
  endfacet
  facet normal 1 0 0
    outer loop
      vertex 10 0 0
      vertex 10 10 10
      vertex 10 0 10
    endloop
  endfacet
  facet normal 0 1 0
    outer loop
      vertex 10 10 0
      vertex 0 10 0
      vertex 0 10 10
    endloop
  endfacet
  facet normal 0 1 0
    outer loop
      vertex 10 10 0
      vertex 0 10 10
      vertex 10 10 10
    endloop
  endfacet
  facet normal -1 0 0
    outer loop
      vertex 0 10 0
      vertex 0 0 0
      vertex 0 0 10
    endloop
  endfacet
  facet normal -1 0 0
    outer loop
      vertex 0 10 0
      vertex 0 0 10
      vertex 0 10 10
    endloop
  endfacet
endsolid cube`;

describe('analyzeStl', () => {
  it('calculates metrics for a 12-triangle closed cube', () => {
    const info = analyzeStl(CLOSED_CUBE_STL);

    expect(info.triangleCount).toBe(12);
    expect(info.vertexCount).toBe(36);
    expect(info.dimensions.x).toBeCloseTo(10);
    expect(info.dimensions.y).toBeCloseTo(10);
    expect(info.dimensions.z).toBeCloseTo(10);
    expect(info.volumeMm3).toBeCloseTo(1000); // 10x10x10
    expect(info.surfaceAreaMm2).toBeCloseTo(600); // 6 faces * 100
  });

  it('locates the centre of mass of the closed cube', () => {
    const info = analyzeStl(CLOSED_CUBE_STL);
    expect(info.centerOfMass?.[0]).toBeCloseTo(5);
    expect(info.centerOfMass?.[1]).toBeCloseTo(5);
    expect(info.centerOfMass?.[2]).toBeCloseTo(5);
  });

  it('does not count the build-plate face as an overhang', () => {
    // The cube's bottom face points straight down but rests on the bed, so it
    // is supported by the plate and must not appear as unsupported area.
    const info = analyzeStl(CLOSED_CUBE_STL);
    expect(info.bottomAreaMm2).toBeCloseTo(100);
    expect(info.overhang?.unsupportedAreaMm2).toBeCloseTo(0);
  });

  it('measures the bed face against the final bounding box, not a running minimum', () => {
    // A down-facing face at z=5 is written BEFORE the true lowest face at z=0.
    // A single-pass scan compares each facet to the minimum seen so far and
    // wrongly credits the z=5 face as bed contact.
    const STAGGERED = `solid staggered
  facet normal 0 0 -1
    outer loop
      vertex 0 0 5
      vertex 10 10 5
      vertex 10 0 5
    endloop
  endfacet
  facet normal 0 0 -1
    outer loop
      vertex 0 0 5
      vertex 0 10 5
      vertex 10 10 5
    endloop
  endfacet
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
endsolid staggered`;

    const info = analyzeStl(STAGGERED);
    expect(info.boundingBox.min[2]).toBe(0);
    // Only the z=0 pair touches the plate: 100mm2, not 200mm2.
    expect(info.bottomAreaMm2).toBeCloseTo(100);
    // The elevated pair is a horizontal bridge with nothing beneath it.
    expect(info.overhang?.unsupportedAreaMm2).toBeCloseTo(100);
    expect(info.overhang?.maxOverhangDeg).toBeCloseTo(90);
  });

  it('calculates metrics for a 2-shell fixture', () => {
    // Two cubes next to each other
    const TWO_SHELL_STL = CLOSED_CUBE_STL + '\n' + CLOSED_CUBE_STL.replace(/vertex /g, 'vertex 20 ');
    // Our parser does not literally count shells by traversing connectivity, 
    // it relies on WASM output for shellCount. However, analyzeStl does pure numeric calculations.
    const info = analyzeStl(TWO_SHELL_STL);

    expect(info.triangleCount).toBe(24);
    expect(info.vertexCount).toBe(72);
  });
});

describe('parseStlToGeometry', () => {
  it('parses STL and extracts bounding box and triangle metrics', () => {
    const { geometry, modelInfo } = parseStlToGeometry(CLOSED_CUBE_STL);

    expect(geometry).toBeDefined();
    expect(modelInfo.triangleCount).toBe(12);
    expect(modelInfo.vertexCount).toBe(36);
  });
});
