'use client';

import React from 'react';
import * as THREE from 'three';
import { useAppStore } from '@/store/app-store';
import { Rotate3d } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

export type ViewPreset = 'top' | 'front' | 'right' | 'iso';

/**
 * Computes camera position for a preset in the Three.js world frame (Y up).
 * The CAD model has Z up, rotated -90° about X, resting on Z=0.
 *
 * - top: looking down from +Y
 * - front: looking from +Z
 * - right: looking from +X
 * - iso: looking from normalized (+1, +1, +1)
 */
export function presetCameraPosition(
  preset: ViewPreset,
  target: [number, number, number],
  distance: number
): [number, number, number] {
  switch (preset) {
    case 'top':
      return [target[0], target[1] + distance, target[2]];
    case 'front':
      return [target[0], target[1], target[2] + distance];
    case 'right':
      return [target[0] + distance, target[1], target[2]];
    case 'iso': {
      const d = distance / Math.sqrt(3);
      return [target[0] + d, target[1] + d, target[2] + d];
    }
  }
}

interface OrbitControlsLike {
  target?: THREE.Vector3;
  update?: () => void;
}

let activeCamera: THREE.Camera | null = null;
let activeControls: OrbitControlsLike | null = null;

export function registerViewportCamera(
  camera: THREE.Camera | null,
  controls: OrbitControlsLike | null
): void {
  activeCamera = camera;
  activeControls = controls;
}

export function setViewPreset(preset: ViewPreset): void {
  if (!activeCamera || !activeControls) return;

  const geometry = useAppStore.getState().geometry;
  if (!geometry) return;

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox || new THREE.Box3();
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 20;

  // In the Three.js world frame, the model is rotated -90° about X:
  // CAD Z is world Y. The model is centered on CAD XY, and bottom on CAD Z=0.
  // So the CAD bounding box size along Z is size.z, meaning world Y extends from 0 to size.z.
  // The world target is (0, size.z / 2, 0).
  const target: [number, number, number] = [0, size.z / 2, 0];

  const perspCamera = activeCamera as THREE.PerspectiveCamera;
  const fov = perspCamera.fov || 45;
  const fovRad = (fov * Math.PI) / 360; // fov / 2 in radians
  const distance = (maxDim / 2) / Math.tan(fovRad) * 2.2;

  const [cx, cy, cz] = presetCameraPosition(preset, target, distance);
  activeCamera.position.set(cx, cy, cz);

  if (activeControls.target) {
    activeControls.target.set(target[0], target[1], target[2]);
  }
  activeControls.update?.();
}

export function ViewPresetsMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="View presets"
          title="View presets"
          className="p-1.5 rounded-full text-xs transition-colors flex items-center justify-center text-[var(--fg-muted)] hover:bg-[var(--accent)] hover:text-[var(--fg)] cursor-pointer"
        >
          <Rotate3d className="w-4 h-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="min-w-[120px] p-1">
        <DropdownMenuItem
          onClick={() => setViewPreset('top')}
          className="cursor-pointer"
        >
          Top
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setViewPreset('front')}
          className="cursor-pointer"
        >
          Front
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setViewPreset('right')}
          className="cursor-pointer"
        >
          Right
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setViewPreset('iso')}
          className="cursor-pointer"
        >
          Isometric
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
