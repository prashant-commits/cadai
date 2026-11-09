'use client';

import React, { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { PivotControls } from '@react-three/drei';
import { useAppStore } from '@/store/app-store';

export function OpPreview() {
  const { preview, draftOp, updateDraft } = useAppStore();
  const lastDragRef = useRef<{ offset: [number, number]; rotationDeg: number } | null>(null);

  const accentColor = useMemo(() => {
    if (typeof document === 'undefined') return undefined;
    const val = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent-from')
      .trim();
    return val || undefined;
  }, []);

  const plane = draftOp && 'plane' in draftOp ? draftOp.plane : undefined;
  const offset = draftOp && 'offset' in draftOp ? draftOp.offset : undefined;
  const rotationDeg = draftOp && 'rotationDeg' in draftOp ? draftOp.rotationDeg : undefined;

  const planeInfo = useMemo(() => {
    if (!plane) return null;
    const { origin, normal, xDir } = plane;
    const nx = new THREE.Vector3(...xDir).normalize();
    const nz = new THREE.Vector3(...normal).normalize();
    const ny = new THREE.Vector3().crossVectors(nz, nx).normalize();
    const originVec = new THREE.Vector3(...origin);

    const baseMatrix = new THREE.Matrix4().makeBasis(nx, ny, nz);
    baseMatrix.setPosition(originVec);

    return { nx, ny, nz, originVec, baseMatrix };
  }, [plane]);

  const initialMatrix = useMemo(() => {
    if (!planeInfo || !offset) return undefined;
    const { nx, ny, nz, originVec } = planeInfo;
    const [dx, dy] = offset;
    const rotRad = ((rotationDeg || 0) * Math.PI) / 180;

    const rotMatrix = new THREE.Matrix4().makeRotationAxis(nz, rotRad);
    const pos = originVec.clone().addScaledVector(nx, dx).addScaledVector(ny, dy);

    const m = new THREE.Matrix4().makeBasis(nx, ny, nz);
    m.premultiply(rotMatrix);
    m.setPosition(pos);
    return m;
  }, [planeInfo, offset, rotationDeg]);

  const handleDrag = (localMatrix: THREE.Matrix4) => {
    if (!planeInfo) return;
    const { nx, ny, originVec } = planeInfo;

    const currentPos = new THREE.Vector3().setFromMatrixPosition(localMatrix);
    const diff = currentPos.sub(originVec);
    const dx = diff.dot(nx);
    const dy = diff.dot(ny);

    const currentX = new THREE.Vector3(
      localMatrix.elements[0],
      localMatrix.elements[1],
      localMatrix.elements[2]
    ).normalize();

    const cosTheta = currentX.dot(nx);
    const sinTheta = currentX.dot(ny);
    const angleRad = Math.atan2(sinTheta, cosTheta);
    const deg = Math.round((angleRad * 180) / Math.PI);

    lastDragRef.current = { offset: [dx, dy], rotationDeg: deg };
    updateDraft({ offset: [dx, dy], rotationDeg: deg });
  };

  const handleDragEnd = () => {
    if (lastDragRef.current) {
      updateDraft(lastDragRef.current);
      lastDragRef.current = null;
    }
  };

  return (
    <>
      {/* Translucent Preview Model Mesh */}
      {preview.status === 'ready' && preview.geometry && (
        <mesh geometry={preview.geometry} castShadow receiveShadow>
          <meshStandardMaterial
            color={accentColor}
            transparent
            opacity={0.8}
            roughness={0.3}
            metalness={0.1}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Drei PivotControls constrained to face plane */}
      {initialMatrix && (
        <PivotControls
          matrix={initialMatrix}
          activeAxes={[true, true, false]}
          disableScaling
          depthTest={false}
          onDrag={handleDrag}
          onDragEnd={handleDragEnd}
        />
      )}
    </>
  );
}
