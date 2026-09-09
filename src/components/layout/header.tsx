'use client';

import React, { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { Box, Key, Sparkles, RefreshCw, Cpu, CheckCircle2, AlertTriangle } from 'lucide-react';

export function AppHeader() {
  const {
    apiKey,
    setApiKey,
    selectedModel,
    setSelectedModel,
    compileStatus,
    compileTimeMs,
    resetProject,
  } = useAppStore();
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [tempKey, setTempKey] = useState(apiKey);

  const handleSaveKey = () => {
    setApiKey(tempKey.trim());
    setShowKeyModal(false);
  };

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
          title="Select the model driving the agent. DeepSeek runs through the Experiential Labs gateway; Gemini uses your own key."
        >
          <optgroup label="Experiential Labs gateway (no daily cap)">
            <option value="deepseek-v4-flash">DeepSeek v4 Flash — Recommended</option>
            <option value="deepseek-v4-pro">DeepSeek v4 Pro</option>
            <option value="deepseek-v3.1">DeepSeek v3.1 — fastest</option>
            <option value="deepseek-v3.2">DeepSeek v3.2</option>
          </optgroup>
          <optgroup label="High quota (500 req/day)">
            <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite — 500/day</option>
            <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite — 500/day</option>
          </optgroup>
          <optgroup label="Standard quota (20 req/day)">
            <option value="gemini-3.6-flash">Gemini 3.6 Flash — 20/day</option>
            <option value="gemini-3.7-flash">Gemini 3.7 Flash — 20/day</option>
            <option value="gemini-3-flash">Gemini 3 Flash — 20/day</option>
            <option value="gemini-2.5-flash">Gemini 2.5 Flash — 20/day (Deep Reasoning)</option>
            <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite — 20/day</option>
          </optgroup>
        </select>

        <button
          onClick={() => {
            setTempKey(apiKey);
            setShowKeyModal(true);
          }}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-all ${
            apiKey
              ? 'bg-slate-900 border-emerald-500/30 text-emerald-400 hover:bg-slate-800'
              : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800 hover:border-slate-600'
          }`}
          title="Configure Gemini API Key"
        >
          <Key className="w-3.5 h-3.5" />
          <span>{apiKey ? 'API Key Set' : 'Add Gemini Key'}</span>
        </button>

        <button
          onClick={resetProject}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          title="Reset to default demo model"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Reset</span>
        </button>
      </div>

      {/* API Key Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-2 text-indigo-400">
              <Key className="w-5 h-5" />
              <h3 className="font-semibold text-lg text-slate-100">Google Gemini API Key</h3>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Enter your personal Google AI Studio / Gemini API key. It will be used for LangGraph agent generation and remains securely in your local browser session.
              If omitted, the server will use the server environment variable <code className="text-indigo-300">GOOGLE_API_KEY</code>.
            </p>
            <div className="space-y-1">
              <label className="text-xs text-slate-300 font-medium">API Key</label>
              <input
                type="password"
                value={tempKey}
                onChange={(e) => setTempKey(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-slate-300 font-medium">Model Name</label>
              <input
                type="text"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder="gemini-3.6-flash"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
              />
              <p className="text-[10px] text-slate-500">Only needed for gemini-* models. DeepSeek and gpt-5.6-luna authenticate server-side with EXPLABS_API_KEY.</p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowKeyModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveKey}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30 transition-all"
              >
                Save API Key
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
