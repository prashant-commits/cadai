import { describe, it, expect } from 'vitest';
import { HOLE_PRESETS, renderHoleOp } from './op-hole';
import type { FacePlane, ToolOp } from './ops';

const defaultPlane: FacePlane = {
  origin: [0, 0, 10],
  normal: [0, 0, 1],
  xDir: [1, 0, 0],
};

describe('hole presets and rendering', () => {
  it('M5 counterbore uses Ø10.0 × 5.4', () => {
    const op: ToolOp = {
      id: 'op_h00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'counterbore',
      depthMm: 12.0,
    };
    const block = renderHoleOp(op);
    expect(block).toContain('op_h00001_diameter = 5.5');
    expect(block).toContain('op_h00001_cb_diameter = 10.0');
    expect(block).toContain('op_h00001_cb_depth = 5.4');
  });

  it('presets table matches ISO standards for M3, M4, M5, M6, M8', () => {
    expect(HOLE_PRESETS.M3).toEqual({
      clearanceMm: 3.4,
      counterboreDiaMm: 6.5,
      counterboreDepthMm: 3.4,
      countersinkDiaMm: 6.3,
    });
    expect(HOLE_PRESETS.M4).toEqual({
      clearanceMm: 4.5,
      counterboreDiaMm: 8.0,
      counterboreDepthMm: 4.4,
      countersinkDiaMm: 8.4,
    });
    expect(HOLE_PRESETS.M5).toEqual({
      clearanceMm: 5.5,
      counterboreDiaMm: 10.0,
      counterboreDepthMm: 5.4,
      countersinkDiaMm: 10.4,
    });
    expect(HOLE_PRESETS.M6).toEqual({
      clearanceMm: 6.6,
      counterboreDiaMm: 11.0,
      counterboreDepthMm: 6.4,
      countersinkDiaMm: 12.6,
    });
    expect(HOLE_PRESETS.M8).toEqual({
      clearanceMm: 9.0,
      counterboreDiaMm: 14.5,
      counterboreDepthMm: 8.4,
      countersinkDiaMm: 17.3,
    });
  });
});
