import { describe, it, expect } from 'vitest';
import { parseParams } from './parse-params';
import { DEFAULT_OPENSCAD_CODE } from '../storage/thread-storage';

describe('parseParams', () => {
  it('parses range', () => {
    const code = `w = 40; // [20:80] Width in mm`;
    const params = parseParams(code);
    expect(params).toHaveLength(1);
    expect(params[0]).toEqual({
      name: 'w',
      kind: 'range',
      value: 40,
      authoredValue: 40,
      group: 'Parameters',
      line: 1,
      label: 'Width in mm',
      min: 20,
      max: 80,
      step: 1
    });
  });

  it('parses stepped range', () => {
    const code = `w = 40; // [20:0.2:80] Width`;
    const params = parseParams(code);
    expect(params[0].step).toBe(0.2);
  });

  it('parses enum', () => {
    const code = `n = 3; // [3,4,5]`;
    const params = parseParams(code);
    expect(params[0].kind).toBe('enum');
    expect(params[0].options).toEqual([
      { value: 3, label: '3' },
      { value: 4, label: '4' },
      { value: 5, label: '5' }
    ]);
  });

  it('parses labeled enum', () => {
    const code = `n = 3; // [3:M3, 4:M4]`;
    const params = parseParams(code);
    expect(params[0].options).toEqual([
      { value: 3, label: 'M3' },
      { value: 4, label: 'M4' }
    ]);
  });

  it('parses number', () => {
    const code = `w = 40; // Width in mm`;
    const params = parseParams(code);
    expect(params[0].kind).toBe('number');
    expect(params[0].label).toBe('Width in mm');
  });

  it('parses boolean', () => {
    const code = `flip = true;`;
    const params = parseParams(code);
    expect(params[0].kind).toBe('boolean');
    expect(params[0].value).toBe(true);
  });

  it('handles negative numbers', () => {
    const code = `z = -5; // [-10:10]`;
    const params = parseParams(code);
    expect(params[0].value).toBe(-5);
    expect(params[0].min).toBe(-10);
    expect(params[0].max).toBe(10);
  });

  it('handles floats', () => {
    const code = `z = 0.5; // [0.1:0.9]`;
    const params = parseParams(code);
    expect(params[0].value).toBe(0.5);
    expect(params[0].min).toBe(0.1);
    expect(params[0].max).toBe(0.9);
  });

  it('handles // inside string literal', () => {
    const code = `text = "http://example.com";\nw = 40;`;
    const params = parseParams(code);
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('w');
  });

  it('handles no space before //', () => {
    const code = `wall_thickness = 2.4;// [1.2:5] Minimum wall thickness`;
    const params = parseParams(code);
    expect(params[0].name).toBe('wall_thickness');
    expect(params[0].value).toBe(2.4);
    expect(params[0].min).toBe(1.2);
    expect(params[0].max).toBe(5);
    expect(params[0].label).toBe('Minimum wall thickness');
  });

  it('handles CRLF', () => {
    const code = "w = 40;\r\nh = 20;\r\n";
    const params = parseParams(code);
    expect(params).toHaveLength(2);
  });

  it('overwrites duplicate names with last assignment', () => {
    const code = `w = 40;\nw = 50;`;
    const params = parseParams(code);
    expect(params).toHaveLength(1);
    expect(params[0].value).toBe(50);
    expect(params[0].line).toBe(2);
  });

  it('ignores assignments inside module body', () => {
    const code = `w = 40;\nmodule test() {\n  x = 10;\n}`;
    const params = parseParams(code);
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('w');
  });

  it('handles zero-param file', () => {
    const code = `module test() {}`;
    const params = parseParams(code);
    expect(params).toHaveLength(0);
  });
  
  it('groups under Advanced for $ prefixed vars', () => {
    const code = `$fn = 48;`;
    const params = parseParams(code);
    expect(params[0].group).toBe('Advanced');
  });

  it('parses DEFAULT_OPENSCAD_CODE correctly', () => {
    const params = parseParams(DEFAULT_OPENSCAD_CODE);
    expect(params).toHaveLength(7);
    const names = params.map(p => p.name);
    expect(names).toEqual([
      'width', 'depth', 'height', 'wall_thickness', 'corner_radius', 'hole_radius', '$fn'
    ]);
  });

  it('handles unbalanced braces inside strings and comments', () => {
    const code = `
// a stray } in comment
w = 40; // width
text = "some } string";
module test() {
  x = 10;
}
    `;
    const params = parseParams(code);
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe('w');
  });
});
