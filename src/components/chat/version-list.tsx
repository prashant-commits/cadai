'use client';

import React from 'react';
import { useAppStore } from '@/store/app-store';
import type { ServerThreadVersion } from '@/lib/client/server-thread';
import { History, AlertTriangle } from 'lucide-react';

export const FAILED_CHECKS_LABEL = 'Failed checks';
export const DESIGNER_LABEL = 'Designer';
export const USER_EDIT_LABEL = 'Your edit';
export const ORIGIN_DESIGNER = DESIGNER_LABEL;
export const ORIGIN_USER_EDIT = USER_EDIT_LABEL;

export interface VersionListProps {
  versions?: ServerThreadVersion[];
  selectedVersion?: number | null;
  onSelect?: (version: number) => void;
}

export function VersionList(props: VersionListProps) {
  const store = useAppStore();
  const versions =
    props.versions ??
    (store.threads.find((t) => t.id === store.activeThreadId)?.versions || []);
  const selectedVersion =
    props.selectedVersion !== undefined ? props.selectedVersion : store.viewingVersion;
  const onSelect = props.onSelect ?? store.selectVersion;

  if (!versions || versions.length === 0) return null;

  // Newest first
  const sorted = [...versions].sort((a, b) => b.version - a.version);

  return (
    <div className="border-b border-slate-800 bg-slate-900/40 px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-semibold text-slate-400">
        <History className="w-3 h-3 text-indigo-400" />
        <span>Versions</span>
      </div>
      <div className="flex flex-col gap-1 max-h-36 overflow-y-auto scrollbar-thin">
        {sorted.map((v) => {
          const isSelected = selectedVersion === v.version;
          const hasFailedChecks = v.flags?.includes('failed_checks');
          const originLabel = v.origin === 'user_edit' ? USER_EDIT_LABEL : DESIGNER_LABEL;

          return (
            <button
              key={v.version}
              type="button"
              onClick={() => onSelect(v.version)}
              className={`flex items-center justify-between gap-2 px-2 py-1 rounded text-xs text-left transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 font-medium'
                  : 'bg-slate-950/60 hover:bg-slate-800 text-slate-300 border border-slate-800/80'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] font-bold text-indigo-400 shrink-0">
                  v{v.version}
                </span>
                <span className="truncate text-slate-300 text-[11px]">
                  {originLabel}
                </span>
              </div>
              {hasFailedChecks && (
                <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[10px] font-medium">
                  <AlertTriangle className="w-2.5 h-2.5" />
                  <span>{FAILED_CHECKS_LABEL}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
