import { describe, it, expect } from 'vitest';
import { parseParams } from './parse-params';
import { setParamValue } from './write-params';
import { DEFAULT_OPENSCAD_CODE } from '../storage/thread-storage';
import { compileScad } from '../engine/scad-compiler';

describe('Design Contract Integration', () => {
  it('closes the loop from parsing to compiling', async () => {
    // 1. Parse params
    const params = parseParams(DEFAULT_OPENSCAD_CODE);
    const widthParam = params.find(p => p.name === 'width');
    expect(widthParam).toBeDefined();
    
    // 2. Set param value
    const updatedCode = setParamValue(DEFAULT_OPENSCAD_CODE, 'width', 55);
    
    // 3. Compile the updated code
    const result = await compileScad(updatedCode);
    
    // 4. Assert the bounding box actually changed
    expect(result.valid).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.summary!.dimensions).toBe(3);
    
    // The width should be 55. The bounding box max x - min x might be slightly different if it's not centered, 
    // but looking at DEFAULT_OPENSCAD_CODE:
    // translate([-(w/2-r), -(d/2-r), 0]) ...
    // The box is centered at 0,0,0 and spans width w.
    // So the bounding box size in X should be exactly 55.
    const sizeX = result.summary!.boundingBox!.max[0] - result.summary!.boundingBox!.min[0];
    
    // Using toBeCloseTo because of float math in bounding boxes
    expect(sizeX).toBeCloseTo(55, 1);
  });
});
