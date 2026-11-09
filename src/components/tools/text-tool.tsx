'use client';

import React from 'react';
import type { ToolSettingsProps } from './tool-registry';
import {
  type ToolOp,
  type FacePlane,
  type FontId,
} from '@/lib/tools/ops';
import type { TopoFace } from '@/lib/geometry/topology';
import { checkPythonScript } from '@/lib/brep/body-check';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  ArrowDown,
  ArrowUp,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ChevronDown,
} from 'lucide-react';

import { FONT_IDS } from '@/lib/tools/op-text';

export const TEXT_EMPTY = 'Enter the text to add.';
export const TEXT_NOT_ALLOWED = 'This text cannot be added to the model.';

export { FONT_IDS };

const FONT_LABELS: Record<FontId, string> = {
  'inter-bold': 'Inter Bold',
  'roboto-mono-bold': 'Roboto Mono Bold',
  'oswald-semibold': 'Oswald SemiBold',
};

export function initialDraft(_face: TopoFace, plane: FacePlane): ToolOp {
  return {
    kind: 'text',
    id: '',
    part: '',
    plane,
    offset: [0, 0],
    rotationDeg: 0,
    text: 'CADAI',
    font: 'inter-bold',
    sizeMm: 6,
    mode: 'engrave',
    depthMm: 0.8,
    align: 'center',
  };
}

export function textApplyBlocker(draft: ToolOp | null): string | null {
  if (!draft || draft.kind !== 'text') return null;
  const text = draft.text ?? '';
  if (text.trim().length === 0) {
    return TEXT_EMPTY;
  }
  // Same limits as validateToolOp: at most 64 characters, no control characters.
  if (text.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(text)) {
    return TEXT_NOT_ALLOWED;
  }
  const check = checkPythonScript(`dummy = ${JSON.stringify(text)}\n`);
  if (!check.ok) {
    return TEXT_NOT_ALLOWED;
  }
  return null;
}

