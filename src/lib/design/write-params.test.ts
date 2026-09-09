import { describe, it, expect } from 'vitest';
import { setParamValue } from './write-params';
import { parseParams } from './parse-params';

describe('setParamValue', () => {
  it('round-trips the value correctly', () => {
    const code = `w = 40; // [20:80] Width in mm`;
    const updated = setParamValue(code, 'w', 55);
    const params = parseParams(updated);
    expect(params[0].value).toBe(55);
  });

  it('preserves every non-target byte exactly', () => {
    const code = `
// Some comment
w = 40; // [20:80] Width in mm

h = 20; // Height
`;
    const updated = setParamValue(code, 'w', 55);
    const lines = updated.split('\n');
    const originalLines = code.split('\n');
    
    expect(lines[0]).toBe(originalLines[0]);
    expect(lines[1]).toBe(originalLines[1]);
    expect(lines[2]).toBe('w = 55; // [20:80] Width in mm');
    expect(lines[3]).toBe(originalLines[3]);
    expect(lines[4]).toBe(originalLines[4]);
  });

  it('is a no-op for unknown params', () => {
    const code = `w = 40;`;
    const updated = setParamValue(code, 'x', 55);
    expect(updated).toBe(code);
  });

  it('writes booleans correctly', () => {
    const code = `flip = false;`;
    const updated = setParamValue(code, 'flip', true);
    expect(updated).toBe('flip = true;');
  });

  it('writes enums correctly', () => {
    const code = `n = 3; // [3,4,5]`;
    const updated = setParamValue(code, 'n', 4);
    expect(updated).toBe('n = 4; // [3,4,5]');
  });

  it('keeps trailing annotations intact without adding extra spaces', () => {
    const code = `wall_thickness = 2.4;// [1.2:5] Minimum wall thickness`;
    const updated = setParamValue(code, 'wall_thickness', 3);
    expect(updated).toBe(`wall_thickness = 3;// [1.2:5] Minimum wall thickness`);
  });

  it('writes $-prefixed params correctly', () => {
    const code = `$fn = 48; // Smooth`;
    const updated = setParamValue(code, '$fn', 64);
    expect(updated).toBe('$fn = 64; // Smooth');
  });
});
