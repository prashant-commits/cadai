'use client';

import React from 'react';
import type { ToolSettingsProps } from './tool-registry';
import { PICK_A_FACE } from './tool-registry';
import type { ToolOp, FacePlane } from '@/lib/tools/ops';
import { HOLE_PRESETS } from '@/lib/tools/op-hole';
import type { TopoFace } from '@/lib/geometry/topology';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Input } from '@/components/ui/input';

export const TYPE_LABEL = 'Type';
export const ROUND_HOLE = 'Round hole';
export const RECT_CUTOUT = 'Rectangular cut-out';
export const SIZE_LABEL = 'Size';
export const SIZE_CUSTOM = 'Custom';
export const DIAMETER_LABEL = 'Diameter';
export const HEAD_LABEL = 'Head';
export const HEAD_NONE = 'None';
export const HEAD_COUNTERBORE = 'Counterbore';
export const HEAD_COUNTERSINK = 'Countersink';
export const HEADS_NEED_PRESET = 'Heads need a preset size.';
export const DEPTH_LABEL = 'Depth';
export const DEPTH_THROUGH = 'Through';
export const WIDTH_LABEL = 'Width';
export const HEIGHT_LABEL = 'Height';
export const CORNER_RADIUS_LABEL = 'Corner radius';

export function maxCornerRadius(widthMm: number, heightMm: number): number {
  return Math.max(
    0,
    Math.round((Math.min(widthMm, heightMm) / 2 - 0.1) * 10) / 10
  );
}

export function cutRectSizePatch(
  draft: { widthMm: number; heightMm: number; cornerRadiusMm: number },
  update: { widthMm?: number; heightMm?: number }
): Partial<Extract<ToolOp, { kind: 'cut-rect' }>> {
  const newWidth = update.widthMm ?? draft.widthMm;
  const newHeight = update.heightMm ?? draft.heightMm;
  const maxR = maxCornerRadius(newWidth, newHeight);
  const patch: Partial<Extract<ToolOp, { kind: 'cut-rect' }>> = {};
  if (update.widthMm !== undefined) patch.widthMm = update.widthMm;
  if (update.heightMm !== undefined) patch.heightMm = update.heightMm;
  if (draft.cornerRadiusMm > maxR) {
    patch.cornerRadiusMm = maxR;
  }
  return patch;
}

export function cutRectCornerRadiusPatch(
  draft: { widthMm: number; heightMm: number },
  cornerRadiusMm: number
): Partial<Extract<ToolOp, { kind: 'cut-rect' }>> {
  const maxR = maxCornerRadius(draft.widthMm, draft.heightMm);
  return { cornerRadiusMm: Math.max(0, Math.min(cornerRadiusMm, maxR)) };
}

export function holeSizePatch(
  size: 'M3' | 'M4' | 'M5' | 'M6' | 'M8' | 'custom',
  currentDraft?: { head?: string }
): Partial<ToolOp> {
  if (size === 'custom') {
    if (currentDraft?.head && currentDraft.head !== 'none') {
      return { size: 'custom', head: 'none' };
    }
    return { size: 'custom' };
  }
  const preset = HOLE_PRESETS[size];
  return { size, diameterMm: preset.clearanceMm };
}

export function switchTypePatch(
  toKind: 'hole' | 'cut-rect',
  currentDraft?: ToolOp | null
): Partial<ToolOp> {
  const currentDepth =
    currentDraft && 'depthMm' in currentDraft ? currentDraft.depthMm : 'through';

  if (toKind === 'cut-rect') {
    return {
      kind: 'cut-rect',
      widthMm: 20,
      heightMm: 10,
      cornerRadiusMm: 0,
      depthMm: currentDepth,
    };
  }
  return {
    kind: 'hole',
    size: 'M5',
    diameterMm: 5.5,
    head: 'none',
    depthMm: currentDepth,
  };
}

export function initialDraft(face: TopoFace, plane: FacePlane): ToolOp {
  return {
    kind: 'hole',
    id: 'op_hole_draft',
    part: face.part,
    plane,
    offset: [0, 0],
    rotationDeg: 0,
    size: 'M5',
    diameterMm: 5.5,
    head: 'none',
    depthMm: 'through',
  };
}

