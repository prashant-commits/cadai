import { describe, it, expect } from 'vitest';
import { presetCameraPosition } from './view-presets';
import { buildCompileMarkers } from '@/components/editor/code-editor-panel';
import { scriptLineToBodyLine, withGeneratedPrelude } from '@/lib/brep/prelude';

describe('viewport camera presets and error markers', () => {
  it('view presets place the camera on the expected axis', () => {
    // top -> +Y in Three.js world frame
    const topPos = presetCameraPosition('top', [0, 5, 0], 100);
    expect(topPos).toEqual([0, 105, 0]);

    // front -> +Z
    const frontPos = presetCameraPosition('front', [0, 0, 0], 100);
    expect(frontPos).toEqual([0, 0, 100]);

    // right -> +X
    const rightPos = presetCameraPosition('right', [0, 0, 0], 100);
    expect(rightPos).toEqual([100, 0, 0]);

    // iso -> normalized (+1, +1, +1)
    const isoPos = presetCameraPosition('iso', [0, 0, 0], 100);
    expect(isoPos[0]).toBeGreaterThan(0);
    expect(isoPos[0]).toBeCloseTo(isoPos[1], 5);
    expect(isoPos[1]).toBeCloseTo(isoPos[2], 5);
    const length = Math.hypot(isoPos[0], isoPos[1], isoPos[2]);
    expect(length).toBeCloseTo(100, 5);

    // iso with non-zero target
    const target: [number, number, number] = [10, 20, 30];
    const isoWithTarget = presetCameraPosition('iso', target, 100);
    const dx = isoWithTarget[0] - target[0];
    const dy = isoWithTarget[1] - target[1];
    const dz = isoWithTarget[2] - target[2];
    expect(dx).toBeCloseTo(dy, 5);
    expect(dy).toBeCloseTo(dz, 5);
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(100, 5);
  });

  it('a compile error sets a Monaco marker on the error line', () => {
    const errorText = `Traceback (most recent call last):
  File "<string>", line 42, in <module>
ValueError: Box dimensions must be positive`;

    // Pure marker builder
    const markers = buildCompileMarkers(errorText, 3, 10);
    expect(markers).toEqual([
      {
        startLineNumber: 3,
        endLineNumber: 3,
        startColumn: 1,
        endColumn: 1000,
        message: 'ValueError: Box dimensions must be positive',
        severity: 'error',
      },
    ]);

    // Returns empty when no error or line
    expect(buildCompileMarkers(null, 3, 10)).toEqual([]);
    expect(buildCompileMarkers(errorText, null, 10)).toEqual([]);
    expect(buildCompileMarkers('', 3, 10)).toEqual([]);

    // Line clamped to lineCount
    const clamped = buildCompileMarkers(errorText, 50, 10);
    expect(clamped[0].startLineNumber).toBe(10);
    expect(clamped[0].endLineNumber).toBe(10);

    // Maps script line through scriptLineToBodyLine on withGeneratedPrelude(body)
    const body = 'box = Box(10, 10, 10)\nerror_here = Cylinder(-5, 20)\nresult = box';
    const script = withGeneratedPrelude(body);
    const scriptLines = script.split('\n');
    const scriptLineIdx = scriptLines.findIndex((l) => l.includes('error_here = Cylinder(-5, 20)'));
    expect(scriptLineIdx).toBeGreaterThan(0);
    const scriptLine = scriptLineIdx + 1;

    const mappedBodyLine = scriptLineToBodyLine(scriptLine, script);
    expect(mappedBodyLine).toBe(2);

    const bodyLineCount = body.split('\n').length;
    const mappedMarkers = buildCompileMarkers(
      'ValueError: Radius must be positive',
      mappedBodyLine,
      bodyLineCount
    );
    expect(mappedMarkers).toHaveLength(1);
    expect(mappedMarkers[0].startLineNumber).toBe(2);
    expect(mappedMarkers[0].message).toBe('ValueError: Radius must be positive');
  });
});
