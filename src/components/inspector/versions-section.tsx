import React, { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { History, AlertTriangle } from 'lucide-react';

export const USER_EDIT_LABEL = 'Your edit';
export const DESIGNER_LABEL = 'Designer';
export const FAILED_CHECKS_LABEL = 'Failed checks';
export const NO_VERSIONS = 'No versions yet.';

export function relativeTime(createdAt: number, now: number): string {
  const diffMs = Math.max(0, now - createdAt);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMin < 1) return 'now';
  if (diffHours < 1) return `${diffMin} min`;
  if (diffDays < 1) return `${diffHours} h`;
  return `${diffDays} d`;
}

export function selectVersionRow(n: number) {
  useAppStore.getState().setHighlightedVersion(n);
  void useAppStore.getState().selectVersion(n);
}

export function VersionsSection() {
  const [now] = useState(() => Date.now());
  const { threads, activeThreadId, viewingVersion } = useAppStore();

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const versions = activeThread?.versions ?? [];

  const sorted = [...versions].sort((a, b) => b.version - a.version);

  return (
    <section className="space-y-1.5" aria-label="Versions">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-muted)] px-1 flex items-center gap-1.5">
        <History className="w-3 h-3" />
        <span>Versions</span>
      </div>

      {sorted.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)] px-1 py-1.5 italic">{NO_VERSIONS}</p>
      ) : (
        <div className="space-y-1">
          {sorted.map((v) => {
            const isSelected = viewingVersion === v.version;
            const hasFailedChecks = v.flags?.includes('failed_checks');
            const originLabel = v.origin === 'user_edit' ? USER_EDIT_LABEL : DESIGNER_LABEL;
            const timeLabel = relativeTime(v.createdAt, now);

            return (
              <button
                key={v.version}
                type="button"
                onClick={() => selectVersionRow(v.version)}
                aria-current={isSelected ? 'true' : undefined}
                className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                  isSelected
                    ? 'bg-[var(--accent)] text-[var(--fg)] border border-[var(--accent-from)] font-medium'
                    : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--accent)] border border-transparent'
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono font-bold text-[var(--accent-from)] shrink-0">
                    v{v.version}
                  </span>
                  <span className="text-[var(--fg-muted)]">·</span>
                  <span className="truncate">{originLabel}</span>
                  <span className="text-[var(--fg-muted)]">·</span>
                  <span className="shrink-0 text-[var(--fg-muted)]">{timeLabel}</span>
                </div>

                {hasFailedChecks && (
                  <span className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-[var(--destructive)] bg-[var(--destructive)]/15 border border-[var(--destructive)]/30">
                    <AlertTriangle className="w-2.5 h-2.5" />
                    <span>{FAILED_CHECKS_LABEL}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
