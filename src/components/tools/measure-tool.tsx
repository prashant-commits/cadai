'use client';

import React, { useMemo, useEffect, useRef } from 'react';
import { create } from 'zustand';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Ruler } from 'lucide-react';
import type { ToolDef, ToolSettingsProps } from './tool-registry';
import { REBUILD_FOR_TOOLS } from './tool-registry';
import { useAppStore } from '@/store/app-store';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  type Topology,
  faceAtTriangle,
} from '@/lib/geometry/topology';
import {
  type Vec3,
  type MeasureResult,
  measure,
  snapToVertex,
  nearestEdge,
  MEASURE_PICK_POINTS,
  MEASURE_PICK_EDGE,
  MEASURE_PICK_FACE,
  MEASURE_NOTHING,
} from '@/lib/geometry/measure';

export type MeasureMode = 'points' | 'edge' | 'face';

export interface MeasureState {
  mode: MeasureMode;
  points: Vec3[];
  edgeId: number | null;
  faceId: number | null;
  result: MeasureResult | null;
  lastPickedPoint: Vec3 | null;
  topology: Topology | null;
  topologyStatus: 'none' | 'loading' | 'ready' | 'missing';
  setMode(mode: MeasureMode): void;
  pickAt(triIndex: number, point: Vec3): void;
  reset(): void;
  loadTopology(): Promise<Topology | null>;
}

function computeBoundingDiagonal(topo: Topology): number {
  if (topo.parts && topo.parts.length > 0) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of topo.parts) {
      minX = Math.min(minX, p.min[0]);
      minY = Math.min(minY, p.min[1]);
      minZ = Math.min(minZ, p.min[2]);
      maxX = Math.max(maxX, p.max[0]);
      maxY = Math.max(maxY, p.max[1]);
      maxZ = Math.max(maxZ, p.max[2]);
    }
    return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  }

  const pos = topo.mesh.positions;
  if (pos.length === 0) return 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]);
    minY = Math.min(minY, pos[i + 1]);
    minZ = Math.min(minZ, pos[i + 2]);
    maxX = Math.max(maxX, pos[i]);
    maxY = Math.max(maxY, pos[i + 1]);
    maxZ = Math.max(maxZ, pos[i + 2]);
  }
  return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
}

export const useMeasureStore = create<MeasureState>((set, get) => ({
  mode: 'points',
  points: [],
  edgeId: null,
  faceId: null,
  result: null,
  lastPickedPoint: null,
  topology: null,
  topologyStatus: 'none',

  setMode: (mode) =>
    set({
      mode,
      points: [],
      edgeId: null,
      faceId: null,
      result: null,
      lastPickedPoint: null,
    }),

  reset: () =>
    set({
      points: [],
      edgeId: null,
      faceId: null,
      result: null,
      lastPickedPoint: null,
    }),

  loadTopology: async () => {
    const appState = useAppStore.getState();
    const activeThread = appState.threads.find((t) => t.id === appState.activeThreadId);
    const currentVersion = activeThread?.versions?.find((v) => v.version === appState.viewingVersion);
    const topoArtifact = currentVersion?.topo;

    if (!topoArtifact) {
      set({ topologyStatus: 'missing', topology: null });
      return null;
    }

    set({ topologyStatus: 'loading' });
    const topo = await appState.loadVersionTopology(topoArtifact);

    // Ignore result if topo id changed while loading
    const latestState = useAppStore.getState();
    const latestThread = latestState.threads.find((t) => t.id === latestState.activeThreadId);
    const latestVersion = latestThread?.versions?.find((v) => v.version === latestState.viewingVersion);
    const latestTopoArtifact = latestVersion?.topo;

    if (latestTopoArtifact !== topoArtifact) {
      return null;
    }

    if (!topo) {
      set({ topologyStatus: 'missing', topology: null });
      return null;
    }

    set({ topologyStatus: 'ready', topology: topo });
    return topo;
  },

  pickAt: (triIndex: number, point: Vec3) => {
    const state = get();
    const topo = state.topology;
    if (!topo) {
      return;
    }

    set({ lastPickedPoint: point });

    if (state.mode === 'points') {
      const diag = computeBoundingDiagonal(topo);
      const tol = Math.max(0.5, 0.02 * diag);
      const snapped = snapToVertex(topo, triIndex, point, tol);

      if (state.points.length === 0 || state.points.length >= 2) {
        set({ points: [snapped], result: null });
      } else {
        const nextPoints: Vec3[] = [state.points[0], snapped];
        const res = measure(topo, { kind: 'points', a: nextPoints[0], b: nextPoints[1] });
        set({ points: nextPoints, result: res });
      }
    } else if (state.mode === 'edge') {
      const face = faceAtTriangle(topo, triIndex);
      if (!face) {
        set({ edgeId: null, result: { ok: false, error: MEASURE_NOTHING } });
        return;
      }
      const edgeId = nearestEdge(topo, face.id, point);
      if (edgeId === null) {
        set({ edgeId: null, result: { ok: false, error: MEASURE_NOTHING } });
        return;
      }
      const res = measure(topo, { kind: 'edge', edgeId });
      set({ edgeId, faceId: face.id, result: res });
    } else if (state.mode === 'face') {
      const face = faceAtTriangle(topo, triIndex);
      if (!face) {
        set({ faceId: null, result: { ok: false, error: MEASURE_NOTHING } });
        return;
      }
      const res = measure(topo, { kind: 'face', faceId: face.id });
      set({ faceId: face.id, edgeId: null, result: res });
    }
  },
}));

export function __resetMeasureForTests(): void {
  useMeasureStore.setState({
    mode: 'points',
    points: [],
    edgeId: null,
    faceId: null,
    result: null,
    lastPickedPoint: null,
    topology: null,
    topologyStatus: 'none',
  });
}

