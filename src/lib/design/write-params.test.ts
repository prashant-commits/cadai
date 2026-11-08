import { describe, it, expect } from 'vitest';
import { setParamValue } from './write-params';
import { parseParams } from './parse-params';

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
});
