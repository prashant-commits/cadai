import { describe, it, expect } from 'vitest';
import { parseParams } from './parse-params';
import { DEFAULT_CODE } from '../storage/thread-storage';
import { checkPythonScript } from '@/lib/brep/body-check';

describe('parseParams', () => {
  it('parses DEFAULT_CODE correctly', () => {
    const params = parseParams(DEFAULT_CODE);
    expect(params).toHaveLength(5);
    expect(params.map(p => p.name)).toEqual([
      'width', 'depth', 'height', 'corner_radius', 'hole_radius'
    ]);
    expect(params[0]).toMatchObject({
      name: 'width',
      value: 40,
      min: 20,
      max: 80,
    });
    expect(params[1]).toMatchObject({
      name: 'depth',
      value: 40,
      min: 20,
      max: 80,
    });
    expect(params[2]).toMatchObject({
      name: 'height',
      value: 25,
      min: 10,
      max: 60,
    });
    expect(params[3]).toMatchObject({
      name: 'corner_radius',
      value: 5,
      min: 1,
      max: 8,
    });
    expect(params[4]).toMatchObject({
      name: 'hole_radius',
      value: 8,
      min: 3,
      max: 15,
    });
  });

  it('validates that checkPythonScript(DEFAULT_CODE).ok is true', () => {
    expect(checkPythonScript(DEFAULT_CODE).ok).toBe(true);
  });

  it('parses build123d script without from build123d import line', () => {
    const code = 'radius = 12  # [5:25] Radius\n';
    const params = parseParams(code);
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      name: 'radius',
      value: 12,
      min: 5,
      max: 25,
      label: 'Radius',
    });
  });

  it('parses stepped range in build123d comments', () => {
    const code = 'w = 40  # [20:0.2:80] Width';
    const params = parseParams(code);
    expect(params[0].step).toBe(0.2);
    expect(params[0].min).toBe(20);
    expect(params[0].max).toBe(80);
  });

  it('handles negative numbers and floats in build123d', () => {
    const code = 'offset = -5  # [-10:10]\nz = 0.5  # [0.1:0.9]';
    const params = parseParams(code);
    expect(params[0].value).toBe(-5);
    expect(params[0].min).toBe(-10);
    expect(params[0].max).toBe(10);
    expect(params[1].value).toBe(0.5);
    expect(params[1].min).toBe(0.1);
    expect(params[1].max).toBe(0.9);
  });
});
