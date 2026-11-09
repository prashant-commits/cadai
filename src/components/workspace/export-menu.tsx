'use client';

import React from 'react';
import { useAppStore } from '@/store/app-store';
import { exportStep, exportStl } from '@/lib/export/stl-exporter';
import { export3mf } from '@/lib/export/threemf-exporter';
import { fetchArtifactText } from '@/lib/client/server-thread';
import { Download } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

export type ExportExt = 'stl' | 'step' | '3mf';

export interface ExportFormat {
  id: ExportExt;
  label: string;
  ext: ExportExt;
  hint: string;
}

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  { id: 'stl', label: 'STL', ext: 'stl', hint: 'Mesh' },
  { id: 'step', label: 'STEP', ext: 'step', hint: 'CAD solid' },
  { id: '3mf', label: '3MF', ext: '3mf', hint: 'Mesh with units' },
] as const;

export function exportFileName(
  designTitle: string,
  version: number | null,
  ext: ExportExt
): string {
  const slug = designTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'design';

  if (version !== null && version !== undefined) {
    return `${slug}-v${version}.${ext}`;
  }
  return `${slug}-draft.${ext}`;
}

export function getExportDesignTitle(state: {
  threads?: Array<{ id: string; title?: string }>;
  activeThreadId?: string | null;
  projects?: Array<{ id: string; name?: string }>;
  activeProjectId?: string | null;
}): string {
  const activeThread = state.threads?.find((t) => t.id === state.activeThreadId);
  const threadTitle = activeThread?.title?.trim();
  if (threadTitle) return threadTitle;

  const activeProject = state.projects?.find((p) => p.id === state.activeProjectId);
  const projectName = activeProject?.name?.trim();
  if (projectName) return projectName;

  return 'design';
}

export function viewedExportVersion(state: {
  threads?: Array<{ id: string; versions?: Array<{ version: number; step?: string | null; body?: string }>; code?: string }>;
  activeThreadId?: string | null;
  viewingVersion?: number | null;
  code?: string;
}): { version: number | null; isDraft: boolean } {
  const activeThread = state.threads?.find((t) => t.id === state.activeThreadId);
  const version = activeThread?.versions?.find((v) => v.version === state.viewingVersion);
  if (!version) {
    return { version: null, isDraft: true };
  }

  const currentCode = (state.code !== undefined && state.code !== '') ? state.code : activeThread?.code;
  const isDraft = currentCode !== undefined ? currentCode !== version.body : false;

  return {
    version: isDraft ? null : version.version,
    isDraft,
  };
}

export function resolveExportVersion(state: {
  threads?: Array<{ id: string; versions?: Array<{ version: number; step?: string | null; body?: string }>; code?: string }>;
  activeThreadId?: string | null;
  viewingVersion?: number | null;
  code?: string;
}): number | null {
  return viewedExportVersion(state).version;
}

export interface ExportOptionItem extends ExportFormat {
  disabled: boolean;
}

export interface ExportOptionsState {
  stlContent?: unknown;
  geometry?: unknown;
  step?: unknown;
  threads?: Array<{
    id: string;
    title?: string;
    code?: string;
    versions?: Array<{ version: number; step?: string | null; body?: string }>;
  }>;
  activeThreadId?: string | null;
  viewingVersion?: number | null;
  code?: string;
}

export function exportOptions(state: ExportOptionsState): ExportOptionItem[] {
  const { isDraft } = viewedExportVersion(state);
  const activeThread = state.threads?.find((t) => t.id === state.activeThreadId);
  const version = activeThread?.versions?.find((v) => v.version === state.viewingVersion);

  const hasStl = Boolean(state.stlContent);
  const has3mf = Boolean(state.geometry);
  const hasStep = isDraft
    ? Boolean(state.step)
    : Boolean(version?.step || state.step);

  return EXPORT_FORMATS.map((fmt) => {
    let disabled = false;
    if (fmt.ext === 'stl') disabled = !hasStl;
    else if (fmt.ext === '3mf') disabled = !has3mf;
    else if (fmt.ext === 'step') disabled = !hasStep;

    return {
      ...fmt,
      disabled,
    };
  });
}

export async function downloadStep(): Promise<void> {
  const state = useAppStore.getState();
  const title = getExportDesignTitle(state);
  const { version: versionNum, isDraft } = viewedExportVersion(state);
  const filename = exportFileName(title, versionNum, 'step');

  try {
    const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
    const version = activeThread?.versions?.find((v) => v.version === state.viewingVersion);

    if (!isDraft && version?.step) {
      const stepText = await fetchArtifactText(version.step);
      exportStep(stepText, filename, 'text');
    } else if (state.step) {
      exportStep(state.step, filename, 'base64');
    }
  } catch (err) {
    console.error('Failed to download STEP file:', err);
  }
}

export function downloadStl(): void {
  const state = useAppStore.getState();
  if (!state.stlContent) return;
  const title = getExportDesignTitle(state);
  const { version: versionNum } = viewedExportVersion(state);
  const filename = exportFileName(title, versionNum, 'stl');

  try {
    exportStl(state.stlContent, filename);
  } catch (err) {
    console.error('Failed to download STL file:', err);
  }
}

export function download3mf(): void {
  const state = useAppStore.getState();
  if (!state.geometry) return;
  const title = getExportDesignTitle(state);
  const { version: versionNum } = viewedExportVersion(state);
  const filename = exportFileName(title, versionNum, '3mf');

  try {
    export3mf(state.geometry, filename);
  } catch (err) {
    console.error('Failed to download 3MF file:', err);
  }
}

export function ExportMenu() {
  const store = useAppStore();
  const options = exportOptions(store);

  const handleSelect = (ext: ExportExt) => {
    if (ext === 'stl') downloadStl();
    else if (ext === 'step') void downloadStep();
    else if (ext === '3mf') download3mf();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Export design"
          className="glass rounded-full px-3.5 py-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--fg)] hover:bg-[var(--accent)] transition-colors cursor-pointer select-none"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px] p-1">
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.id}
            disabled={opt.disabled}
            onClick={() => handleSelect(opt.ext)}
            className="flex items-center justify-between gap-4 cursor-pointer"
          >
            <span className="font-medium">{opt.label}</span>
            <span className="text-[11px] text-[var(--fg-muted)]">{opt.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
