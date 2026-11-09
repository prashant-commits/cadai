import React from 'react';
import { useAppStore } from '@/store/app-store';
import { ParamControl } from '@/components/design/param-control';
import { SlidersHorizontal, Code2 } from 'lucide-react';
import type { ParamValue, ScadParam } from '@/types';
import { setParamValue } from '@/lib/design/write-params';

export const NO_PARAMS = 'No parameters in this model.';

/**
 * The panel's onChange for a param. Numeric slider moves write nothing here:
 * ParamControl follows every move with onPin, and pinParam writes the value
 * into the code and the draft's pinnedParams (never editedBody). Non-numeric
 * params (bool/string) cannot be pins, so they edit the body.
 */
export function changeParamValue(name: string, value: ParamValue) {
  if (typeof value === 'number') return;
  const { code, setCode } = useAppStore.getState();
  const newCode = setParamValue(code, name, value);
  if (newCode !== code) {
    setCode(newCode, undefined, 'user');
  }
}

/** One slider move exactly as ParamControl sends it: onChange, then onPin. */
export function applyParamMove(name: string, value: ParamValue) {
  changeParamValue(name, value);
  useAppStore.getState().pinParam(name, value);
}

export function PropertiesSection() {
  const {
    params,
    activeDraft,
    pinParam,
    unpinParam,
    setCodeDrawerOpen,
  } = useAppStore();

  const groups = params.reduce((acc, param) => {
    const groupName = param.group || 'General';
    if (!acc[groupName]) acc[groupName] = [];
    acc[groupName].push(param);
    return acc;
  }, {} as Record<string, ScadParam[]>);

  return (
    <section className="space-y-2" aria-label="Properties">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-muted)] px-1 flex items-center gap-1.5">
        <SlidersHorizontal className="w-3 h-3" />
        <span>Properties</span>
      </div>

      {params.length === 0 ? (
        <div className="space-y-2 px-1 py-1.5">
          <p className="text-xs text-[var(--fg-muted)] italic">{NO_PARAMS}</p>
          <button
            type="button"
            onClick={() => setCodeDrawerOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium text-[var(--fg)] border border-[var(--glass-border)] bg-[var(--card)] hover:bg-[var(--accent)] transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <Code2 className="w-3.5 h-3.5 text-[var(--accent-from)]" />
            <span>Open code</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(groups).map(([group, groupParams]) => (
            <div key={group} className="space-y-1">
              <div className="text-[9.5px] font-semibold uppercase tracking-wider text-[var(--fg-muted)]/75 px-1">
                {group}
              </div>
              <div className="space-y-1">
                {groupParams.map((p) => (
                  <ParamControl
                    key={p.name}
                    param={p}
                    pinned={!!activeDraft?.pinnedParams?.[p.name]}
                    onPin={(val) => pinParam(p.name, val)}
                    onUnpin={() => unpinParam(p.name)}
                    onChange={(val) => changeParamValue(p.name, val)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
