import * as THREE from 'three';
import { STLLoader } from 'three-stdlib';
import { ModelInfo } from '@/types';

const stlLoader = new STLLoader();

/**
 * Parses STL text/buffer and computes comprehensive 3D model metadata.
 */
export function parseStlToGeometry(stlContent: string): {
  geometry: THREE.BufferGeometry;
  modelInfo: ModelInfo;
} {
  const geometry = stlLoader.parse(stlContent);

  // Compute normals if missing or needs recalculation
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  const bbox = geometry.boundingBox || new THREE.Box3();
  const size = new THREE.Vector3();
  bbox.getSize(size);

  const positionAttr = geometry.getAttribute('position');
  const vertexCount = positionAttr.count;
  const triangleCount = vertexCount / 3;

  // Calculate volume using signed tetrahedron method
  let volume = 0;
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const p3 = new THREE.Vector3();

  for (let i = 0; i < vertexCount; i += 3) {
    p1.fromBufferAttribute(positionAttr, i);
    p2.fromBufferAttribute(positionAttr, i + 1);
    p3.fromBufferAttribute(positionAttr, i + 2);

    // Signed volume of tetrahedron formed with origin
    volume += p1.dot(p2.clone().cross(p3)) / 6.0;
  }

  const volumeMm3 = Math.abs(volume);

  // Flat-Pack Verification (Coplanar with Z=0)
  // We check if there's a significant surface area whose vertices are at the bottom Z coordinate and normals point down.
  let bottomArea = 0;
  const normalAttr = geometry.getAttribute('normal');
  const bottomZ = bbox.min.z;
  
  if (normalAttr) {
    for (let i = 0; i < vertexCount; i += 3) {
      p1.fromBufferAttribute(positionAttr, i);
      p2.fromBufferAttribute(positionAttr, i + 1);
      p3.fromBufferAttribute(positionAttr, i + 2);
      
      const n1 = new THREE.Vector3().fromBufferAttribute(normalAttr, i);
      
      // Check if triangle is approximately at the bottom and normal is pointing down
      if (Math.abs(p1.z - bottomZ) < 1e-3 && Math.abs(p2.z - bottomZ) < 1e-3 && Math.abs(p3.z - bottomZ) < 1e-3) {
        if (n1.z < -0.99) {
          const v1 = p2.clone().sub(p1);
          const v2 = p3.clone().sub(p1);
          bottomArea += v1.cross(v2).length() / 2.0;
        }
      }
    }
  }
  
  // Consider flat-packable if bottom area is at least 10 mm^2 (arbitrary threshold for a stable base)
  const isFlatPackable = bottomArea > 10.0;

  const modelInfo: ModelInfo = {
    dimensions: {
      x: Number(size.x.toFixed(2)),
      y: Number(size.y.toFixed(2)),
      z: Number(size.z.toFixed(2)),
    },
    volumeMm3: Number(volumeMm3.toFixed(2)),
    triangleCount,
    vertexCount,
    isWatertight: triangleCount > 0 && Math.abs(volume) > 1e-4,
    isFlatPackable,
    boundingBox: {
      min: [Number(bbox.min.x.toFixed(2)), Number(bbox.min.y.toFixed(2)), Number(bbox.min.z.toFixed(2))],
      max: [Number(bbox.max.x.toFixed(2)), Number(bbox.max.y.toFixed(2)), Number(bbox.max.z.toFixed(2))],
    },
  };

  return { geometry, modelInfo };
}
