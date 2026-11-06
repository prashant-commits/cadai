import { describe, expect, it } from 'vitest';
import { pyExpr } from './py-expr';

const lookup = (name: string) => ({ w: 'w', h: 'p_class', t: 't' })[name as 'w'];

describe('pyExpr', () => {
  it('re-prints with minimal parentheses and maps names', () => {
    expect(pyExpr('w/2 + t', lookup)).toBe('w / 2 + t');
    expect(pyExpr('(w + t) * 2', lookup)).toBe('(w + t) * 2');
    expect(pyExpr('w - (t - 1)', lookup)).toBe('w - (t - 1)');
    expect(pyExpr('-(w + 1)', lookup)).toBe('-(w + 1)');
    expect(pyExpr('h * 2', lookup)).toBe('p_class * 2');
  });
  it('maps functions; trig takes degrees through the script helpers', () => {
    expect(pyExpr('max(w, 3) + sqrt(t)', lookup)).toBe('max(w, 3) + sqrt(t)');
    expect(pyExpr('sin(30) * w', lookup)).toBe('_sind(30) * w');
  });
  it('treats a newline as whitespace and never copies it', () => {
    expect(pyExpr('w\n+ 1', lookup)).toBe('w + 1');
  });
  it.each([
    'w\nimport os\n#',
    'w; import os',
    '__import__("os")',
    'w ** 2',
    'w.real',
    'w if t else 1',
    'open(w)',
    'unknown_name + 1',
    'sin(1, 2)',
    'w +',
    'min()',
    '1 2',
    '"x"',
  ])('returns null for %j', (src) => {
    expect(pyExpr(src, lookup)).toBeNull();
  });
});
