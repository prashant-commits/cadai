'use client';

import React, { useState } from 'react';
import { AgentProgress } from '@/types';
import { Brain, Cog, Search, Wrench, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

interface ThinkingIndicatorProps {
  activeProgress: AgentProgress | null;
  history?: AgentProgress[];
}

export function ThinkingIndicator({ activeProgress, history = [] }: ThinkingIndicatorProps) {
  const [expanded, setExpanded] = useState(false);

  if (!activeProgress && history.length === 0) return null;

  const getStepIcon = (type: AgentProgress['type'], isCurrent = false) => {
    switch (type) {
      case 'thinking':
        return isCurrent ? <Brain className="w-4 h-4 text-purple-400 animate-pulse" /> : <Brain className="w-4 h-4 text-purple-400" />;
      case 'generating':
        return isCurrent ? <Cog className="w-4 h-4 text-blue-400 animate-spin" /> : <Cog className="w-4 h-4 text-blue-400" />;
      case 'validating':
        return isCurrent ? <Search className="w-4 h-4 text-amber-400 animate-bounce" /> : <Search className="w-4 h-4 text-amber-400" />;
      case 'fixing':
        return isCurrent ? <Wrench className="w-4 h-4 text-orange-400 animate-pulse" /> : <Wrench className="w-4 h-4 text-orange-400" />;
      case 'ready':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-rose-400" />;
      default:
        return <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />;
    }
  };

  const getBadgeStyle = (type: AgentProgress['type']) => {
    switch (type) {
      case 'thinking':
        return 'bg-purple-500/10 border-purple-500/20 text-purple-300';
      case 'generating':
        return 'bg-blue-500/10 border-blue-500/20 text-blue-300';
      case 'validating':
        return 'bg-amber-500/10 border-amber-500/20 text-amber-300';
      case 'fixing':
        return 'bg-orange-500/10 border-orange-500/20 text-orange-300';
      case 'ready':
        return 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300';
      case 'error':
        return 'bg-rose-500/10 border-rose-500/20 text-rose-300';
      default:
        return 'bg-indigo-500/10 border-indigo-500/20 text-indigo-300';
    }
  };

  return (
    <div className="my-3 rounded-lg border border-slate-800 bg-slate-900/80 backdrop-blur-xs overflow-hidden shadow-md">
      {/* Active step banner */}
      {activeProgress && (
        <div className={`flex items-center justify-between px-3.5 py-2.5 border-b border-slate-800/60 ${getBadgeStyle(activeProgress.type)}`}>
          <div className="flex items-center gap-2.5">
            {getStepIcon(activeProgress.type, true)}
            <span className="text-xs font-medium tracking-wide">
              {activeProgress.message}
            </span>
          </div>
          {history.length > 1 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-slate-400 hover:text-slate-200 text-xs flex items-center gap-1 transition-colors ml-2"
            >
              <span className="text-[10px] uppercase font-mono">{history.length} steps</span>
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      )}

      {/* History log collapsible */}
      {expanded && history.length > 0 && (
        <div className="p-3 bg-slate-950/60 space-y-2 text-xs divide-y divide-slate-800/40 font-mono">
          {history.map((step, idx) => (
            <div key={idx} className="flex items-start gap-2 pt-2 first:pt-0">
              <span className="mt-0.5">{getStepIcon(step.type)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-slate-300 text-[11px] leading-relaxed">{step.message}</p>
                {step.details && (
                  <pre className="mt-1 p-1.5 rounded bg-slate-900 text-[10px] text-amber-300 overflow-x-auto">
                    {step.details}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
