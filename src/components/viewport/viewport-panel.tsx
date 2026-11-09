'use client';

import React, { useRef, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { useAppStore } from '@/store/app-store';
import { CadModel } from './cad-model';
import { ViewportToolbar } from './viewport-toolbar';
import { Annotator } from './annotator';
import { registerViewportCamera } from './view-presets';
import { compileModel } from '@/lib/engine/build123d-client';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

function CameraRegistration({
  controlsRef,
}: {
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const { camera, controls } = useThree();

  useEffect(() => {
    const ctrl = controlsRef.current || (controls as unknown as OrbitControlsImpl | null);
    registerViewportCamera(camera, ctrl);
    return () => {
      registerViewportCamera(null, null);
    };
  }, [camera, controls, controlsRef]);

  return null;
}

export function ViewportPanel() {
  const {
    geometry,
    code,
    compileStatus,
    compileError,
    viewportSettings,
    isAnnotating,
    codeDrawerOpen,
    setCompileResult,
    setCompileStatus,
  } = useAppStore();

  const controlsRef = useRef<OrbitControlsImpl>(null);

  // Initial compilation on mount if code is available and no geometry yet
  useEffect(() => {
    if (!geometry && code) {
      let isMounted = true;
      setCompileStatus('compiling');
      compileModel(code).then((result) => {
        if (isMounted) {
          setCompileResult(result);
        }
      });
      return () => {
        isMounted = false;
      };
    }
  }, [geometry, code, setCompileResult, setCompileStatus]);

  const handleRecompile = async () => {
    setCompileStatus('compiling');
    const result = await compileModel(code);
    setCompileResult(result);
  };

  return (
    <div className="relative w-full h-full bg-transparent overflow-hidden select-none">
      {isAnnotating && <Annotator />}

      {/* Floating Toolbar */}
      <ViewportToolbar />

      {/* Error notification banner */}
      {compileStatus === 'error' && !codeDrawerOpen && (
        <div className="glass absolute bottom-4 left-4 right-4 z-20 p-3 text-xs text-[var(--fg)] flex items-start justify-between gap-3 shadow-xl">
          <div className="flex items-start gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 text-[var(--destructive)] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <span className="font-semibold block text-[var(--destructive)]">Compilation Error</span>
              <p className="font-mono text-[11px] truncate text-[var(--fg-muted)]">{compileError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRecompile}
            className="px-2.5 py-1 rounded bg-[var(--accent)] hover:bg-[var(--accent-glow)] text-[var(--fg)] text-xs shrink-0 flex items-center gap-1 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Compiling overlay */}
      {compileStatus === 'compiling' && (
        <div className="absolute inset-0 z-20 bg-[color-mix(in_srgb,var(--bg)_40%,transparent)] backdrop-blur-xs flex items-center justify-center pointer-events-none">
          <div className="glass px-4 py-3 flex items-center gap-3 text-[var(--fg)] text-xs">
            <Loader2 className="w-4 h-4 text-[var(--accent-from)] animate-spin" />
            <span>Compiling CAD geometry...</span>
          </div>
        </div>
      )}

      {/* 3D Canvas */}
      <Canvas
        shadows="percentage"
        camera={{ position: [60, 60, 70], fov: 45, near: 0.1, far: 5000 }}
        gl={{ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: true }}
      >
        <CameraRegistration controlsRef={controlsRef} />

        {/* Lights */}
        <ambientLight intensity={0.75} />
        <directionalLight
          position={[120, 180, 120]}
          intensity={1.3}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
        />
        <directionalLight position={[-100, -100, -50]} intensity={0.4} />
        <hemisphereLight args={['#e2e8f0', '#0f172a', 0.6]} />

        {/* Grid Floor on XZ Plane (3D Print Build Bed) */}
        {viewportSettings.showGrid && (
          <gridHelper
            args={[220, 44, '#475569', '#1e293b']}
            position={[0, 0, 0]}
          />
        )}

        {/* Axes Helper (Red=X, Green=Y, Blue=Z) */}
        {viewportSettings.showAxes && <axesHelper args={[35]} />}

        {/* Model Mesh */}
        {geometry && <CadModel geometry={geometry} />}

        {/* Controls */}
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.08}
          autoRotate={viewportSettings.autoRotate}
          autoRotateSpeed={1.5}
          maxDistance={2000}
          minDistance={1}
        />

        {/* Orientation ViewCube / Gizmo */}
        <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
          <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#ffffff" />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}
