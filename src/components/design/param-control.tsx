import React from 'react';
import { ScadParam, ParamValue } from '@/types';
import { useAppStore } from '@/store/app-store';
import { Pin, PinOff, RotateCcw, Code2 } from 'lucide-react';

interface ParamControlProps {
  param: ScadParam;
  pinned: boolean;
  onPin: (val: ParamValue) => void;
  onUnpin: () => void;
  onChange: (val: ParamValue) => void;
}

export function ParamControl({ param, pinned, onPin, onUnpin, onChange }: ParamControlProps) {
  const { setEditorView } = useAppStore();

  const handleReveal = () => {
    setEditorView('code');
    // In a real app we'd dispatch an event to the editor to scroll to `param.line`.
    // For now, just switching the view is enough for the MVP.
    window.dispatchEvent(new CustomEvent('reveal-line', { detail: { line: param.line } }));
  };

  const handleReset = () => {
    onChange(param.authoredValue);
    if (pinned) onUnpin();
  };

  const hasChanged = param.value !== param.authoredValue;

  return (
    <div className="group flex flex-col gap-1.5 py-2 px-3 rounded-md hover:bg-slate-800/30 transition-colors">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-slate-300 truncate pr-2" title={param.label || param.name}>
          {param.label || param.name}
        </label>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {hasChanged && (
            <button
              onClick={handleReset}
              className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700"
              title={`Reset to original (${param.authoredValue})`}
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={handleReveal}
            className="p-1 rounded text-slate-500 hover:text-cyan-400 hover:bg-slate-700"
            title="Reveal in Code"
          >
            <Code2 className="w-3 h-3" />
          </button>
          <button
            onClick={() => pinned ? onUnpin() : onPin(param.value)}
            className={`p-1 rounded hover:bg-slate-700 ${pinned ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'}`}
            title={pinned ? 'Unpin value' : 'Pin value'}
          >
            {pinned ? <Pin className="w-3 h-3 fill-current" /> : <PinOff className="w-3 h-3" />}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {param.kind === 'range' && (
          <>
            <input
              type="range"
              min={param.min ?? 0}
              max={param.max ?? 100}
              step={param.step ?? 1}
              value={Number(param.value)}
              onChange={(e) => {
                const val = Number(e.target.value);
                onChange(val);
                onPin(val);
              }}
              className="flex-1 accent-indigo-500 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer"
            />
            <input
              type="number"
              min={param.min}
              max={param.max}
              step={param.step}
              value={Number(param.value)}
              onChange={(e) => {
                const val = Number(e.target.value);
                onChange(val);
                onPin(val);
              }}
              className="w-14 px-1.5 py-1 text-xs font-mono text-right bg-slate-900 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </>
        )}

        {param.kind === 'number' && (
          <input
            type="number"
            value={Number(param.value)}
            onChange={(e) => {
              const val = Number(e.target.value);
              onChange(val);
              onPin(val);
            }}
            className="w-full px-2 py-1.5 text-xs font-mono bg-slate-900 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-indigo-500"
          />
        )}

        {param.kind === 'boolean' && (
          <input
            type="checkbox"
            checked={Boolean(param.value)}
            onChange={(e) => {
              const val = e.target.checked;
              onChange(val);
              onPin(val);
            }}
            className="w-4 h-4 text-indigo-500 bg-slate-900 border-slate-700 rounded focus:ring-indigo-500 focus:ring-offset-slate-950"
          />
        )}

        {param.kind === 'enum' && param.options && (
          <select
            value={String(param.value)}
            onChange={(e) => {
              // Try to parse back to number if it originally was
              const numVal = Number(e.target.value);
              const val = isNaN(numVal) ? e.target.value : numVal;
              onChange(val);
              onPin(val);
            }}
            className="w-full px-2 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            {param.options.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
