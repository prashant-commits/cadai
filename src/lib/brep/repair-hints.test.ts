import { describe, expect, it } from 'vitest';
import { REPAIR_HINTS, repairHint } from './repair-hints';

import { EXTRUDE_FORMS } from './extrude-forms';
import { BUILDER_MODE_REASON } from './body-check';
import { BREP_BUILD_PREAMBLE } from '../agent/system-prompt';

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

  it('keys a keyword hint on the failing call, not on the keyword alone', () => {
    expect(repairHint("TypeError: Text.__init__() got an unexpected keyword argument 'height'")).toBe('Text has no keyword height=; use only the keywords on the cheat sheet.');
    expect(repairHint("TypeError: Box.__init__() got an unexpected keyword argument 'axis'")).not.toContain('rotation=');
    expect(repairHint("TypeError: Cylinder.__init__() got an unexpected keyword argument 'height'")).toContain('positional');
    expect(repairHint("TypeError: extrude() got an unexpected keyword argument 'height'")).toContain('amount=');
  });

  it('matches only the exception line, never echoed source', () => {
    const echoed = [
      'Traceback (most recent call last):',
      '  File "model.py", line 4, in plate',
      "    # A face or sketch must be provided, NameError: name 'x' is not defined",
      '    result = Box(1, 1, 1)',
      'RuntimeError: something else',
    ].join('\n');
    expect(repairHint(echoed)).toBeNull();
    expect(repairHint("    x = 'ValueError: A face or sketch must be provided'\nRuntimeError: odd")).toBeNull();
    // The real exception line still matches when source is echoed above it.
    expect(repairHint('  # note\n    extrude(amount=3)\nValueError: A face or sketch must be provided')).toContain('extrude(Plane.YZ');
  });

  it('keeps the table small', () => {
    expect(REPAIR_HINTS.length).toBeLessThanOrEqual(3);
  });
});

describe('the extrude forms are worded once', () => {
  it('the prompt, the rejection reason and the repair hint all carry the shared text', () => {
    expect(BREP_BUILD_PREAMBLE).toContain(EXTRUDE_FORMS);
    expect(BUILDER_MODE_REASON).toContain(EXTRUDE_FORMS);
    expect(repairHint('ValueError: A face or sketch must be provided')).toContain(EXTRUDE_FORMS);
  });

  it('says which plane picks the direction and that the bare face extrudes along +Z', () => {
    expect(EXTRUDE_FORMS).toContain('Plane.XY, Plane.YZ or Plane.XZ * Polygon(...) chooses the sketch plane and the extrusion direction');
    expect(EXTRUDE_FORMS).toContain('lies in XY and extrudes along +Z');
    expect(EXTRUDE_FORMS).toContain('Plane.YZ * make_face(Polyline(*pts, close=True))');
    expect(EXTRUDE_FORMS).toContain('extrude(Plane.YZ * Polygon(*pts, align=None), amount=w)');
    expect(EXTRUDE_FORMS).toContain('extrude(make_face(Polyline(*pts, close=True)), amount=w)');
  });
});
