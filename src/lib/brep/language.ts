export type CadLanguage = 'build123d' | 'openscad';

/**
 * Detects whether CAD code is build123d (Python) or OpenSCAD.
 * A line matching /^\s*from build123d import/ identifies build123d; defaults to OpenSCAD.
 */
export function detectLanguage(code?: string | null): CadLanguage {
  if (!code) return 'openscad';
  return /^\s*from build123d import/m.test(code) ? 'build123d' : 'openscad';
}
