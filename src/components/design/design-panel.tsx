import React, { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { PrintAnalysisPanel } from '@/components/print-analysis/print-analysis-panel';
import { ParamControl } from './param-control';
import { ContractDiffBanner } from './contract-diff-banner';
import { Code2, ChevronDown, ChevronRight, Settings2, Shield, Target, SlidersHorizontal } from 'lucide-react';
import { ParamValue } from '@/types';

export function DesignPanel() {
  const { 
    threads, 
    activeThreadId, 
    params, 
    setEditorView, 
    pinParam, 
    unpinParam, 
    setStanding,
    setCode,
    code
  } = useAppStore();

  const activeThread = threads.find(t => t.id === activeThreadId);
  const contract = activeThread?.designContract;
  
  const [openSections, setOpenSections] = useState({
    standing: false,
    intent: true,
    params: true,
    analysis: true,
  });

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleParamChange = (name: string, value: ParamValue) => {
    // In a real app we'd dispatch to write-params to update the code
    import('@/lib/design/write-params').then(({ setParamValue }) => {
      const newCode = setParamValue(code, name, value);
      if (newCode !== code) {
        setCode(newCode, undefined, 'user');
      }
    });
  };

  // Group params
  const groups = params.reduce((acc, param) => {
    const groupName = param.group || 'General';
    if (!acc[groupName]) acc[groupName] = [];
    acc[groupName].push(param);
    return acc;
  }, {} as Record<string, typeof params>);

  return (
    <div className="h-full flex flex-col bg-[#0b0f19] border-t border-slate-800 min-w-0">
      {/* Header */}
      <div className="px-3.5 py-2 bg-slate-950 border-b border-slate-800 flex items-center justify-between select-none shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Settings2 className="w-4 h-4 text-indigo-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-200 truncate">Design Intent & Parameters</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setEditorView('code')}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
            title="Switch to Code View"
          >
            <Code2 className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-[11px] hidden sm:inline">Code</span>
          </button>
        </div>
      </div>

      <ContractDiffBanner />

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-4">
        
        {/* 1. Standing Constraints */}
        <section className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900/30">
          <button 
            onClick={() => toggleSection('standing')}
            className="w-full flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800/80 transition-colors text-left"
          >
            {openSections.standing ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
            <Shield className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-semibold text-slate-300">Standing Constraints</span>
          </button>
          
          {openSections.standing && (
            <div className="p-3 border-t border-slate-800 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-500 font-sans">Build Volume (X Y Z mm)</label>
                  <input 
                    type="text" 
                    placeholder="250 250 250"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-slate-300 font-mono focus:border-indigo-500 focus:outline-none"
                    value={contract?.standing?.buildVolumeMm?.join(' ') || ''}
                    onChange={(e) => {
                      const parts = e.target.value.split(' ').map(Number);
                      if (parts.length === 3 && !parts.some(isNaN)) {
                        setStanding({ buildVolumeMm: parts as [number, number, number] });
                      }
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-500 font-sans">Material</label>
                  <select 
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-slate-300 focus:border-indigo-500 focus:outline-none"
                    value={contract?.standing?.material || 'PLA'}
                    onChange={(e) => setStanding({ material: e.target.value as any })}
                  >
                    <option value="PLA">PLA</option>
                    <option value="PETG">PETG</option>
                    <option value="ABS">ABS</option>
                    <option value="ASA">ASA</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-slate-500 font-sans">Max overhang (deg)</label>
                  <input
                    type="text"
                    placeholder="45"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-slate-300 font-mono focus:border-indigo-500 focus:outline-none"
                    value={contract?.standing?.maxOverhangDeg ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      if (raw === '') {
                        setStanding({ maxOverhangDeg: undefined });
                        return;
                      }
                      const deg = Number(raw);
                      if (!isNaN(deg) && deg > 0 && deg <= 90) setStanding({ maxOverhangDeg: deg });
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </section>

        {/* 2. Design Intent */}
        <section className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900/30">
          <button 
            onClick={() => toggleSection('intent')}
            className="w-full flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800/80 transition-colors text-left"
          >
            {openSections.intent ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
            <Target className="w-4 h-4 text-rose-400" />
            <span className="text-xs font-semibold text-slate-300">Design Intent</span>
          </button>
          
          {openSections.intent && (
            <div className="p-3 border-t border-slate-800 space-y-3">
              {contract?.spec ? (
                <div className="space-y-3">
                  {contract.spec.components && contract.spec.components.length > 0 && (
                    <div className="space-y-1">
                      <h5 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Parts</h5>
                      <ul className="text-xs text-slate-300 space-y-1 list-disc list-inside">
                        {contract.spec.components.map((p: any, i: number) => <li key={i}>{p.description}</li>)}
                      </ul>
                    </div>
                  )}
                  {contract.spec.assumptions && contract.spec.assumptions.length > 0 && (
                    <div className="space-y-1">
                      <h5 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Assumptions</h5>
                      <ul className="text-xs text-amber-200/80 space-y-1 list-disc list-inside">
                        {contract.spec.assumptions.map((a: any, i: number) => <li key={i}>{a.field}: {a.value} - {a.rationale}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500 italic">No approved design intent yet.</p>
              )}
            </div>
          )}
        </section>

        {/* 3. Parameters */}
        <section className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900/30">
          <button 
            onClick={() => toggleSection('params')}
            className="w-full flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800/80 transition-colors text-left"
          >
            {openSections.params ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
            <SlidersHorizontal className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-semibold text-slate-300">Parameters</span>
          </button>
          
          {openSections.params && (
            <div className="p-3 border-t border-slate-800 space-y-4">
              {params.length > 0 ? (
                Object.entries(groups).map(([group, groupParams]) => (
                  <div key={group} className="space-y-2">
                    <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-1">{group}</h4>
                    <div className="space-y-1">
                      {groupParams.map((p) => (
                        <ParamControl 
                          key={p.name} 
                          param={p}
                          pinned={!!contract?.pinnedParams?.[p.name]}
                          onPin={(val) => pinParam(p.name, val)}
                          onUnpin={() => unpinParam(p.name)}
                          onChange={(val) => handleParamChange(p.name, val)}
                        />
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-xs text-slate-500 p-2 text-center space-y-2">
                  <p>No parameters parsed.</p>
                  <p>Declare global variables at the top of your code.</p>
                  <button 
                    onClick={() => setEditorView('code')}
                    className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
                  >
                    View Code
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 4. Analysis */}
        <section className="border border-slate-800 rounded-lg overflow-hidden bg-slate-900/30">
          <button 
            onClick={() => toggleSection('analysis')}
            className="w-full flex items-center gap-2 px-3 py-2 bg-slate-900 hover:bg-slate-800/80 transition-colors text-left"
          >
            {openSections.analysis ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
            <span className="w-4 h-4 text-indigo-400 flex items-center justify-center font-bold font-serif text-[14px]">∑</span>
            <span className="text-xs font-semibold text-slate-300">Print Analysis</span>
          </button>
          
          {openSections.analysis && (
            <div className="p-3 border-t border-slate-800">
              <PrintAnalysisPanel />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
