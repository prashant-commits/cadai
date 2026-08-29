'use client';

import React, { useRef, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { useAppStore } from '@/store/app-store';
import { CadModel } from './cad-model';
import { ViewportToolbar } from './viewport-toolbar';
import { compileOpenScad } from '@/lib/engine/openscad-bridge';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

export function ViewportPanel() {
  const {
    geometry,
    code,
    compileStatus,
    compileError,
    viewportSettings,
    setCompileResult,
    setCompileStatus,
  } = useAppStore();

  const controlsRef = useRef<OrbitControlsImpl>(null);

  // Initial compilation on mount if code is available and no geometry yet
  useEffect(() => {
    if (!geometry && code) {
      let isMounted = true;
      setCompileStatus('compiling');
      compileOpenScad(code).then((result) => {
        if (isMounted) {
          setCompileResult(result);
        }
      });
      return () => {
        isMounted = false;
      };
    }
  }, [geometry, code, setCompileResult, setCompileStatus]);

  const handleResetCamera = () => {
    if (controlsRef.current) {
      controlsRef.current.reset();
    }
  };

  const handleRecompile = async () => {
    setCompileStatus('compiling');
    const result = await compileOpenScad(code);
    setCompileResult(result);
  };

  return (
    <div className="relative w-full h-full bg-[#090d16] overflow-hidden select-none">
      {/* Floating Toolbar */}
      <ViewportToolbar onResetCamera={handleResetCamera} />

      {/* Viewport Header overlay */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <div className="bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-lg px-3 py-1 text-[11px] font-mono text-slate-400">
          3D Viewport
        </div>
      </div>

      {/* Error notification banner */}
      {compileStatus === 'error' && (
        <div className="absolute bottom-4 left-4 right-4 z-20 bg-rose-950/90 border border-rose-800 rounded-lg p-3 text-xs text-rose-200 shadow-xl flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <span className="font-semibold block text-rose-300">Compilation Error</span>
              <p className="font-mono text-[11px] truncate">{compileError}</p>
            </div>
          </div>
          <button
            onClick={handleRecompile}
            className="px-2.5 py-1 rounded bg-rose-900 hover:bg-rose-800 text-rose-100 text-xs shrink-0 flex items-center gap-1 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* Compiling overlay */}
      {compileStatus === 'compiling' && (
        <div className="absolute inset-0 z-20 bg-black/40 backdrop-blur-2xs flex items-center justify-center pointer-events-none">
          <div className="bg-slate-900/90 border border-slate-800 rounded-xl px-4 py-3 shadow-2xl flex items-center gap-3 text-slate-200 text-xs">
            <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />
            <span>Compiling OpenSCAD geometry...</span>
          </div>
        </div>
      )}

      {/* 3D Canvas */}
      <Canvas
        shadows
        camera={{ position: [60, 60, 70], fov: 45, near: 0.1, far: 5000 }}
        gl={{ antialias: true, logarithmicDepthBuffer: true }}
      >
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
