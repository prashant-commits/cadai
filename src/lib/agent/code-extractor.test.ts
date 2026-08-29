import { describe, it, expect } from 'vitest';
import { extractOpenScadCode } from './code-extractor';

describe('extractOpenScadCode', () => {
  it('extracts code from ```openscad code block', () => {
    const text = `
Here is your phone stand:
\`\`\`openscad
width = 60;
cube([width, 40, 10]);
\`\`\`
Hope you like it!
`;
    const code = extractOpenScadCode(text);
    expect(code).toBe('width = 60;\ncube([width, 40, 10]);');
  });

  it('extracts code from generic code block with OpenSCAD primitives', () => {
    const text = `
\`\`\`
difference() {
  cube([20, 20, 20], center=true);
  cylinder(r=5, h=30, center=true);
}
\`\`\`
`;
    const code = extractOpenScadCode(text);
    expect(code).toContain('difference()');
    expect(code).toContain('cylinder(');
  });

  it('returns null for text without code blocks', () => {
    const text = 'Hello, I can design 3D parts for you.';
    expect(extractOpenScadCode(text)).toBeNull();
  });
});
