'use client';

import React from 'react';
import { useAppStore } from '@/store/app-store';
import { GATEWAY_MODELS } from '@/lib/agent/models';
import { Box, Sparkles, RefreshCw, Cpu, CheckCircle2, AlertTriangle } from 'lucide-react';

export function AppHeader() {
  const {
    selectedModel,
    setSelectedModel,
    compileStatus,
    compileTimeMs,
    resetProject,
  } = useAppStore();
  return (
    <header className="h-14 bg-slate-950 border-b border-slate-800 px-4 flex items-center justify-between select-none z-10">
      {/* Brand & Title */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center shadow-md shadow-indigo-500/20">
          <Box className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-100 tracking-tight text-base">CAD AI</span>
            <span className="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              Agentic 3D
            </span>
          </div>
          <p className="text-[11px] text-slate-400 font-mono">Parametric OpenSCAD & FDM Print Tuning</p>
        </div>
      </div>

      {/* Center status badge */}
      <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs">
        <Cpu className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-slate-400">Engine:</span>
        <span className="font-medium text-slate-200">OpenSCAD WASM</span>
        <span className="text-slate-600">•</span>
        <span className="text-slate-400">Units:</span>
        <span className="font-semibold text-cyan-400 font-mono">mm</span>
        {compileStatus === 'success' && (
          <>
            <span className="text-slate-600">•</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-emerald-400 font-mono text-[11px]">{compileTimeMs}ms</span>
          </>
        )}
        {compileStatus === 'error' && (
          <>
            <span className="text-slate-600">•</span>
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-amber-400 text-[11px]">Compile Error</span>
          </>
        )}
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-2">
        {/* Model Selector */}
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="bg-slate-900 border border-slate-700 hover:border-slate-600 rounded-md px-2 py-1.5 text-xs text-indigo-300 font-mono focus:outline-none focus:border-indigo-500 cursor-pointer"
          title="Select the model driving the agent. All models run through the Experiential Labs gateway and authenticate server-side."
        >
          {GATEWAY_MODELS.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.label}
            </option>
          ))}
        </select>

        <button
          onClick={resetProject}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          title="Reset to default demo model"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Reset</span>
        </button>
      </div>

    </header>
  );
}
