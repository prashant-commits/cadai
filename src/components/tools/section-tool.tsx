'use client';

import React, { useMemo, useEffect, useRef } from 'react';
import { create } from 'zustand';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { PivotControls } from '@react-three/drei';
import { Scissors } from 'lucide-react';
import type { ToolDef, ToolSettingsProps } from './tool-registry';
import { useAppStore } from '@/store/app-store';
import { Slider } from '@/components/ui/slider';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Vec3 } from '@/lib/geometry/measure';
import { formatMm } from '@/lib/geometry/measure';

export type SectionAxis = 'x' | 'y' | 'z' | 'free';

export interface SectionState {
  axis: SectionAxis;
  flip: boolean;
  offset: number;
  freeMatrix: number[] | null;
  setAxis(axis: SectionAxis): void;
  setFlip(flip: boolean): void;
  setOffset(offset: number): void;
  setFreeMatrix(matrix: number[] | null): void;
  reset(): void;
}

export const SECTION_HINT = 'Drag the plane to move the cut.';
export const SECTION_AXIS_X = 'X';
export const SECTION_AXIS_Y = 'Y';
export const SECTION_AXIS_Z = 'Z';
export const SECTION_AXIS_FREE = 'Free';
export const SECTION_FLIP = 'Flip';

export const useSectionStore = create<SectionState>((set) => ({
  axis: 'x',
  flip: false,
  offset: 0,
  freeMatrix: null,
  setAxis: (axis) => set({ axis, offset: 0, freeMatrix: null }),
  setFlip: (flip) => set({ flip }),
  setOffset: (offset) => set({ offset }),
  setFreeMatrix: (freeMatrix) => set({ freeMatrix }),
  reset: () => set({ axis: 'x', flip: false, offset: 0, freeMatrix: null }),
}));

export function __resetSectionForTests(): void {
  useSectionStore.setState({
    axis: 'x',
    flip: false,
    offset: 0,
    freeMatrix: null,
  });
}

export function sectionLocalPlane(s: SectionState, box: { min: Vec3; max: Vec3 }): THREE.Plane {
  const center: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];

  const plane = new THREE.Plane();

  if (s.axis === 'x') {
    const normal = new THREE.Vector3(-1, 0, 0);
    const coplanar = new THREE.Vector3(center[0] + s.offset, center[1], center[2]);
    plane.setFromNormalAndCoplanarPoint(normal, coplanar);
  } else if (s.axis === 'y') {
    const normal = new THREE.Vector3(0, -1, 0);
    const coplanar = new THREE.Vector3(center[0], center[1] + s.offset, center[2]);
    plane.setFromNormalAndCoplanarPoint(normal, coplanar);
  } else if (s.axis === 'z') {
    const normal = new THREE.Vector3(0, 0, -1);
    const coplanar = new THREE.Vector3(center[0], center[1], center[2] + s.offset);
    plane.setFromNormalAndCoplanarPoint(normal, coplanar);
  } else if (s.axis === 'free') {
    if (s.freeMatrix && s.freeMatrix.length === 16) {
      const mat = new THREE.Matrix4().fromArray(s.freeMatrix);
      const pos = new THREE.Vector3().setFromMatrixPosition(mat);
      const normal = new THREE.Vector3(-mat.elements[8], -mat.elements[9], -mat.elements[10]).normalize();
      plane.setFromNormalAndCoplanarPoint(normal, pos);
    } else {
      const normal = new THREE.Vector3(0, 0, -1);
      const coplanar = new THREE.Vector3(center[0], center[1], center[2]);
      plane.setFromNormalAndCoplanarPoint(normal, coplanar);
    }
  }

  if (s.flip) {
    plane.negate();
  }

  return plane;
}

const SECTION_PLANE = new THREE.Plane();
const SECTION_PLANES = [SECTION_PLANE];
const EMPTY_PLANES: THREE.Plane[] = [];

export function sectionClippingPlanes(): THREE.Plane[] {
  const activeToolId = useAppStore.getState().activeToolId;
  return activeToolId === 'section' ? SECTION_PLANES : EMPTY_PLANES;
}

export function useSectionClippingPlanes(): THREE.Plane[] {
  const activeToolId = useAppStore((s) => s.activeToolId);
  return useMemo(() => {
    return activeToolId === 'section' ? SECTION_PLANES : EMPTY_PLANES;
  }, [activeToolId]);
}

