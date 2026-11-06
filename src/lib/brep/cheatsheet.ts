import { readFileSync } from 'node:fs';
import path from 'node:path';

const RAW: string = readFileSync(path.join(process.cwd(), 'src', 'lib', 'brep', 'cheatsheet.md'), 'utf-8').trim();

const IN_SCOPE = `The script around your body already has these in scope, so never write an import line: everything from build123d, \`sqrt\`, \`radians\`, and \`sin\`, \`cos\`, \`tan\` taking DEGREES.`;

/**
 * The verified build123d cheat sheet, read once at module load (server only).
 * The file opens with an import block and tells the reader to import from
 * `math`; CI needs that to run its examples, but a body must not import, so the
 * prompt copy swaps that opening for what is already in scope.
 */
export const BREP_CHEATSHEET: string = RAW
  .replace(/```python\n(?:from build123d import \*|from math import [^\n]*|\n)+```\n+/, '')
  .replace(/build123d does not export `sin`[^\n]*\n/, `${IN_SCOPE}\n`);
