import React from 'react';
import { useAppStore } from '@/store/app-store';
import { Box, Layers, CircleDot, Square, Type, Grid, Palette, type LucideIcon } from 'lucide-react';
import { listLayers, layerRows, type LayerRow } from '@/lib/tools/layers';

export { layerRows, type LayerRow };
export const NO_LAYERS = 'No parts yet.';

function opIconForKind(kind: string): LucideIcon {
  switch (kind) {
    case 'hole':
      return CircleDot;
    case 'cut-rect':
      return Square;
    case 'text':
      return Type;
    case 'texture':
      return Grid;
    case 'material':
      return Palette;
    default:
      return Box;
  }
}

export function LayersSection() {
  const {
    parts,
    code,
    selectedLayerId,
    setSelectedLayerId,
    threads,
    activeThreadId,
    viewingVersion,
    editOp,
    editingOpId,
    cancel,
  } = useAppStore();

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const currentVersion = activeThread?.versions?.find((v) => v.version === viewingVersion);

  const partRows = layerRows(parts, currentVersion);
  const opLayers = listLayers(code, []);
  const totalLayers = partRows.length + opLayers.length;

  return (
    <section className="space-y-1.5" aria-label="Layers">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-muted)] px-1 flex items-center gap-1.5">
        <Layers className="w-3 h-3" />
        <span>Layers</span>
      </div>
      {totalLayers === 0 ? (
        <p className="text-xs text-[var(--fg-muted)] px-1 py-1.5 italic">{NO_LAYERS}</p>
      ) : (
        <div className="space-y-1">
          {/* Part rows */}
          {partRows.map((row) => {
            const isSelected = selectedLayerId === row.id;
            return (
              <button
                key={row.id}
                type="button"
                data-layer-id={row.id}
                aria-pressed={isSelected}
                onClick={() => {
                  if (editingOpId) {
                    cancel();
                  }
                  setSelectedLayerId(isSelected ? null : row.id);
                }}
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

          {/* Op rows */}
          {opLayers.map((opRow) => {
            const isSelected = selectedLayerId === opRow.id;
            const OpIcon = opIconForKind(opRow.kind);
            return (
              <button
                key={opRow.id}
                type="button"
                data-layer-id={opRow.id}
                aria-pressed={isSelected}
                onClick={() => {
                  if (isSelected) {
                    if (editingOpId) {
                      cancel();
                    }
                    setSelectedLayerId(null);
                  } else {
                    if (editingOpId) {
                      cancel();
                    }
                    setSelectedLayerId(opRow.id);
                    editOp(opRow.id);
                  }
                }}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
                  isSelected
                    ? 'bg-[var(--accent)] text-[var(--fg)] border border-[var(--accent-from)] font-medium'
                    : 'text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--accent)] border border-transparent'
                }`}
              >
                <OpIcon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{opRow.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
