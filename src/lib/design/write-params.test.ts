import { describe, it, expect } from 'vitest';
import { setParamValue, formatPin, applyPin, BadPinError } from './write-params';
import { parseParams } from './parse-params';
import { BAD_PIN } from '@/lib/persist/phrases';

describe('setParamValue', () => {
  it('round-trips the value correctly in build123d', () => {
    const code = `w = 40  # [20:80] Width in mm`;
    const updated = setParamValue(code, 'w', 55);
    const params = parseParams(updated);
    expect(params[0].value).toBe(55);
  });

  it('preserves every non-target byte exactly in build123d', () => {
    const code = `# Header comment
w = 40  # [20:80] Width in mm

h = 20  # Height
`;
    const updated = setParamValue(code, 'w', 55);
    const lines = updated.split('\n');
    const originalLines = code.split('\n');

    expect(lines[0]).toBe(originalLines[0]);
    expect(lines[1]).toBe('w = 55  # [20:80] Width in mm');
    expect(lines[2]).toBe(originalLines[2]);
    expect(lines[3]).toBe(originalLines[3]);
  });

  it('is a no-op for unknown params in build123d', () => {
    const code = `w = 40`;
    const updated = setParamValue(code, 'x', 55);
    expect(updated).toBe(code);
  });

  it('formatPin is fixed-point with at most 6 decimals', () => {
    expect(formatPin(55)).toBe('55');
    expect(formatPin(0.1 + 0.2)).toBe('0.3');
    expect(formatPin(1e-7)).toBe('0');
    expect(formatPin(1e6)).toBe('1000000');
    expect(formatPin(-2.5)).toBe('-2.5');
    expect(formatPin(123.4567891)).toBe('123.456789');
  });

  it('pins never write an exponent', () => {
    const values = [1e-7, 1.5e-6, 123456.7, 999999.9999999, -1e6, 1e6, 0.000001];
    const template = 'w = 40  # [0:10] W';
    const regex = /^w = -?\d+(\.\d{1,6})?  # \[0:10\] W$/;

    for (const v of values) {
      const res = applyPin(template, 'w', v);
      expect(res).toMatch(regex);
      expect(res.toLowerCase()).not.toContain('e');
      const parsed = parseParams(res);
      expect(parsed).toHaveLength(1);
      // For 1e-7 formatPin rounds to 0, which is within 1e-6
      expect(Math.abs(Number(parsed[0].value) - v)).toBeLessThanOrEqual(1e-6);
    }
  });

  it('pins: unknown name or 1e21 → BAD_PIN', () => {
    const body = 'w = 40  # [0:10] W';

    expect(() => applyPin(body, 'nope', 1)).toThrow(BadPinError);
    expect(() => applyPin(body, 'nope', 1)).toThrow(BAD_PIN);

    expect(() => applyPin(body, 'w', 1e21)).toThrow(BadPinError);
    expect(() => applyPin(body, 'w', 1e21)).toThrow(BAD_PIN);

    expect(() => applyPin(body, 'w', NaN)).toThrow(BadPinError);
    expect(() => applyPin(body, 'w', NaN)).toThrow(BAD_PIN);

    expect(() => applyPin(body, 'w', Infinity)).toThrow(BadPinError);
    expect(() => applyPin(body, 'w', Infinity)).toThrow(BAD_PIN);
  });

  it('setParamValue writes formatPin output', () => {
    expect(setParamValue('w = 40', 'w', 0.1 + 0.2)).toBe('w = 0.3');
  });
});
