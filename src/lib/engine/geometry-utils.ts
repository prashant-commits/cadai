import * as THREE from 'three';
import { STLLoader } from 'three-stdlib';
import { ModelInfo } from '@/types';

const stlLoader = new STLLoader();

/** A facet is "flat on the bed" when every vertex sits at the model's lowest Z. */
const BED_EPSILON = 1e-3;
/** Overhang measured from vertical: 0deg is a wall, 90deg is a horizontal bridge. */
const OVERHANG_LIMIT_DEG = 45;

/**
 * Parses ASCII STL text directly (no THREE dependency) to compute pure numeric metrics.
 *
 * Runs two passes: the bounding box must be final before any facet can be tested
 * against the build plate, otherwise facets are compared to a running minimum.
 */
export function analyzeStl(stlContent: string): ModelInfo {
  const lines = stlContent.split('\n');

  // ---- Pass 1: bounding box only ----
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let sawVertex = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('vertex')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    sawVertex = true;
    for (let j = 0; j < 3; j++) {
      const v = parseFloat(parts[j + 1]);
      if (v < min[j]) min[j] = v;
      if (v > max[j]) max[j] = v;
    }
  }

  if (!sawVertex) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  const bottomZ = min[2];

  // ---- Pass 2: per-facet measurements against the final bounding box ----
  let volume = 0;
  let bottomArea = 0;
  let surfaceArea = 0;
  let unsupportedArea = 0;
  let maxOverhang = 0;
  let triangleCount = 0;
  const comAccum: [number, number, number] = [0, 0, 0];

  let currentNormal: [number, number, number] = [0, 0, 0];
  let currentVertices: number[][] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('facet normal')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 5) {
        currentNormal = [parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4])];
      }
      currentVertices = [];
    } else if (line.startsWith('vertex')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 4) {
        currentVertices.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3]),
        ]);
      }
    } else if (line.startsWith('endfacet')) {
      if (currentVertices.length === 3) {
        triangleCount++;
        const [p1, p2, p3] = currentVertices;

        // Signed tetrahedron volume against the origin.
        const signedVol =
          (p1[0] * p2[1] * p3[2] -
            p1[0] * p3[1] * p2[2] -
            p2[0] * p1[1] * p3[2] +
            p2[0] * p3[1] * p1[2] +
            p3[0] * p1[1] * p2[2] -
            p3[0] * p2[1] * p1[2]) /
          6.0;
        volume += signedVol;

        // Centroid of that tetrahedron is (p1+p2+p3+origin)/4, weighted by its volume.
        for (let j = 0; j < 3; j++) {
          comAccum[j] += signedVol * ((p1[j] + p2[j] + p3[j]) / 4.0);
        }

        const v1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
        const v2 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
        const cross = [
          v1[1] * v2[2] - v1[2] * v2[1],
          v1[2] * v2[0] - v1[0] * v2[2],
          v1[0] * v2[1] - v1[1] * v2[0],
        ];
        const area = Math.hypot(cross[0], cross[1], cross[2]) / 2.0;
        surfaceArea += area;

        const nz = currentNormal[2];
        const onBed =
          Math.abs(p1[2] - bottomZ) < BED_EPSILON &&
          Math.abs(p2[2] - bottomZ) < BED_EPSILON &&
          Math.abs(p3[2] - bottomZ) < BED_EPSILON;

        if (onBed && nz < -0.99) {
          bottomArea += area;
        }

        // Down-facing geometry resting on the build plate is supported by the
        // plate itself and must not be counted as an overhang.
        if (nz < -1e-4 && !onBed) {
          const angleFromVertical = Math.asin(Math.min(1, Math.abs(nz))) * (180 / Math.PI);
          if (angleFromVertical > maxOverhang) maxOverhang = angleFromVertical;
          if (angleFromVertical > OVERHANG_LIMIT_DEG) {
            unsupportedArea += area;
          }
        }
      }
      currentVertices = [];
    }
  }

  const volumeMm3 = Math.abs(volume);
  const centerOfMass: [number, number, number] =
    Math.abs(volume) > 1e-9
      ? [
          Number((comAccum[0] / volume).toFixed(2)),
          Number((comAccum[1] / volume).toFixed(2)),
          Number((comAccum[2] / volume).toFixed(2)),
        ]
      : [0, 0, 0];

  return {
    dimensions: {
      x: Number((max[0] - min[0]).toFixed(2)),
      y: Number((max[1] - min[1]).toFixed(2)),
      z: Number((max[2] - min[2]).toFixed(2)),
    },
    volumeMm3: Number(volumeMm3.toFixed(2)),
    triangleCount,
    vertexCount: triangleCount * 3,
    isWatertight: triangleCount > 0 && volumeMm3 > 1e-4, // Fallback heuristic; isManifold is authoritative
    isFlatPackable: bottomArea > 10.0,
    boundingBox: {
      min: [Number(min[0].toFixed(2)), Number(min[1].toFixed(2)), Number(min[2].toFixed(2))],
      max: [Number(max[0].toFixed(2)), Number(max[1].toFixed(2)), Number(max[2].toFixed(2))],
    },
    bottomAreaMm2: Number(bottomArea.toFixed(2)),
    surfaceAreaMm2: Number(surfaceArea.toFixed(2)),
    centerOfMass,
    massGrams: {
      pla: Number((volumeMm3 * 0.00124).toFixed(2)),
      petg: Number((volumeMm3 * 0.00127).toFixed(2)),
    },
    overhang: {
      unsupportedAreaMm2: Number(unsupportedArea.toFixed(2)),
      maxOverhangDeg: Number(maxOverhang.toFixed(1)),
    },
  };
}

/**
 * Parses STL text/buffer and computes comprehensive 3D model metadata, returning THREE Geometry for client.
 */
export function parseStlToGeometry(stlContent: string): {
  geometry: THREE.BufferGeometry;
  modelInfo: ModelInfo;
} {
  const geometry = stlLoader.parse(stlContent);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const modelInfo = analyzeStl(stlContent);

  return { geometry, modelInfo };
}
