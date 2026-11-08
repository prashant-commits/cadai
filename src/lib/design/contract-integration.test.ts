import { describe, it, expect } from 'vitest';
import { parseParams } from './parse-params';
import { setParamValue } from './write-params';
import { DEFAULT_CODE } from '../storage/thread-storage';

describe('Design Contract Integration', () => {
  it('updates parameter values in build123d code', () => {
    // 1. Parse params
    const params = parseParams(DEFAULT_CODE);
    const widthParam = params.find(p => p.name === 'width');
    expect(widthParam).toBeDefined();
    expect(widthParam?.value).toBe(40);

    // 2. Set param value
    const updatedCode = setParamValue(DEFAULT_CODE, 'width', 55);

    // 3. Verify parse on updated code reflects new value
    const updatedParams = parseParams(updatedCode);
    const updatedWidth = updatedParams.find(p => p.name === 'width');
    expect(updatedWidth?.value).toBe(55);
    expect(updatedCode).toContain('width = 55');
  });
});
