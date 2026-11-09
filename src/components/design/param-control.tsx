import React from 'react';
import type { ScadParam, ParamValue } from '@/types';
import { useAppStore } from '@/store/app-store';
import { Pin, PinOff, RotateCcw, Code2 } from 'lucide-react';
import { Slider } from '@/components/ui/slider';

interface ParamControlProps {
  param: ScadParam;
  pinned: boolean;
  onPin: (val: ParamValue) => void;
  onUnpin: () => void;
  onChange: (val: ParamValue) => void;
}

export function ParamControl({ param, pinned, onPin, onUnpin, onChange }: ParamControlProps) {
  const { setCodeDrawerOpen } = useAppStore();

  const handleReveal = () => {
    setCodeDrawerOpen(true);
    window.dispatchEvent(new CustomEvent('reveal-line', { detail: { line: param.line } }));
  };

  const handleReset = () => {
    onChange(param.authoredValue);
    if (pinned) {
      onUnpin();
    } else if (typeof param.authoredValue === 'number') {
      const { code, setCode } = useAppStore.getState();
      import('@/lib/design/write-params').then(({ setParamValue }) => {
        const newCode = setParamValue(code, param.name, param.authoredValue);
        if (newCode !== code) {
          setCode(newCode, undefined, 'user');
        }
      });
    }
  };

  const hasChanged = param.value !== param.authoredValue;
  const showReset = hasChanged || pinned;

  return (
    <div className="flex flex-col gap-1.5 py-2 px-2.5 rounded-lg border border-transparent hover:border-[var(--glass-border)] hover:bg-[var(--card)] transition-colors">
      <div className="flex items-center justify-between">
        <label
          className="text-xs font-medium text-[var(--fg)] truncate pr-2"
          title={param.label || param.name}
        >
          {param.label || param.name}
        </label>
        <div className="flex items-center gap-1">
          {showReset && (
            <button
              type="button"
              onClick={handleReset}
              className="p-1 rounded text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--accent)] transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              aria-label={`Reset ${param.label || param.name} to original (${param.authoredValue})`}
              title={`Reset to original (${param.authoredValue})`}
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            onClick={handleReveal}
            className="p-1 rounded text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--accent)] transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            aria-label={`Reveal ${param.label || param.name} in code`}
            title="Reveal in code"
          >
            <Code2 className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => (pinned ? onUnpin() : onPin(param.value))}
            aria-pressed={pinned}
            data-pinned={pinned ? 'true' : 'false'}
            className={`p-1 rounded transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
              pinned
                ? 'text-[var(--accent-from)] hover:bg-[var(--accent)]'
                : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--accent)]'
            }`}
            aria-label={
              pinned ? `Unpin ${param.label || param.name}` : `Pin ${param.label || param.name}`
            }
            title={pinned ? 'Unpin value' : 'Pin value'}
          >
            {pinned ? <Pin className="w-3 h-3 fill-current" /> : <PinOff className="w-3 h-3" />}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {param.kind === 'range' && (
          <>
            <Slider
              value={[Number(param.value)]}
              min={param.min ?? 0}
              max={param.max ?? 100}
              step={param.step ?? 1}
              onValueChange={([val]) => {
                onChange(val);
                onPin(val);
              }}
              className="flex-1"
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
              className="w-14 px-1.5 py-1 text-xs font-mono text-right bg-[var(--card)] border border-[var(--glass-border)] rounded text-[var(--fg)] focus:outline-none focus:border-[var(--accent-from)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
            className="w-full px-2 py-1.5 text-xs font-mono bg-[var(--card)] border border-[var(--glass-border)] rounded text-[var(--fg)] focus:outline-none focus:border-[var(--accent-from)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
            className="w-4 h-4 accent-[var(--accent-from)] bg-[var(--card)] border-[var(--glass-border)] rounded focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          />
        )}

        {param.kind === 'enum' && param.options && (
          <select
            value={String(param.value)}
            onChange={(e) => {
              const numVal = Number(e.target.value);
              const val = isNaN(numVal) ? e.target.value : numVal;
              onChange(val);
              onPin(val);
            }}
            className="w-full px-2 py-1.5 text-xs bg-[var(--card)] border border-[var(--glass-border)] rounded text-[var(--fg)] focus:outline-none focus:border-[var(--accent-from)] focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            {param.options.map((opt) => (
              <option key={opt.value} value={opt.value} className="bg-[var(--bg)] text-[var(--fg)]">
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