export const SectionSettings: React.FC<ToolSettingsProps> = () => {
  const { axis, flip, offset, setAxis, setFlip, setOffset } = useSectionStore();
  const geometry = useAppStore((s) => s.geometry);

  const box = useMemo(() => {
    if (!geometry) {
      return { min: [-10, -10, -10] as Vec3, max: [10, 10, 10] as Vec3 };
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    return {
      min: [bb.min.x, bb.min.y, bb.min.z] as Vec3,
      max: [bb.max.x, bb.max.y, bb.max.z] as Vec3,
    };
  }, [geometry]);

  const halfExtent = useMemo(() => {
    let span = 20;
    if (axis === 'x') span = box.max[0] - box.min[0];
    else if (axis === 'y') span = box.max[1] - box.min[1];
    else if (axis === 'z') span = box.max[2] - box.min[2];
    return Math.max(1, Math.round((span / 2) * 10) / 10);
  }, [axis, box]);

  return (
    <div className="space-y-4">
      {/* Axis Selector */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-[var(--fg-muted)]">Cut Plane</label>
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={axis}
            onValueChange={(val) => {
              if (val) setAxis(val as SectionAxis);
            }}
            className="flex-1 justify-start"
          >
            <ToggleGroupItem value="x" className="flex-1 text-xs">
              {SECTION_AXIS_X}
            </ToggleGroupItem>
            <ToggleGroupItem value="y" className="flex-1 text-xs">
              {SECTION_AXIS_Y}
            </ToggleGroupItem>
            <ToggleGroupItem value="z" className="flex-1 text-xs">
              {SECTION_AXIS_Z}
            </ToggleGroupItem>
            <ToggleGroupItem value="free" className="flex-1 text-xs">
              {SECTION_AXIS_FREE}
            </ToggleGroupItem>
          </ToggleGroup>

          <Toggle
            pressed={flip}
            onPressedChange={setFlip}
            size="sm"
            variant="outline"
            className="text-xs"
          >
            {SECTION_FLIP}
          </Toggle>
        </div>
      </div>

      {/* Axis Offset Slider */}
      {axis !== 'free' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--fg-muted)]">Offset</span>
            <span className="font-mono text-[var(--fg)]">{formatMm(offset)} mm</span>
          </div>
          <Slider
            min={-halfExtent}
            max={halfExtent}
            step={0.1}
            value={[offset]}
            onValueChange={(val) => setOffset(val[0])}
          />
        </div>
      )}

      {/* Free mode hint */}
      {axis === 'free' && (
        <div className="text-xs text-[var(--fg-muted)] p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
          {SECTION_HINT}
        </div>
      )}
    </div>
  );
}

export function SectionOverlay() {
  const { gl } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const { axis, offset, freeMatrix, setFreeMatrix, reset } = useSectionStore();
  const geometry = useAppStore((s) => s.geometry);

  useEffect(() => {
    const prev = gl.localClippingEnabled;
    // eslint-disable-next-line react-hooks/immutability
    gl.localClippingEnabled = true;
    return () => {
      gl.localClippingEnabled = prev;
      reset();
    };
  }, [gl, reset]);

  const box = useMemo(() => {
    if (!geometry) {
      return { min: [-10, -10, -10] as Vec3, max: [10, 10, 10] as Vec3 };
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    return {
      min: [bb.min.x, bb.min.y, bb.min.z] as Vec3,
      max: [bb.max.x, bb.max.y, bb.max.z] as Vec3,
    };
  }, [geometry]);

  const center = useMemo<Vec3>(
    () => [
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    ],
    [box]
  );

  const quadSize = useMemo(() => {
    const sx = box.max[0] - box.min[0];
    const sy = box.max[1] - box.min[1];
    const sz = box.max[2] - box.min[2];
    return Math.max(30, Math.max(sx, sy, sz) * 2);
  }, [box]);

  useFrame(() => {
    const localPlane = sectionLocalPlane(useSectionStore.getState(), box);
    const parentMat = groupRef.current?.parent?.matrixWorld ?? groupRef.current?.matrixWorld;
    if (parentMat) {
      SECTION_PLANE.copy(localPlane).applyMatrix4(parentMat);
    }
  });

  const accentColor = useMemo(() => {
    if (typeof document === 'undefined') return undefined;
    const val = getComputedStyle(document.documentElement).getPropertyValue('--accent-from').trim();
    return val || undefined;
  }, []);

  const pivotMatrix = useMemo(() => {
    const m = new THREE.Matrix4();
    if (freeMatrix && freeMatrix.length === 16) {
      m.fromArray(freeMatrix);
    } else {
      m.setPosition(center[0], center[1], center[2]);
    }
    return m;
  }, [freeMatrix, center]);

  const freeTransform = useMemo(() => {
    if (axis !== 'free') return null;
    const m = new THREE.Matrix4();
    if (freeMatrix && freeMatrix.length === 16) {
      m.fromArray(freeMatrix);
    } else {
      m.setPosition(center[0], center[1], center[2]);
    }
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    m.decompose(pos, quat, scale);
    return { pos, quat };
  }, [axis, freeMatrix, center]);

  return (
    <group ref={groupRef}>
      {/* Translucent quad showing the cut plane */}
      {axis === 'x' && (
        <mesh
          position={[center[0] + offset, center[1], center[2]]}
          rotation={[0, Math.PI / 2, 0]}
        >
          <planeGeometry args={[quadSize, quadSize]} />
          <meshBasicMaterial
            color={accentColor}
            transparent
            opacity={0.12}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {axis === 'y' && (
        <mesh
          position={[center[0], center[1] + offset, center[2]]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[quadSize, quadSize]} />
          <meshBasicMaterial
            color={accentColor}
            transparent
            opacity={0.12}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {axis === 'z' && (
        <mesh
          position={[center[0], center[1], center[2] + offset]}
          rotation={[0, 0, 0]}
        >
          <planeGeometry args={[quadSize, quadSize]} />
          <meshBasicMaterial
            color={accentColor}
            transparent
            opacity={0.12}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {axis === 'free' && freeTransform && (
        <mesh position={freeTransform.pos} quaternion={freeTransform.quat}>
          <planeGeometry args={[quadSize, quadSize]} />
          <meshBasicMaterial
            color={accentColor}
            transparent
            opacity={0.12}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* Free mode PivotControls */}
      {axis === 'free' && (
        <PivotControls
          matrix={pivotMatrix}
          disableScaling
          depthTest={false}
          onDrag={(localMatrix) => {
            setFreeMatrix(Array.from(localMatrix.elements));
          }}
        />
      )}
    </group>
  );
}

export const toolDef: ToolDef = {
  id: 'section',
  icon: Scissors,
  label: 'Section',
  needsFace: false,
  modifies: false,
  opKinds: [],
  Settings: SectionSettings,
  initialDraft: () => null,
  ViewportOverlay: SectionOverlay,
};
