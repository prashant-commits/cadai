'use client';

import React from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store/app-store';
import {
  facePlane,
  partVariableForLabel,
  type ToolSettingsProps,
} from './tool-registry';
import {
  textureFeatureCount,
  faceExtentMm,
  clampAreaToFace,
} from '@/lib/tools/op-texture';
import {
  MATERIAL_PRESETS,
  type MaterialId,
} from '@/components/viewport/material-presets';

interface DraftNumberInputProps {
  value: number;
  onCommit: (val: number) => void;
  min?: number;
  max?: number;
  step?: string;
  className?: string;
}

function DraftNumberInput({
  value,
  onCommit,
  min,
  max,
  step = '0.1',
  className,
}: DraftNumberInputProps) {
  const [prevValue, setPrevValue] = React.useState(value);
  const [text, setText] = React.useState(String(value));

  if (value !== prevValue) {
    setPrevValue(value);
    setText(String(value));
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) {
      if (min !== undefined && parsed < min) return;
      const clamped = max !== undefined ? Math.min(parsed, max) : parsed;
      onCommit(clamped);
    }
  };

  const handleBlur = () => {
    const parsed = parseFloat(text);
    if (Number.isFinite(parsed) && (min === undefined || parsed >= min)) {
      const clamped = max !== undefined ? Math.min(parsed, max) : parsed;
      setText(String(clamped));
      onCommit(clamped);
    } else {
      setText(String(value));
    }
  };

  return (
    <Input
      type="number"
      step={step}
      min={min}
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      className={className}
    />
  );
}

interface DraftHexInputProps {
  value: string;
  onCommit: (val: string) => void;
  className?: string;
}

function DraftHexInput({ value, onCommit, className }: DraftHexInputProps) {
  const [prevValue, setPrevValue] = React.useState(value);
  const [text, setText] = React.useState(value);

  if (value !== prevValue) {
    setPrevValue(value);
    setText(value);
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
      onCommit(raw.toLowerCase());
    }
  };

  const handleBlur = () => {
    if (/^#[0-9a-fA-F]{6}$/.test(text)) {
      const lower = text.toLowerCase();
      setText(lower);
      onCommit(lower);
    } else {
      setText(value);
    }
  };

  return (
    <Input
      type="text"
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      className={className}
    />
  );
}