export const MeasureSettings: React.FC<ToolSettingsProps> = () => {
  const { mode, result, topologyStatus, setMode, reset } = useMeasureStore();

  let hintPhrase = MEASURE_PICK_POINTS;
  if (mode === 'edge') {
    hintPhrase = MEASURE_PICK_EDGE;
  } else if (mode === 'face') {
    hintPhrase = MEASURE_PICK_FACE;
  }

  return (
    <div className="space-y-4">
      {topologyStatus === 'missing' && (
        <div className="text-xs text-[var(--fg-muted)] p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
          {REBUILD_FOR_TOOLS}
        </div>
      )}

      {/* Mode Selector */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-[var(--fg-muted)]">Mode</label>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(val) => {
            if (val) setMode(val as MeasureMode);
          }}
          className="w-full justify-start"
        >
          <ToggleGroupItem value="points" className="flex-1 text-xs">
            Points
          </ToggleGroupItem>
          <ToggleGroupItem value="edge" className="flex-1 text-xs">
            Edge
          </ToggleGroupItem>
          <ToggleGroupItem value="face" className="flex-1 text-xs">
            Diameter
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Hint phrase */}
      <div className="text-xs text-[var(--fg-muted)]">{hintPhrase}</div>

      {/* Result Display */}
      {result && (
        <div className="p-3 rounded-lg bg-[var(--card)] border border-[var(--glass-border)] space-y-1">
          <div className="text-[11px] font-medium text-[var(--fg-muted)]">Measurement</div>
          {result.ok ? (
            <div className="text-lg font-mono font-bold text-[var(--fg)] tracking-tight">
              {result.label}
            </div>
          ) : (
            <div className="text-xs text-[var(--destructive)] font-medium">
              {result.error}
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="pt-2">
        <Button variant="outline" size="sm" onClick={reset} className="w-full text-xs">
          Clear
        </Button>
      </div>
    </div>
  );
}

export function MeasureOverlay() {
  const { topology, points, result, mode, lastPickedPoint, pickAt, reset, loadTopology } =
    useMeasureStore();
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);

  const viewedTopoId = useAppStore((state) => {
    const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
    const currentVersion = activeThread?.versions?.find((v) => v.version === state.viewingVersion);
    return currentVersion?.topo ?? null;
  });

  useEffect(() => {
    reset();
    void loadTopology();
  }, [viewedTopoId, reset, loadTopology]);

  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  const geometry = useMemo(() => {
    if (!topology) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(topology.mesh.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(topology.mesh.indices, 1));
    geom.computeVertexNormals();
    return geom;
  }, [topology]);

  useEffect(() => {
    return () => {
      geometry?.dispose();
    };
  }, [geometry]);

  const accentColor = useMemo(() => {
    if (typeof document === 'undefined') return undefined;
    const val = getComputedStyle(document.documentElement).getPropertyValue('--accent-from').trim();
    return val || undefined;
  }, []);

  const lineGeometry = useMemo(() => {
    if (points.length !== 2) return null;
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...points[0]),
      new THREE.Vector3(...points[1]),
    ]);
    return geom;
  }, [points]);

  useEffect(() => {
    return () => {
      lineGeometry?.dispose();
    };
  }, [lineGeometry]);

  const labelPosition: Vec3 | null = useMemo(() => {
    if (mode === 'points') {
      if (points.length === 2) {
        return [
          (points[0][0] + points[1][0]) / 2,
          (points[0][1] + points[1][1]) / 2,
          (points[0][2] + points[1][2]) / 2,
        ];
      }
      if (points.length === 1) {
        return points[0];
      }
      return null;
    }
    if (result && result.ok && lastPickedPoint) {
      return lastPickedPoint;
    }
    return null;
  }, [mode, points, result, lastPickedPoint]);

  if (!topology || !geometry) {
    return null;
  }

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    clickStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (clickStartRef.current) {
      const dx = e.clientX - clickStartRef.current.x;
      const dy = e.clientY - clickStartRef.current.y;
      if (Math.hypot(dx, dy) > 5) {
        return;
      }
    }
    if (typeof e.delta === 'number' && e.delta > 5) return;
    if (typeof e.faceIndex === 'number') {
      const localPoint = e.object.worldToLocal(e.point.clone());
      pickAt(e.faceIndex, [localPoint.x, localPoint.y, localPoint.z]);
    }
  };

  return (
    <group>
      {/* Invisible raycastable topology mesh */}
      <mesh
        geometry={geometry}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
      >
        <meshBasicMaterial
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Picked Points */}
      {points.map((pt, idx) => (
        <mesh key={idx} position={pt}>
          <sphereGeometry args={[0.6, 16, 16]} />
          <meshBasicMaterial color={accentColor} depthTest={false} />
        </mesh>
      ))}

      {/* Line between two picked points */}
      {lineGeometry && (
        <lineSegments geometry={lineGeometry}>
          <lineBasicMaterial color={accentColor} linewidth={2} depthTest={false} />
        </lineSegments>
      )}

      {/* Floating measurement label pill */}
      {result && result.ok && labelPosition && (
        <Html position={labelPosition} center style={{ pointerEvents: 'none' }}>
          <div className="glass px-2.5 py-1 rounded-full text-xs font-mono font-semibold text-[var(--fg)] shadow-lg select-none whitespace-nowrap border border-[var(--glass-border)]">
            {result.label}
          </div>
        </Html>
      )}
    </group>
  );
}

export const toolDef: ToolDef = {
  id: 'measure',
  icon: Ruler,
  label: 'Measure',
  needsFace: false,
  modifies: false,
  opKinds: [],
  Settings: MeasureSettings,
  initialDraft: () => null,
  ViewportOverlay: MeasureOverlay,
};