export function TextToolSettings({ draft, onChange }: ToolSettingsProps): React.JSX.Element {
  const isDraft = draft !== null && draft.kind === 'text';
  const textOp = isDraft ? draft : null;

  const textVal = textOp?.text ?? 'CADAI';
  const fontVal: FontId = textOp?.font ?? 'inter-bold';
  const sizeVal = textOp?.sizeMm ?? 6;
  const modeVal: 'engrave' | 'emboss' = textOp?.mode ?? 'engrave';
  const depthVal = textOp?.depthMm ?? 0.8;
  const colorVal = textOp?.color;
  const hasColor = colorVal !== undefined;
  const alignVal: 'left' | 'center' | 'right' = textOp?.align ?? 'center';
  const rotVal = textOp?.rotationDeg ?? 0;

  const disabled = !isDraft;

  return (
    <div className="space-y-3 text-xs">
      {/* 1. Text */}
      <div className="space-y-1">
        <label htmlFor="text-tool-input" className="block text-[11px] font-medium text-[var(--fg-muted)]">
          Text
        </label>
        <Input
          id="text-tool-input"
          value={textVal}
          maxLength={64}
          disabled={disabled}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="CADAI"
        />
      </div>

      {/* 2. Font */}
      <div className="space-y-1">
        <span className="block text-[11px] font-medium text-[var(--fg-muted)]">Font</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between font-normal text-xs h-9 bg-[var(--card)]"
            >
              <span>{FONT_LABELS[fontVal] ?? fontVal}</span>
              <ChevronDown className="w-3.5 h-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
            <DropdownMenuRadioGroup
              value={fontVal}
              onValueChange={(val) => onChange({ font: val as FontId })}
            >
              {FONT_IDS.map((fId) => (
                <DropdownMenuRadioItem key={fId} value={fId}>
                  {FONT_LABELS[fId]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 3. Size */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="text-tool-size" className="text-[11px] font-medium text-[var(--fg-muted)]">
            Size (mm)
          </label>
          <span className="font-mono text-[11px] text-[var(--fg)]">{sizeVal}</span>
        </div>
        <div className="flex items-center gap-2">
          <Slider
            min={1}
            max={30}
            step={0.5}
            value={[sizeVal]}
            disabled={disabled}
            onValueChange={([val]) => onChange({ sizeMm: val })}
            className="flex-1"
          />
          <Input
            id="text-tool-size"
            type="number"
            min={0.1}
            step={0.5}
            value={sizeVal}
            disabled={disabled}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) onChange({ sizeMm: v });
            }}
            className="w-16 h-8 text-right font-mono"
          />
        </div>
      </div>

      {/* 4. Mode */}
      <div className="space-y-1">
        <span className="block text-[11px] font-medium text-[var(--fg-muted)]">Mode</span>
        <ToggleGroup
          type="single"
          value={modeVal}
          disabled={disabled}
          onValueChange={(val) => {
            if (val === 'engrave' || val === 'emboss') onChange({ mode: val });
          }}
          className="w-full justify-stretch"
        >
          <ToggleGroupItem value="engrave" aria-label="Engrave" className="flex-1 gap-1.5">
            <ArrowDown className="w-3.5 h-3.5" />
            <span>Engrave</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="emboss" aria-label="Emboss" className="flex-1 gap-1.5">
            <ArrowUp className="w-3.5 h-3.5" />
            <span>Emboss</span>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* 5. Depth */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="text-tool-depth" className="text-[11px] font-medium text-[var(--fg-muted)]">
            Depth (mm)
          </label>
          <span className="font-mono text-[11px] text-[var(--fg)]">{depthVal}</span>
        </div>
        <div className="flex items-center gap-2">
          <Slider
            min={0.1}
            max={5}
            step={0.1}
            value={[depthVal]}
            disabled={disabled}
            onValueChange={([val]) => onChange({ depthMm: val })}
            className="flex-1"
          />
          <Input
            id="text-tool-depth"
            type="number"
            min={0.05}
            step={0.1}
            value={depthVal}
            disabled={disabled}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) onChange({ depthMm: v });
            }}
            className="w-16 h-8 text-right font-mono"
          />
        </div>
      </div>

      {/* 6. Color */}
      <div className="space-y-1.5">
        <span className="block text-[11px] font-medium text-[var(--fg-muted)]">Color</span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={hasColor ? 'default' : 'outline'}
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (hasColor) {
                onChange({ color: undefined });
              } else {
                onChange({ color: '#5b6b7d' });
              }
            }}
            className="h-8 text-xs font-normal"
          >
            {hasColor ? 'Custom' : 'None'}
          </Button>
          {hasColor && (
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={colorVal || '#5b6b7d'}
                disabled={disabled}
                onChange={(e) => onChange({ color: e.target.value })}
                className="w-8 h-8 rounded border border-[var(--glass-border)] bg-transparent cursor-pointer p-0.5"
              />
              <span className="font-mono text-[11px] text-[var(--fg-muted)]">{colorVal}</span>
            </div>
          )}
        </div>
      </div>

      {/* 7. Align */}
      <div className="space-y-1">
        <span className="block text-[11px] font-medium text-[var(--fg-muted)]">Align</span>
        <ToggleGroup
          type="single"
          value={alignVal}
          disabled={disabled}
          onValueChange={(val) => {
            if (val === 'left' || val === 'center' || val === 'right') onChange({ align: val });
          }}
          className="w-full justify-stretch"
        >
          <ToggleGroupItem value="left" aria-label="Left" className="flex-1">
            <AlignLeft className="w-3.5 h-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="center" aria-label="Center" className="flex-1">
            <AlignCenter className="w-3.5 h-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="right" aria-label="Right" className="flex-1">
            <AlignRight className="w-3.5 h-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* 8. Rotation */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="text-tool-rotation" className="text-[11px] font-medium text-[var(--fg-muted)]">
            Rotation (°)
          </label>
          <span className="font-mono text-[11px] text-[var(--fg)]">{rotVal}°</span>
        </div>
        <div className="flex items-center gap-2">
          <Slider
            min={-180}
            max={180}
            step={1}
            value={[rotVal]}
            disabled={disabled}
            onValueChange={([val]) => onChange({ rotationDeg: val })}
            className="flex-1"
          />
          <Input
            id="text-tool-rotation"
            type="number"
            step={5}
            value={rotVal}
            disabled={disabled}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) onChange({ rotationDeg: v });
            }}
            className="w-16 h-8 text-right font-mono"
          />
        </div>
      </div>
    </div>
  );
}
