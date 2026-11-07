import { describe, expect, it } from 'vitest';
import { REPAIR_HINTS, repairHint } from './repair-hints';

describe('repairHint', () => {
  it('maps the saved-run error to the algebra-mode extrude', () => {
    const hint = repairHint('Traceback (most recent call last):\n  ...\nValueError: A face or sketch must be provided');
    expect(hint).toContain('extrude(Plane.YZ * Polygon(*pts, align=None), amount=w)');
    expect(hint).toContain('make_face(Polyline(*pts, close=True))');
    expect(hint).toMatch(/never use with BuildPart/);
  });

  it('names the right spelling for an invented keyword', () => {
    expect(repairHint("TypeError: Cylinder.__init__() got an unexpected keyword argument 'axis'")).toContain('rotation=(0, 90, 0)');
    expect(repairHint("TypeError: extrude() got an unexpected keyword argument 'height'")).toContain('amount=');
    expect(repairHint("TypeError: Box.__init__() got an unexpected keyword argument 'wobble'")).toContain('no keyword wobble=');
  });

  it('names the undefined name', () => {
    expect(repairHint("NameError: name 'plate_w' is not defined")).toContain('plate_w is not defined');
  });

  it('adds nothing for an error it does not know', () => {
    expect(repairHint('RuntimeError: something else')).toBeNull();
    expect(repairHint('')).toBeNull();
  });

  it('keeps the table small', () => {
    expect(REPAIR_HINTS.length).toBeLessThanOrEqual(3);
  });
});
