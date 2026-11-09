import React, { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { Info, ChevronDown, ChevronRight } from 'lucide-react';

export const NO_MODEL_INFO = 'No model yet.';

export function ModelInfo() {
  const [expanded, setExpanded] = useState(false);
  const { modelInfo, parts, threads, activeThreadId, viewingVersion } = useAppStore();

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const currentVersion = activeThread?.versions?.find((v) => v.version === viewingVersion);

  const partCount = parts.length > 0 ? parts.length : (currentVersion?.partLabels?.length ?? 0);

  let dimensionsText: string | null = null;
  if (modelInfo?.dimensions) {
    dimensionsText = `${modelInfo.dimensions.x.toFixed(1)} × ${modelInfo.dimensions.y.toFixed(1)} × ${modelInfo.dimensions.z.toFixed(1)} mm`;
  } else if (modelInfo?.boundingBox) {
    const dx = Math.abs(modelInfo.boundingBox.max[0] - modelInfo.boundingBox.min[0]);
    const dy = Math.abs(modelInfo.boundingBox.max[1] - modelInfo.boundingBox.min[1]);
    const dz = Math.abs(modelInfo.boundingBox.max[2] - modelInfo.boundingBox.min[2]);
    dimensionsText = `${dx.toFixed(1)} × ${dy.toFixed(1)} × ${dz.toFixed(1)} mm`;
  }

  const volumeText =
    typeof modelInfo?.volumeMm3 === 'number'
      ? `${(modelInfo.volumeMm3 / 1000).toFixed(1)} cm³`
      : null;

  return (
    <section className="space-y-1.5" aria-label="Model info">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--fg-muted)] px-1 py-1 rounded hover:bg-[var(--accent)] hover:text-[var(--fg)] transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <span className="flex items-center gap-1.5">
          <Info className="w-3 h-3" />
          <span>Model info</span>
        </span>
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
      </button>

      {expanded && (
        <div className="p-2.5 rounded-lg border border-[var(--glass-border)] bg-[var(--card)] space-y-2 text-xs">
          {!modelInfo ? (
            <p className="text-xs text-[var(--fg-muted)] italic">{NO_MODEL_INFO}</p>
          ) : (
            <div className="space-y-1.5 text-xs text-[var(--fg)]">
              {dimensionsText && (
                <div className="flex items-center justify-between">
                  <span className="text-[var(--fg-muted)]">Bounding box</span>
                  <span className="font-mono text-[11px]">{dimensionsText}</span>
                </div>
              )}
              {volumeText && (
                <div className="flex items-center justify-between">
                  <span className="text-[var(--fg-muted)]">Volume</span>
                  <span className="font-mono text-[11px]">{volumeText}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[var(--fg-muted)]">Parts</span>
                <span className="font-mono text-[11px]">{partCount}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
