import React from 'react';
import { useAppStore } from '@/store/app-store';
import { setParamValue } from '@/lib/design/write-params';
import { AlertTriangle, Check, RotateCcw, X, ShieldAlert } from 'lucide-react';
import { ParamValue } from '@/types';

export function ContractDiffBanner() {
  const { contractDiff, dismissContractDiff, code, setCode, unpinParam } = useAppStore();

  if (!contractDiff) return null;

  const handleRevert = (name: string, aiValue: ParamValue) => {
    // Unpin and restore the AI's value
    unpinParam(name);
    const newCode = setParamValue(code, name, aiValue);
    if (newCode !== code) {
      setCode(newCode, undefined, 'user');
    }
  };

  const handleRevertAll = () => {
    let currentCode = code;
    for (const item of contractDiff.applied) {
      unpinParam(item.name);
      currentCode = setParamValue(currentCode, item.name, item.aiValue);
    }
    if (currentCode !== code) {
      setCode(currentCode, undefined, 'user');
    }
    dismissContractDiff();
  };

  const hasApplied = contractDiff.applied.length > 0;
  const hasRejected = contractDiff.rejected.length > 0;
  const hasDropped = contractDiff.dropped.length > 0;

  if (!hasApplied && !hasRejected && !hasDropped) return null;

  return (
    <div className="mx-3 mt-3 p-3 rounded-lg bg-slate-900 border border-slate-700 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-slate-200">After Regeneration</h4>
        <button onClick={dismissContractDiff} className="text-slate-500 hover:text-slate-300">
          <X className="w-4 h-4" />
        </button>
      </div>

      {hasApplied && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-emerald-400">
            <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5" /> Kept {contractDiff.applied.length} pinned value{contractDiff.applied.length > 1 ? 's' : ''}</span>
            <button onClick={handleRevertAll} className="text-[10px] text-slate-400 hover:text-slate-200 flex items-center gap-1">
              <RotateCcw className="w-3 h-3" /> Revert All
            </button>
          </div>
          <div className="space-y-1">
            {contractDiff.applied.map(item => (
              <div key={item.name} className="flex items-center justify-between bg-slate-800/50 px-2 py-1.5 rounded text-[11px] font-mono">
                <div className="flex items-center gap-2">
                  <span className="text-slate-300">{item.name}</span>
                  <span className="text-slate-500 line-through">{String(item.aiValue)}</span>
                  <span className="text-emerald-400">{String(item.pinned)}</span>
                </div>
                <button
                  onClick={() => handleRevert(item.name, item.aiValue)}
                  className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition-colors"
                  title="Revert to AI value"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasRejected && (
        <div className="space-y-2">
          <div className="text-xs text-rose-400 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5" /> Rejected {contractDiff.rejected.length} pin{contractDiff.rejected.length > 1 ? 's' : ''}
          </div>
          <div className="space-y-1">
            {contractDiff.rejected.map(item => (
              <div key={item.name} className="flex flex-col bg-slate-800/50 px-2 py-1.5 rounded text-[11px] font-mono gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">{item.name}</span>
                  <span className="text-rose-400">{String(item.value)}</span>
                </div>
                <span className="text-slate-500 font-sans leading-tight">{item.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasDropped && (
        <div className="space-y-2">
          <div className="text-xs text-amber-400 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> Dropped {contractDiff.dropped.length} pin{contractDiff.dropped.length > 1 ? 's' : ''}
          </div>
          <div className="text-[11px] text-slate-400">
            {contractDiff.dropped.join(', ')} no longer exist in the code.
          </div>
        </div>
      )}
    </div>
  );
}