export const HoleSettings: React.FC<ToolSettingsProps> = ({ draft, onChange }) => {
  if (!draft || (draft.kind !== 'hole' && draft.kind !== 'cut-rect')) {
    return (
      <div className="text-xs text-[var(--fg-muted)] p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
        {PICK_A_FACE}
      </div>
    );
  }

  const isHole = draft.kind === 'hole';
  const isCutRect = draft.kind === 'cut-rect';

  return (
    <div className="space-y-4 text-xs text-[var(--fg)]">
      {/* 1. Type */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-[var(--fg-muted)]">
          {TYPE_LABEL}
        </label>
        <ToggleGroup
          type="single"
          value={draft.kind}
          onValueChange={(val) => {
            if (val === 'hole' || val === 'cut-rect') {
              onChange(switchTypePatch(val, draft));
            }
          }}
          variant="outline"
          size="sm"
          className="w-full justify-start"
        >
          <ToggleGroupItem value="hole" className="flex-1 text-xs">
            {ROUND_HOLE}
          </ToggleGroupItem>
          <ToggleGroupItem value="cut-rect" className="flex-1 text-xs">
            {RECT_CUTOUT}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* 2. Size (holes only) */}
      {isHole && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">
              {SIZE_LABEL}
            </label>
            {draft.size !== 'custom' && (
              <span className="font-mono text-xs text-[var(--fg)]">
                Ø{draft.diameterMm.toFixed(1)}
              </span>
            )}
          </div>
          <ToggleGroup
            type="single"
            value={draft.size}
            onValueChange={(val) => {
              if (
                val === 'M3' ||
                val === 'M4' ||
                val === 'M5' ||
                val === 'M6' ||
                val === 'M8' ||
                val === 'custom'
              ) {
                onChange(holeSizePatch(val, draft));
              }
            }}
            variant="outline"
            size="sm"
            className="w-full flex-wrap gap-1"
          >
            {(['M3', 'M4', 'M5', 'M6', 'M8'] as const).map((sz) => (
              <ToggleGroupItem key={sz} value={sz} className="px-2.5 text-xs font-mono">
                {sz}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="custom" className="px-2.5 text-xs">
              {SIZE_CUSTOM}
            </ToggleGroupItem>
          </ToggleGroup>

          {draft.size === 'custom' && (
            <div className="pt-1 space-y-1">
              <label className="text-[11px] font-medium text-[var(--fg-muted)]">
                {DIAMETER_LABEL} (mm)
              </label>
              <Input
                type="number"
                min="0.5"
                max="50"
                step="0.1"
                value={draft.diameterMm}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (Number.isFinite(val) && val > 0) {
                    onChange({ diameterMm: Math.min(50, Math.max(0.5, val)) });
                  }
                }}
                className="font-mono text-xs h-8"
              />
            </div>
          )}
        </div>
      )}

      {/* 3. Head (holes only) */}
      {isHole && (
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-[var(--fg-muted)]">
            {HEAD_LABEL}
          </label>
          <ToggleGroup
            type="single"
            value={draft.head}
            onValueChange={(val) => {
              if (val === 'none' || val === 'counterbore' || val === 'countersink') {
                onChange({ head: val });
              }
            }}
            variant="outline"
            size="sm"
            className="w-full justify-start"
          >
            <ToggleGroupItem value="none" className="flex-1 text-xs">
              {HEAD_NONE}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="counterbore"
              disabled={draft.size === 'custom'}
              className="flex-1 text-xs"
            >
              {HEAD_COUNTERBORE}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="countersink"
              disabled={draft.size === 'custom'}
              className="flex-1 text-xs"
            >
              {HEAD_COUNTERSINK}
            </ToggleGroupItem>
          </ToggleGroup>

          {draft.size === 'custom' ? (
            <div className="text-xs text-[var(--fg-muted)] p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
              {HEADS_NEED_PRESET}
            </div>
          ) : (
            <>
              {draft.head === 'counterbore' && draft.size in HOLE_PRESETS && (
                <div className="text-xs text-[var(--fg-muted)] font-mono p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
                  Ø{HOLE_PRESETS[draft.size].counterboreDiaMm.toFixed(1)} ×{' '}
                  {HOLE_PRESETS[draft.size].counterboreDepthMm.toFixed(1)} deep
                </div>
              )}
              {draft.head === 'countersink' && draft.size in HOLE_PRESETS && (
                <div className="text-xs text-[var(--fg-muted)] font-mono p-2 rounded bg-[var(--card)] border border-[var(--glass-border)]">
                  Ø{HOLE_PRESETS[draft.size].countersinkDiaMm.toFixed(1)} · 90°
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* 4. Depth */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-[var(--fg-muted)]">
          {DEPTH_LABEL}
        </label>
        <ToggleGroup
          type="single"
          value={draft.depthMm === 'through' ? 'through' : 'depth'}
          onValueChange={(val) => {
            if (val === 'through') {
              onChange({ depthMm: 'through' });
            } else if (val === 'depth') {
              onChange({
                depthMm: typeof draft.depthMm === 'number' ? draft.depthMm : 5,
              });
            }
          }}
          variant="outline"
          size="sm"
          className="w-full justify-start"
        >
          <ToggleGroupItem value="through" className="flex-1 text-xs">
            {DEPTH_THROUGH}
          </ToggleGroupItem>
          <ToggleGroupItem value="depth" className="flex-1 text-xs">
            {DEPTH_LABEL}
          </ToggleGroupItem>
        </ToggleGroup>

        {draft.depthMm !== 'through' && (
          <div className="pt-1">
            <Input
              type="number"
              min="0.1"
              step="0.5"
              value={typeof draft.depthMm === 'number' ? draft.depthMm : 5}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (Number.isFinite(val) && val > 0) {
                  onChange({ depthMm: val });
                }
              }}
              className="font-mono text-xs h-8"
            />
          </div>
        )}
      </div>

      {/* 5. Cut-out only */}
      {isCutRect && (
        <div className="space-y-3 pt-1 border-t border-[var(--glass-border)]">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">
              {WIDTH_LABEL} (mm)
            </label>
            <Input
              type="number"
              min="0.1"
              step="0.5"
              value={draft.widthMm}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (Number.isFinite(val) && val > 0) {
                  onChange(cutRectSizePatch(draft, { widthMm: val }));
                }
              }}
              className="font-mono text-xs h-8"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">
              {HEIGHT_LABEL} (mm)
            </label>
            <Input
              type="number"
              min="0.1"
              step="0.5"
              value={draft.heightMm}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (Number.isFinite(val) && val > 0) {
                  onChange(cutRectSizePatch(draft, { heightMm: val }));
                }
              }}
              className="font-mono text-xs h-8"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">
              {CORNER_RADIUS_LABEL} (mm)
            </label>
            <Input
              type="number"
              min="0"
              max={maxCornerRadius(draft.widthMm, draft.heightMm)}
              step="0.5"
              value={draft.cornerRadiusMm}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                if (Number.isFinite(val) && val >= 0) {
                  onChange(cutRectCornerRadiusPatch(draft, val));
                }
              }}
              className="font-mono text-xs h-8"
            />
          </div>
        </div>
      )}
    </div>
  );
};
