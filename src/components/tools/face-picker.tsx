'use client';

import React, { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { useAppStore } from '@/store/app-store';
import { getTool } from './tool-registry';

export function FacePicker() {
  const {
    activeToolId,
    toolTopology,
    topologyStatus,
    pickFace,
  } = useAppStore();

  const tool = getTool(activeToolId);
  const shouldRender =
    Boolean(tool?.needsFace) &&
    topologyStatus === 'ready' &&
    toolTopology !== null;

  const geometry = useMemo(() => {
    if (!shouldRender || !toolTopology) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(toolTopology.mesh.positions, 3)
    );
    geom.setIndex(new THREE.BufferAttribute(toolTopology.mesh.indices, 1));
    geom.computeVertexNormals();
    return geom;
  }, [shouldRender, toolTopology]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  if (!shouldRender || !geometry) {
    return null;
  }

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (typeof e.delta === 'number' && e.delta > 5) return;
    if (typeof e.faceIndex === 'number') {
      pickFace(e.faceIndex);
    }
  };

  return (
    <mesh geometry={geometry} onClick={handleClick}>
      <meshBasicMaterial
        transparent
        opacity={0}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
