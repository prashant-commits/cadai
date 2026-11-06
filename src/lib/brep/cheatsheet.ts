import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The verified build123d cheat sheet, read once at module load (server only). */
export const BREP_CHEATSHEET: string = readFileSync(
  path.join(process.cwd(), 'src', 'lib', 'brep', 'cheatsheet.md'),
  'utf-8',
).trim();
