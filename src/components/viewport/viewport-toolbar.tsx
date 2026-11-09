'use client';

import React from 'react';
import { useAppStore, type AppState } from '@/store/app-store';
import {
  MousePointer2,
  Layers,
  Eye,
  PenTool,
  type LucideIcon,
} from 'lucide-react';
import { ViewPresetsMenu } from './view-presets';
import { TOOLS } from '@/components/tools/tool-registry';
import { toolAvailability } from '@/store/tools-slice';

export interface ToolbarItemDef {
  id: string;
  label: string;
  icon?: LucideIcon;
  render?: () => React.ReactNode;
  isActive?: (state: AppState) => boolean;
  disabledReason?: (state: AppState) => string | null;
  onSelect?: (state: AppState) => void;
}

export function takeViewportSnapshot(): void {
  const canvas = document.querySelector('canvas');
  if (canvas) {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    const { setBaseSnapshot, setIsAnnotating } = useAppStore.getState();
    setBaseSnapshot(dataUrl);
    setIsAnnotating(true);
  }
}

export const TOOLBAR_ITEMS: readonly ToolbarItemDef[] = [
  {
    id: 'select',
    label: 'Select',
    icon: MousePointer2,
    isActive: () => true,
  },
  {
    id: 'wireframe',
    label: 'Wireframe',
    icon: Eye,
    isActive: (s) => Boolean(s.viewportSettings.wireframe),
    onSelect: (s) => s.updateViewportSettings({ wireframe: !s.viewportSettings.wireframe }),
  },
  {
    id: 'edges',
    label: 'Edges',
    icon: Layers,
    isActive: (s) => Boolean(s.viewportSettings.showEdges),
    onSelect: (s) => s.updateViewportSettings({ showEdges: !s.viewportSettings.showEdges }),
  },
  {
    id: 'presets',
    label: 'View presets',
    render: () => <ViewPresetsMenu />,
  },
  {
    id: 'markup',
    label: 'Snapshot & Annotate',
    icon: PenTool,
    isActive: (s) => s.isAnnotating,
    onSelect: () => takeViewportSnapshot(),
  },
] as const;

export function ViewportToolbar() {
  const store = useAppStore();

  return (
    <div
      role="toolbar"
      aria-label="Viewport controls"
      className="glass absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 rounded-full p-1.5 shadow-lg select-none"
    >
      {TOOLBAR_ITEMS.map((item) => {
        if (item.render) {
          return <React.Fragment key={item.id}>{item.render()}</React.Fragment>;
        }

        const active = item.isActive ? item.isActive(store) : false;
        const disabledReason = item.disabledReason ? item.disabledReason(store) : null;
        const isDisabled = disabledReason !== null;
        const label = isDisabled ? `${item.label} (${disabledReason})` : item.label;
        const Icon = item.icon;

        return (
          <button
            key={item.id}
            type="button"
            aria-label={label}
            title={label}
            disabled={isDisabled}
            onClick={() => item.onSelect?.(store)}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
              isDisabled
                ? 'opacity-40 cursor-not-allowed text-[var(--fg-muted)]'
                : active
                ? 'bg-[image:var(--accent-gradient)] text-[var(--fg)] shadow-[0_4px_12px_var(--accent-glow)] cursor-pointer'
                : 'text-[var(--fg-muted)] hover:bg-[var(--accent)] hover:text-[var(--fg)] cursor-pointer'
            }`}
          >
            {Icon && <Icon className="w-4 h-4" />}
          </button>
        );
      })}

      {TOOLS.map((tool) => {
        const disabledReason = toolAvailability(store, tool);
        const isDisabled = disabledReason !== null;
        const active = store.activeToolId === tool.id;
        const Icon = tool.icon;
        const label = isDisabled ? `${tool.label} (${disabledReason})` : tool.label;

        return (
          <button
            key={tool.id}
            type="button"
            aria-label={label}
            title={label}
            disabled={isDisabled}
            onClick={() => store.selectTool(tool.id)}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all ${
              isDisabled
                ? 'opacity-40 cursor-not-allowed text-[var(--fg-muted)]'
                : active
                ? 'bg-[image:var(--accent-gradient)] text-[var(--fg)] shadow-[0_4px_12px_var(--accent-glow)] cursor-pointer'
                : 'text-[var(--fg-muted)] hover:bg-[var(--accent)] hover:text-[var(--fg)] cursor-pointer'
            }`}
          >
            {Icon && <Icon className="w-4 h-4" />}
          </button>
        );
      })}
    </div>
  );
}
