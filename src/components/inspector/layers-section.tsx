import React from 'react';
import { useAppStore } from '@/store/app-store';
import type { PartInfo } from '@/lib/contract/run-contract';
import type { ServerThreadVersion } from '@/lib/client/server-thread';
import { Box, Layers } from 'lucide-react';

export const NO_LAYERS = 'No parts yet.';

export interface LayerRow {
  id: string;
  label: string;
  box: { min: [number, number, number]; max: [number, number, number] } | null;
}

export function layerRows(
  parts: PartInfo[],
  viewingVersion: ServerThreadVersion | undefined
): LayerRow[] {
  if (parts.length > 0) {
    const counts = new Map<string, number>();
    return parts.map((p) => {
      const count = (counts.get(p.label) ?? 0) + 1;
      counts.set(p.label, count);
      const dedupLabel = count === 1 ? p.label : `${p.label} ${count}`;
      return {
        id: dedupLabel,
        label: dedupLabel,
        box: { min: p.min, max: p.max },
      };
    });
  }

  const versionLabels = viewingVersion?.partLabels ?? [];
  if (versionLabels.length > 0) {
    const counts = new Map<string, number>();
    return versionLabels.map((lbl) => {
      const count = (counts.get(lbl) ?? 0) + 1;
      counts.set(lbl, count);
      const dedupLabel = count === 1 ? lbl : `${lbl} ${count}`;
      return {
        id: dedupLabel,
        label: dedupLabel,
        box: null,
      };
    });
  }

  return [];
}

export function LayersSection() {
  const { parts, selectedLayerId, setSelectedLayerId, threads, activeThreadId, viewingVersion } =
    useAppStore();

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const currentVersion = activeThread?.versions?.find((v) => v.version === viewingVersion);

  const rows = layerRows(parts, currentVersion);

  return (
    <section className="space-y-1.5" aria-label="Layers">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-muted)] px-1 flex items-center gap-1.5">
        <Layers className="w-3 h-3" />
        <span>Layers</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)] px-1 py-1.5 italic">{NO_LAYERS}</p>
      ) : (
        <div className="space-y-1">
          {rows.map((row) => {
            const isSelected = selectedLayerId === row.id;
            return (
              <button
                key={row.id}
                type="button"
                data-layer-id={row.id}
                aria-pressed={isSelected}
                onClick={() => setSelectedLayerId(isSelected ? null : row.id)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                  isSelected
                    ? 'bg-[var(--accent)] text-[var(--fg)] border border-[var(--accent-from)] font-medium'
                    : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--accent)] border border-transparent'
                }`}
              >
                <Box className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{row.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
