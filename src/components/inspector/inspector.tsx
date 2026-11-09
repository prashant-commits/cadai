import React from 'react';
import { useAppStore } from '@/store/app-store';
import { Code2 } from 'lucide-react';
import { LayersSection } from './layers-section';
import { PropertiesSection } from './properties-section';
import { VersionsSection } from './versions-section';
import { ModelInfo } from './model-info';

export function Inspector() {
  const { setCodeDrawerOpen } = useAppStore();

  return (
    <div className="h-full flex flex-col bg-transparent text-[var(--fg)] min-w-0">
      {/* Header row: title and Code pill button, pl-12 to leave room for FloatingPanel hide button */}
      <div className="flex items-center justify-between pl-12 pr-3 py-3 border-b border-[var(--glass-border)] shrink-0">
        <span className="text-sm font-semibold tracking-tight text-[var(--fg)]">Inspector</span>
        <button
          type="button"
          onClick={() => setCodeDrawerOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium text-[var(--fg)] border border-[var(--glass-border)] bg-[var(--card)] hover:bg-[var(--accent)] transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          title="Open code drawer"
        >
          <Code2 className="w-3.5 h-3.5 text-[var(--accent-from)]" />
          <span>Code</span>
        </button>
      </div>

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-5 min-w-0">
        <LayersSection />
        <PropertiesSection />
        <VersionsSection />
        <ModelInfo />
      </div>
    </div>
  );
}
