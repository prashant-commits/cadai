'use client';

import React, { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useAppStore } from '@/store/app-store';
import { layerRows } from '@/components/inspector/layers-section';

interface CadModelProps {
  geometry: THREE.BufferGeometry;
}

export function CadModel({ geometry }: CadModelProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const {
    viewportSettings,
    selectedLayerId,
    parts,
    threads,
    activeThreadId,
    viewingVersion,
  } = useAppStore();
  const { camera, controls } = useThree();

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const currentVersion = activeThread?.versions?.find((v) => v.version === viewingVersion);

  const selectedPart = useMemo(() => {
    if (!selectedLayerId) return null;
    const rows = layerRows(parts, currentVersion);
    return rows.find((r) => r.id === selectedLayerId) ?? null;
  }, [parts, currentVersion, selectedLayerId]);

  const partOutline = useMemo(() => {
    if (!selectedPart?.box) return null;
    const { min, max } = selectedPart.box;
    const size: [number, number, number] = [
      Math.max(0.001, max[0] - min[0]),
      Math.max(0.001, max[1] - min[1]),
      Math.max(0.001, max[2] - min[2]),
    ];
    const center: [number, number, number] = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const boxGeom = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const edgesGeom = new THREE.EdgesGeometry(boxGeom);
    boxGeom.dispose();
    return { edgesGeom, center };
  }, [selectedPart]);

  useEffect(() => {
    return () => {
      partOutline?.edgesGeom.dispose();
    };
  }, [partOutline]);

  const accentColor = useMemo(() => {
    if (typeof document === 'undefined') return undefined;
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent-from')
      .trim();
    return val || undefined;
  }, []);

  // Compute bounding box, center offset, and dimensions
  const { offset, maxDim } = useMemo(() => {
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

    const orbit = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null;
    if (orbit?.target) {
      orbit.target.set(0, targetY, 0);
      orbit.update?.();
    }
  }, [geometry, maxDim, camera, controls]);

  return (
    // Rotate -90° around X so the CAD model's vertical Z-axis aligns with Three.js vertical Y-axis
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

        {/* Selected Part Bounding Box Highlight */}
        {partOutline && (
          <lineSegments
            geometry={partOutline.edgesGeom}
            position={partOutline.center}
            renderOrder={999}
          >
            <lineBasicMaterial
              color={accentColor}
              depthTest={false}
              transparent
              linewidth={1.5}
            />
          </lineSegments>
        )}
      </group>
    </group>
  );
}
