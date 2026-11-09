import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOLS, getTool } from './tool-registry';
import {
  HoleSettings,
  holeSizePatch,
  switchTypePatch,
  HEADS_NEED_PRESET,
  maxCornerRadius,
  cutRectSizePatch,
  cutRectCornerRadiusPatch,
} from './hole-tool';
import { renderOpBlock, validateToolOp, parseOpBlocks, applyOp, type ToolOp, type FacePlane } from '@/lib/tools/ops';
import { withGeneratedPrelude } from '@/lib/brep/prelude';
import type { TopoFace } from '@/lib/geometry/topology';

const defaultPlane: FacePlane = {
  origin: [0, 0, 10],
  normal: [0, 0, 1],
  xDir: [1, 0, 0],
};

const fakeFace: TopoFace = {
  id: 1,
  part: 'lid',
  kind: 'plane',
  area: 1200,
  center: [0, 0, 10],
  normal: [0, 0, 1],
};

describe('hole tool', () => {
  it('the hole tool registers with opKinds hole and cut-rect', () => {
    expect(TOOLS.some((t) => t.id === 'hole')).toBe(true);
    const tool = getTool('hole');
    expect(tool).toBeDefined();
    expect(tool?.id).toBe('hole');
    expect(tool?.label).toBe('Hole');
    expect(tool?.needsFace).toBe(true);
    expect(tool?.modifies).toBe(true);
    expect(tool?.opKinds).toEqual(['hole', 'cut-rect']);
    expect(tool?.Settings).toBe(HoleSettings);

    const initial = tool?.initialDraft(fakeFace, defaultPlane);
    expect(initial).toEqual({
      kind: 'hole',
      id: 'op_hole_draft',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 'through',
    });
  });

  it('choosing M5 fills Ø5.5', () => {
    // Pure helper test
    const patch = holeSizePatch('M5');
    expect(patch).toEqual({ size: 'M5', diameterMm: 5.5 });

    // Render an M3 draft
    const m3Draft: ToolOp = {
      kind: 'hole',
      id: 'op_hole_test',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      size: 'M3',
      diameterMm: 3.4,
      head: 'none',
      depthMm: 'through',
    };
    const onChange = vi.fn();
    const htmlM3 = renderToStaticMarkup(<HoleSettings draft={m3Draft} onChange={onChange} />);
    expect(htmlM3).toContain('Ø3.4');

    // Render an M5 draft and assert markup shows Ø5.5
    const m5Draft: ToolOp = {
      ...m3Draft,
      ...patch,
    } as ToolOp;
    const htmlM5 = renderToStaticMarkup(<HoleSettings draft={m5Draft} onChange={onChange} />);
    expect(htmlM5).toContain('Ø5.5');
  });

  it('a counterbore shows its fixed Ø and depth', () => {
    const m5CbDraft: ToolOp = {
      kind: 'hole',
      id: 'op_hole_test',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      size: 'M5',
      diameterMm: 5.5,
      head: 'counterbore',
      depthMm: 'through',
    };
    const htmlM5 = renderToStaticMarkup(<HoleSettings draft={m5CbDraft} onChange={vi.fn()} />);
    expect(htmlM5).toContain('Ø10.0');
    expect(htmlM5).toContain('5.4');

    const m8CbDraft: ToolOp = {
      ...m5CbDraft,
      size: 'M8',
      diameterMm: 9.0,
      head: 'counterbore',
    };
    const htmlM8 = renderToStaticMarkup(<HoleSettings draft={m8CbDraft} onChange={vi.fn()} />);
    expect(htmlM8).toContain('Ø14.5');
    expect(htmlM8).toContain('8.4');
  });

  it('a custom size disables heads with the fixed phrase', () => {
    const customDraft: ToolOp = {
      kind: 'hole',
      id: 'op_hole_test',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      size: 'custom',
      diameterMm: 7.2,
      head: 'none',
      depthMm: 10,
    };
    const html = renderToStaticMarkup(<HoleSettings draft={customDraft} onChange={vi.fn()} />);
    expect(html).toContain('Heads need a preset size.');
    expect(html).toContain(HEADS_NEED_PRESET);
    // Counterbore and countersink buttons are disabled
    expect(html).toContain('disabled');

    // Choosing custom while a head is set sends head: 'none'
    const patch = holeSizePatch('custom', { head: 'counterbore' });
    expect(patch).toEqual({ size: 'custom', head: 'none' });
  });

  it('switching to a cut-out drops the hole fields from the block', () => {
    const holeDraft: ToolOp = {
      kind: 'hole',
      id: 'op_hole_123456',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      size: 'M5',
      diameterMm: 5.5,
      head: 'counterbore',
      depthMm: 10,
    };

    const typeSwitchPatch = switchTypePatch('cut-rect', holeDraft);
    expect(typeSwitchPatch).toEqual({
      kind: 'cut-rect',
      widthMm: 20,
      heightMm: 10,
      cornerRadiusMm: 0,
      depthMm: 10,
    });

    // Shallow merge like updateDraft does:
    const merged = { ...holeDraft, ...typeSwitchPatch } as unknown as ToolOp & {
      size?: string;
      head?: string;
      diameterMm?: number;
    };
    expect(merged.size).toBe('M5');
    expect(merged.head).toBe('counterbore');
    expect(merged.diameterMm).toBe(5.5);

    const block = renderOpBlock(merged);
    const markerMatch = block.match(/# cadai:op cut-rect id=op_hole_123456 (\{.*\})/);
    expect(markerMatch).not.toBeNull();

    const markerJson = markerMatch![1];
    const markerObj = JSON.parse(markerJson);
    expect(markerObj).not.toHaveProperty('size');
    expect(markerObj).not.toHaveProperty('head');
    expect(markerObj).not.toHaveProperty('diameterMm');

    expect(validateToolOp(markerObj)).toBe(true);

    const parsed = parseOpBlocks(block);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].op.kind).toBe('cut-rect');
    const parsedOp = parsed[0].op as ToolOp & {
      size?: string;
      head?: string;
      diameterMm?: number;
    };
    expect(parsedOp.size).toBeUndefined();
    expect(parsedOp.head).toBeUndefined();
    expect(parsedOp.diameterMm).toBeUndefined();
    if (parsed[0].op.kind === 'cut-rect') {
      expect(parsed[0].op.widthMm).toBe(20);
      expect(parsed[0].op.heightMm).toBe(10);
      expect(parsed[0].op.cornerRadiusMm).toBe(0);
      expect(parsed[0].op.depthMm).toBe(10);
    }
  });

  it('the kernel fixtures match renderOpBlock', () => {
    const PLATE_BODY = `plate = Box(40, 30, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate.label = "plate"
_cadai_parts = [plate]
result = Compound([plate])
`;

    const opThru: ToolOp = {
      id: 'op_hole_m5thru',
      part: 'plate',
      plane: { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 'through',
    };

    const opCbor: ToolOp = {
      id: 'op_hole_m5cbor',
      part: 'plate',
      plane: { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'counterbore',
      depthMm: 'through',
    };

    const thruFixturePath = path.resolve(__dirname, '../../../geo/tests/fixtures/hole_op_m5_through.py');
    const cborFixturePath = path.resolve(__dirname, '../../../geo/tests/fixtures/hole_op_m5_counterbore.py');

    const expectedThru = withGeneratedPrelude(applyOp(PLATE_BODY, opThru));
    const expectedCbor = withGeneratedPrelude(applyOp(PLATE_BODY, opCbor));

    const actualThru = fs.readFileSync(thruFixturePath, 'utf-8');
    const actualCbor = fs.readFileSync(cborFixturePath, 'utf-8');

    expect(actualThru).toBe(expectedThru);
    expect(actualCbor).toBe(expectedCbor);
  });

  it('the corner radius stays below half the smaller side', () => {
    expect(maxCornerRadius(20, 10)).toBe(4.9);
    expect(maxCornerRadius(0.1, 10)).toBe(0);

    const draft = {
      widthMm: 20,
      heightMm: 10,
      cornerRadiusMm: 4.5,
    };

    const patch = cutRectSizePatch(draft, { widthMm: 8 });
    expect(patch).toEqual({ widthMm: 8, cornerRadiusMm: 3.9 });

    const patchNoClamp = cutRectSizePatch(draft, { widthMm: 25 });
    expect(patchNoClamp).toEqual({ widthMm: 25 });

    const radiusPatch = cutRectCornerRadiusPatch({ widthMm: 20, heightMm: 10 }, 5);
    expect(radiusPatch).toEqual({ cornerRadiusMm: 4.9 });
  });
});
