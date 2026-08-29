'use client';

import React, { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useAppStore } from '@/store/app-store';

interface CadModelProps {
  geometry: THREE.BufferGeometry;
}

export function CadModel({ geometry }: CadModelProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { viewportSettings } = useAppStore();
  const { camera, controls } = useThree();

  // Compute bounding box, center offset, and dimensions
  const { offset, maxDim, center } = useMemo(() => {
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox || new THREE.Box3();
    const c = new THREE.Vector3();
    bbox.getCenter(c);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const max = Math.max(size.x, size.y, size.z) || 20;

    return {
      // Offset so the model is centered on XY, and bottom rests on Z=0
      offset: [-c.x, -c.y, -bbox.min.z] as [number, number, number],
      maxDim: max,
      center: c,
    };
  }, [geometry]);

  // Create technical CAD feature edges (30 degree crease threshold)
  const edgesGeometry = useMemo(() => {
    try {
      return new THREE.EdgesGeometry(geometry, 30);
    } catch (e) {
      console.warn('EdgesGeometry generation warning:', e);
      return null;
    }
  }, [geometry]);

  // Auto-frame camera on new model geometry
  useEffect(() => {
    if (!geometry) return;

    const fov = (camera as THREE.PerspectiveCamera).fov || 45;
    const distance = (maxDim / 2) / Math.tan((fov * Math.PI) / 360) * 2.2;
    const targetY = maxDim * 0.3;

    camera.position.set(distance * 0.85, distance * 0.85, distance * 1.1);
    camera.lookAt(0, targetY, 0);

    if (controls && (controls as any).target) {
      (controls as any).target.set(0, targetY, 0);
      (controls as any).update();
    }
  }, [geometry, maxDim, camera, controls]);

  return (
    // Rotate -90° around X so OpenSCAD's vertical Z-axis aligns with Three.js vertical Y-axis
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <group position={offset}>
        {/* Solid Shaded Model Mesh */}
        <mesh ref={meshRef} geometry={geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color="#94a3b8" // Slate 400 CAD plastic
            roughness={0.3}
            metalness={0.08}
            wireframe={viewportSettings.wireframe}
            side={THREE.DoubleSide}
            polygonOffset
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        </mesh>

        {/* Technical Edge Highlights */}
        {viewportSettings.showEdges && edgesGeometry && !viewportSettings.wireframe && (
          <lineSegments geometry={edgesGeometry}>
            <lineBasicMaterial color="#0f172a" linewidth={1.5} />
          </lineSegments>
        )}
      </group>
    </group>
  );
}
