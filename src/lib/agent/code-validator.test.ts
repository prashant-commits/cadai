import { describe, it, expect } from 'vitest';
import { checkSyntaxBalance, validateOpenScadCode } from './code-validator';

describe('checkSyntaxBalance', () => {
  it('passes on balanced OpenSCAD code', () => {
    const code = `
      module box() {
        difference() {
          cube([10, 20, 30]);
          cylinder(r=2, h=35);
        }
      }
    `;
    const res = checkSyntaxBalance(code);
    expect(res.valid).toBe(true);
  });

  it('fails on unclosed brace', () => {
    const code = `
      module box() {
        cube([10, 20, 30]);
    `;
    const res = checkSyntaxBalance(code);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Unclosed');
  });

  it('fails on unmatched bracket', () => {
    const code = `
      cube([10, 20, 30);
    `;
    const res = checkSyntaxBalance(code);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Unmatched');
  });
});

describe('validateOpenScadCode', () => {
  it('validates a correct OpenSCAD script with WASM', async () => {
    const code = 'cube([15, 15, 15], center=true);';
    const res = await validateOpenScadCode(code);
    expect(res.valid).toBe(true);
    expect(res.stl).toBeDefined();
    expect(res.stl).toContain('facet normal');
  });
});
