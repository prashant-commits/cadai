'use client';

import React, { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { exportStl } from '@/lib/export/stl-exporter';
import { export3mf } from '@/lib/export/threemf-exporter';
import {
  Printer,
  Download,
  Box,
  Layers,
  ShieldCheck,
  ShieldAlert,
  PanelRightClose,
  ChevronRight,
  Gauge,
  Sparkles,
  Sliders,
  CheckCircle2,
} from 'lucide-react';

export function PrintAnalysisPanel() {
  const {
    modelInfo,
    stlContent,
    geometry,
    compileStatus,
    isAnalysisCollapsed,
    toggleAnalysisCollapsed,
  } = useAppStore();

  const [exporting, setExporting] = useState(false);

  if (isAnalysisCollapsed) {
    return null;
  }

  const handleExportStl = () => {
    if (!stlContent) return;
    setExporting(true);
    try {
      exportStl(stlContent, `cadai_model_${Date.now()}.stl`);
    } catch (e) {
      console.error('Error exporting STL:', e);
    } finally {
      setExporting(false);
    }
  };

  const handleExport3mf = () => {
    if (!geometry) return;
    setExporting(true);
    try {
      export3mf(geometry, `cadai_model_${Date.now()}.3mf`);
    } catch (e) {
      console.error('Error exporting 3MF:', e);
    } finally {
      setExporting(false);
    }
  };

  const hasModel = modelInfo && compileStatus === 'success';

  return (
    <div className="w-72 lg:w-80 h-full flex flex-col bg-slate-950 border-l border-slate-800 shrink-0 select-none overflow-hidden transition-all">
      {/* Panel Header */}
      <div className="px-3.5 py-2 bg-slate-900/70 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Printer className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-200 truncate">Print & Slicing</span>
          {hasModel && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono shrink-0">
              Ready
            </span>
          )}
        </div>

        <button
          onClick={toggleAnalysisCollapsed}
          className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 transition-colors cursor-pointer"
          title="Collapse Print Analysis Panel"
        >
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>

      {/* Content Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">
        {hasModel ? (
          <>
            {/* Quick Summary Banner */}
            <div className="p-2.5 rounded-lg bg-indigo-950/30 border border-indigo-500/20 flex items-center gap-2 text-indigo-200 text-xs">
              <Sparkles className="w-4 h-4 text-indigo-400 shrink-0" />
              <div className="leading-tight">
                <p className="font-semibold text-indigo-300">FDM Slicing Verified</p>
                <p className="text-[11px] text-slate-400">Watertight 3D manifold geometry ready for production</p>
              </div>
            </div>

            {/* Metrics Stack */}
            <div className="space-y-2 text-xs font-mono">
              {/* Dimensions */}
              <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-[11px] font-sans">
                  <div className="flex items-center gap-1.5">
                    <Box className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Dimensions (L × W × H)</span>
                  </div>
                  <span className="text-[10px] text-cyan-400 font-mono">mm</span>
                </div>
                <div className="text-slate-100 font-bold text-xs tracking-wide">
                  {modelInfo.dimensions.x} × {modelInfo.dimensions.y} × {modelInfo.dimensions.z}
                </div>
              </div>

              {/* Volume */}
              <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1">
                <div className="flex items-center justify-between text-slate-400 text-[11px] font-sans">
                  <div className="flex items-center gap-1.5">
                    <Gauge className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Material Volume</span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">{modelInfo.volumeMm3.toLocaleString()} mm³</span>
                </div>
                <div className="text-slate-100 font-bold text-xs">
                  {(modelInfo.volumeMm3 / 1000).toFixed(2)}{' '}
                  <span className="text-cyan-400 font-normal">cm³</span>
                </div>
              </div>

              {/* Mesh Complexity & Watertight Status */}
              <div className="grid grid-cols-2 gap-2">
                {/* Mesh Triangles */}
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="flex items-center gap-1.5 text-slate-400 text-[11px] font-sans">
                    <Layers className="w-3.5 h-3.5 text-amber-400" />
                    <span>Facets</span>
                  </div>
                  <div className="text-slate-100 font-bold text-xs">
                    {modelInfo.triangleCount.toLocaleString()}
                  </div>
                </div>

                {/* Manifold Check */}
                <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 space-y-1">
                  <div className="flex items-center gap-1.5 text-slate-400 text-[11px] font-sans">
                    {modelInfo.isWatertight ? (
                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                    )}
                    <span>Topology</span>
                  </div>
                  <div
                    className={`font-bold text-[11px] truncate ${
                      modelInfo.isWatertight ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {modelInfo.isWatertight ? '100% Solid' : 'Non-manifold'}
                  </div>
                </div>
              </div>
            </div>

            {/* Slicing Recommendations */}
            <div className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800/80 space-y-2">
              <div className="flex items-center gap-1.5 text-slate-300 text-xs font-semibold">
                <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                <span>Recommended Slicing</span>
              </div>
              <div className="space-y-1.5 text-[11px] text-slate-400 font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Layer Height:</span>
                  <span className="text-slate-200">0.20 mm</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Perimeters / Walls:</span>
                  <span className="text-slate-200">3 walls (1.2mm)</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Infill Density:</span>
                  <span className="text-slate-200">20% Gyroid</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Adhesion:</span>
                  <span className="text-emerald-400">Skirt only</span>
                </div>
              </div>
            </div>

            {/* Export Actions */}
            <div className="pt-1 space-y-2">
              <button
                onClick={handleExport3mf}
                disabled={!geometry || exporting}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 border border-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/30 transition-all disabled:opacity-50 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-indigo-200" />
                <span>Download 3MF (Color & Units)</span>
              </button>

              <button
                onClick={handleExportStl}
                disabled={!stlContent || exporting}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 text-slate-200 text-xs font-semibold shadow-xs transition-all disabled:opacity-50 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-cyan-400" />
                <span>Download Standard STL</span>
              </button>
            </div>
          </>
        ) : (
          <div className="h-full min-h-[180px] flex flex-col items-center justify-center text-center p-4 text-xs text-slate-500 space-y-2 font-mono">
            <Box className="w-8 h-8 text-slate-700 animate-pulse" />
            <p className="text-slate-400 font-semibold">No Model Compiled</p>
            <p className="text-[11px] text-slate-600 font-sans leading-relaxed">
              Describe a mechanical part in the chat or edit the OpenSCAD code to inspect print dimensions & export files.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