export function TextureSettings({ draft, onChange }: ToolSettingsProps) {
  const { editingOpId, toolTopology, pickedFace, code } = useAppStore();

  const isMaterial = draft?.kind === 'material';
  const isTexture = draft?.kind === 'texture';

  const partVar =
    (pickedFace && partVariableForLabel(code, pickedFace.part)) ||
    (draft && 'part' in draft && typeof draft.part === 'string' && draft.part !== 'part'
      ? draft.part
      : null);
  const hasPart = Boolean(partVar);

  const extent = React.useMemo(() => {
    if (!toolTopology || !pickedFace) return null;
    const plane = facePlane(pickedFace);
    if (!plane) return null;
    return faceExtentMm(toolTopology, pickedFace.id, plane);
  }, [toolTopology, pickedFace]);

  const extentKey = extent ? `${pickedFace?.id}_${extent[0]}_${extent[1]}` : '';

  React.useEffect(() => {
    if (!extent || !draft || draft.kind !== 'texture') return;
    const clamped = clampAreaToFace(draft.areaMm, extent);
    if (clamped[0] !== draft.areaMm[0] || clamped[1] !== draft.areaMm[1]) {
      onChange({ areaMm: clamped });
    }
  }, [extentKey, draft, extent, onChange]);

  if (!draft) return null;

  let maxW = Infinity;
  let maxH = Infinity;
  if (extent) {
    if (extent[0] > 0) maxW = Math.round(extent[0] * 10) / 10;
    if (extent[1] > 0) maxH = Math.round(extent[1] * 10) / 10;
  }

  return (
    <div className="space-y-3">
      {/* Kind: Surface | Material */}
      <div className="space-y-1">
        <label className="text-[11px] font-medium text-[var(--fg-muted)]">Kind</label>
        <ToggleGroup
          type="single"
          value={draft.kind}
          disabled={Boolean(editingOpId)}
          onValueChange={(val) => {
            if (!val || val === draft.kind) return;
            if (val === 'material') {
              const target = hasPart && partVar ? partVar : 'model';
              onChange({
                kind: 'material',
                id: draft.id,
                target,
                material: 'matte-plastic',
                color: MATERIAL_PRESETS['matte-plastic'].defaultColor,
              });
            } else if (val === 'texture') {
              const side = pickedFace
                ? Math.round(Math.min(20, 0.8 * Math.sqrt(pickedFace.area)) * 10) / 10
                : 20;
              onChange({
                kind: 'texture',
                id: draft.id,
                pattern: 'knurl',
                pitchMm: 2.0,
                depthMm: 0.4,
                offset: [0, 0],
                rotationDeg: 0,
                areaMm: [side, side],
              });
            }
          }}
          className="w-full justify-start"
        >
          <ToggleGroupItem value="texture" className="flex-1 text-xs">
            Surface
          </ToggleGroupItem>
          <ToggleGroupItem value="material" className="flex-1 text-xs">
            Material
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Surface Texture settings */}
      {isTexture && (
        <>
          {/* Pattern */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">Pattern</label>
            <ToggleGroup
              type="single"
              value={draft.pattern}
              onValueChange={(val) => {
                if (val) onChange({ pattern: val as 'knurl' | 'hex' | 'ribs' | 'dimples' });
              }}
              className="w-full justify-start"
            >
              <ToggleGroupItem value="knurl" className="flex-1 text-xs">
                Knurl
              </ToggleGroupItem>
              <ToggleGroupItem value="hex" className="flex-1 text-xs">
                Hex
              </ToggleGroupItem>
              <ToggleGroupItem value="ribs" className="flex-1 text-xs">
                Ribs
              </ToggleGroupItem>
              <ToggleGroupItem value="dimples" className="flex-1 text-xs">
                Dimples
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Pitch */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">Pitch (mm)</label>
            <DraftNumberInput
              value={draft.pitchMm}
              min={0.001}
              step="0.1"
              onCommit={(val) => onChange({ pitchMm: val })}
              className="h-8 text-xs font-mono"
            />
          </div>

          {/* Depth */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">Depth (mm)</label>
            <DraftNumberInput
              value={draft.depthMm}
              min={0.001}
              step="0.1"
              onCommit={(val) => onChange({ depthMm: val })}
              className="h-8 text-xs font-mono"
            />
          </div>

          {/* Area width & height */}
          <div className="flex gap-2">
            <div className="space-y-1 flex-1">
              <label className="text-[11px] font-medium text-[var(--fg-muted)]">Width (mm)</label>
              <DraftNumberInput
                value={draft.areaMm[0]}
                min={0.001}
                max={maxW}
                step="0.1"
                onCommit={(val) => onChange({ areaMm: [val, draft.areaMm[1]] })}
                className="h-8 text-xs font-mono"
              />
            </div>
            <div className="space-y-1 flex-1">
              <label className="text-[11px] font-medium text-[var(--fg-muted)]">Height (mm)</label>
              <DraftNumberInput
                value={draft.areaMm[1]}
                min={0.001}
                max={maxH}
                step="0.1"
                onCommit={(val) => onChange({ areaMm: [draft.areaMm[0], val] })}
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>

          {/* Rotation */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">Rotation (°)</label>
            <DraftNumberInput
              value={draft.rotationDeg}
              step="1"
              onCommit={(val) => onChange({ rotationDeg: val })}
              className="h-8 text-xs font-mono"
            />
          </div>

          {/* Features count */}
          <div className="pt-1">
            <div className="text-xs text-[var(--fg-muted)]">
              Features: {textureFeatureCount(draft)} of 400
            </div>
          </div>
        </>
      )}

      {/* Material settings */}
      {isMaterial && (
        <>
          {/* Material preset */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">Material</label>
            <ToggleGroup
              type="single"
              value={draft.material}
              onValueChange={(val) => {
                if (!val) return;
                const mat = val as MaterialId;
                onChange({
                  material: mat,
                  color: MATERIAL_PRESETS[mat].defaultColor,
                });
              }}
              className="w-full flex-wrap justify-start"
            >
              <ToggleGroupItem value="brushed-metal" className="text-xs">
                Brushed metal
              </ToggleGroupItem>
              <ToggleGroupItem value="matte-plastic" className="text-xs">
                Matte plastic
              </ToggleGroupItem>
              <ToggleGroupItem value="wood" className="text-xs">
                Wood
              </ToggleGroupItem>
              <ToggleGroupItem value="color" className="text-xs">
                Color
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {/* Color */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">Color</label>
            <div className="flex items-center gap-2">
              <Input
                type="color"
                value={draft.color}
                onChange={(e) => {
                  const val = e.target.value;
                  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                    onChange({ color: val.toLowerCase() });
                  }
                }}
                className="h-8 w-14 p-1 cursor-pointer bg-transparent"
              />
              <DraftHexInput
                value={draft.color}
                onCommit={(val) => onChange({ color: val })}
                className="h-8 flex-1 text-xs font-mono"
              />
            </div>
          </div>

          {/* Target */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--fg-muted)]">Target</label>
            <ToggleGroup
              type="single"
              value={draft.target === 'model' || !hasPart ? 'model' : 'part'}
              onValueChange={(val) => {
                if (!val) return;
                if (val === 'model') {
                  onChange({ target: 'model' });
                } else if (hasPart && partVar) {
                  onChange({ target: partVar });
                }
              }}
              className="w-full justify-start"
            >
              <ToggleGroupItem value="part" disabled={!hasPart} className="flex-1 text-xs">
                This part
              </ToggleGroupItem>
              <ToggleGroupItem value="model" className="flex-1 text-xs">
                Whole model
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </>
      )}
    </div>
  );
}
