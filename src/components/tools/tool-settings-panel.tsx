'use client';

import React from 'react';
import { useAppStore } from '@/store/app-store';
import {
  getTool,
  toolForOpKind,
  facePlane,
  partVariableForLabel,
  REBUILD_FOR_TOOLS,
  PICK_A_FACE,
  PICK_FLAT_FACE,
  PART_NOT_EDITABLE,
  PREVIEW_FAILED,
} from './tool-registry';
import { Button } from '@/components/ui/button';

export function ToolSettingsPanel() {
  const {
    activeToolId,
    editingOpId,
    draftOp,
    pickedFace,
    preview,
    applyStatus,
    applyError,
    topologyStatus,
    code,
    updateDraft,
    apply,
    cancel,
  } = useAppStore();

  const tool =
    getTool(activeToolId) ??
    (editingOpId && draftOp ? toolForOpKind(draftOp.kind) : undefined);

  if (!tool) return null;

  const Icon = tool.icon;

  let topoStatusPhrase: string | null = null;
  if (tool.needsFace) {
    if (topologyStatus === 'missing') {
      topoStatusPhrase = REBUILD_FOR_TOOLS;
    } else if (pickedFace === null && !editingOpId) {
      topoStatusPhrase = PICK_A_FACE;
    } else if (pickedFace && facePlane(pickedFace) === null) {
      topoStatusPhrase = PICK_FLAT_FACE;
    } else if (
      (pickedFace && partVariableForLabel(code, pickedFace.part) === null) ||
      preview.error === PART_NOT_EDITABLE
    ) {
      topoStatusPhrase = PART_NOT_EDITABLE;
    }
  }

  const applyBlocker = tool.applyBlocker?.(draftOp) ?? null;

  const isApplyDisabled =
    !draftOp || applyStatus === 'applying' || preview.status === 'error' || applyBlocker !== null;

  return (
    <div className="flex flex-col h-full overflow-hidden text-xs text-[var(--fg)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--glass-border)] shrink-0">
        {Icon && <Icon className="w-4 h-4 text-[var(--accent-from)]" />}
        <span className="font-semibold text-sm">{tool.label}</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {topoStatusPhrase && (
          <div className="text-xs text-[var(--fg-muted)] p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
            {topoStatusPhrase}
          </div>
        )}

        <div className="tool-settings-body">
          <tool.Settings draft={draftOp} onChange={updateDraft} />
        </div>

        {preview.status === 'error' && preview.error === PREVIEW_FAILED && (
          <div className="text-xs text-[var(--destructive)] p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
            {PREVIEW_FAILED}
            {preview.errorLine !== undefined ? ` · Line ${preview.errorLine}` : ''}
          </div>
        )}

        {applyError && (
          <div className="text-xs text-[var(--destructive)] p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
            {applyError}
          </div>
        )}

        {applyBlocker && (
          <div className="text-xs text-[var(--destructive)] p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
            {applyBlocker}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 p-3 border-t border-[var(--glass-border)] shrink-0">
        <Button variant="outline" size="sm" onClick={cancel}>
          Cancel
        </Button>
        {tool.modifies && (
          <Button
            size="sm"
            onClick={() => void apply()}
            disabled={isApplyDisabled}
          >
            {applyStatus === 'applying' ? 'Applying...' : 'Apply'}
          </Button>
        )}
      </div>
    </div>
  );
}
