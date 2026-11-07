import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The verified build123d cheat sheet, read once at module load (server only).
 * It has no import lines: the prompt and the sheet say the same thing, that
 * build123d and the math names are already in scope. CI runs every example in
 * the same namespace the geometry runner gives a script (geo/tests/test_cheatsheet.py).
 */
export const BREP_CHEATSHEET: string = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'brep', 'cheatsheet.md'),
  'utf-8',
).trim();
