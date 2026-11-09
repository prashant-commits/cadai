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

export interface ToolbarItemDef {
  id: string;
  label: string;
  icon?: LucideIcon;
  render?: () => React.ReactNode;
  isActive?: (state: AppState) => boolean;
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
        const Icon = item.icon;

        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            title={item.label}
            onClick={() => item.onSelect?.(store)}
            className={`w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer ${
              active
                ? 'bg-[image:var(--accent-gradient)] text-[var(--fg)] shadow-[0_4px_12px_var(--accent-glow)]'
                : 'text-[var(--fg-muted)] hover:bg-[var(--accent)] hover:text-[var(--fg)]'
            }`}
          >
            {Icon && <Icon className="w-4 h-4" />}
          </button>
        );
      })}
    </div>
  );
}
