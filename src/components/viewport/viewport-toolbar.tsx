'use client';

import React from 'react';
import { useAppStore } from '@/store/app-store';
import {
  Grid,
  Axis3d,
  Layers,
  RotateCw,
  Eye,
  Maximize2,
  Compass,
  PenTool,
} from 'lucide-react';

interface ViewportToolbarProps {
  onResetCamera: () => void;
}

export function ViewportToolbar({ onResetCamera }: ViewportToolbarProps) {
  const { viewportSettings, updateViewportSettings, setIsAnnotating, setBaseSnapshot } = useAppStore();

  const handleSnapshot = () => {
    const canvas = document.querySelector('canvas');
    if (canvas) {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      setBaseSnapshot(dataUrl);
      setIsAnnotating(true);
    }
  };

  return (
    <div className="absolute top-3 left-3 z-10 flex items-center gap-1 bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-lg p-1 shadow-lg select-none">
      {/* Grid toggle */}
      <button
        onClick={() => updateViewportSettings({ showGrid: !viewportSettings.showGrid })}
        className={`p-1.5 rounded-md text-xs transition-colors flex items-center gap-1 ${
          viewportSettings.showGrid
            ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
        }`}
        title="Toggle Build Grid (10mm)"
      >
        <Grid className="w-4 h-4" />
      </button>

      {/* Axes toggle */}
      <button
        onClick={() => updateViewportSettings({ showAxes: !viewportSettings.showAxes })}
        className={`p-1.5 rounded-md text-xs transition-colors flex items-center gap-1 ${
          viewportSettings.showAxes
            ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
        }`}
        title="Toggle XYZ Axes (Red=X, Green=Y, Blue=Z)"
      >
        <Axis3d className="w-4 h-4" />
      </button>

      {/* Edges toggle */}
      <button
        onClick={() => updateViewportSettings({ showEdges: !viewportSettings.showEdges })}
        className={`p-1.5 rounded-md text-xs transition-colors flex items-center gap-1 ${
          viewportSettings.showEdges
            ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
        }`}
        title="Toggle CAD Feature Edges"
      >
        <Layers className="w-4 h-4" />
      </button>

      {/* Wireframe toggle */}
      <button
        onClick={() => updateViewportSettings({ wireframe: !viewportSettings.wireframe })}
        className={`p-1.5 rounded-md text-xs transition-colors flex items-center gap-1 ${
          viewportSettings.wireframe
            ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
        }`}
        title="Toggle Wireframe Mode"
      >
        <Eye className="w-4 h-4" />
      </button>

      {/* Auto-rotate */}
      <button
        onClick={() => updateViewportSettings({ autoRotate: !viewportSettings.autoRotate })}
        className={`p-1.5 rounded-md text-xs transition-colors flex items-center gap-1 ${
          viewportSettings.autoRotate
            ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
        }`}
        title="Toggle Turntable Auto-Rotation"
      >
        <RotateCw className="w-4 h-4" />
      </button>

      <div className="w-px h-4 bg-slate-800 mx-0.5" />

      {/* Reset Camera */}
      <button
        onClick={onResetCamera}
        className="p-1.5 rounded-md text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
        title="Reset Camera & Center Model"
      >
        <Maximize2 className="w-4 h-4" />
      </button>

      <div className="w-px h-4 bg-slate-800 mx-0.5" />

      {/* Snapshot & Annotate */}
      <button
        onClick={handleSnapshot}
        className="p-1.5 rounded-md text-xs text-amber-400 hover:text-amber-200 hover:bg-amber-900/30 transition-colors flex items-center gap-1"
        title="Snapshot & Annotate (Draw over 3D model)"
      >
        <PenTool className="w-4 h-4" />
      </button>
    </div>
  );
}
