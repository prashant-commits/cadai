import { compileScad } from './scad-compiler';
import { stripTopLevelGeometry } from '../design/compose-assembly';
import type { Vec3 } from '../design/placement-geometry';

export interface ModuleFrame {
  name: string;
  /** False when the module compiled to nothing (empty, 2D, or errored). */
  valid: boolean;
  min: Vec3;
  max: Vec3;
  size: Vec3;
  error?: string;
}

const ZERO: Vec3 = [0, 0, 0];

/**
 * Compiles each named module ALONE and reads OpenSCAD's own bounding box for
 * it. This is what makes the "origin at the min corner" contract measurable
 * instead of hoped for: the min corner is the correction the composer applies,
 * and the size is what the extents audit compares to the spec.
 *
 * One wasm compile per module (about a second each), run sequentially so a
 * ten-part assembly does not spawn ten wasm instances at once.
 */
export async function measureModuleFrames(code: string, moduleNames: string[]): Promise<ModuleFrame[]> {
  if (moduleNames.length === 0) return [];
  const modules = stripTopLevelGeometry(code).code;
  const frames: ModuleFrame[] = [];

  for (const name of moduleNames) {
    const result = await compileScad(`${modules}\n${name}();\n`);
    const bb = result.summary?.boundingBox;
    const usable =
      result.valid && !!bb && [...bb.min, ...bb.max].every((n) => Number.isFinite(n));
    if (!usable || !bb) {
      frames.push({
        name,
        valid: false,
        min: ZERO,
        max: ZERO,
        size: ZERO,
        error: result.error ?? 'module produced no measurable 3D geometry',
      });
      continue;
    }
    const round = (n: number) => Math.round(n * 1000) / 1000;
    frames.push({
      name,
      valid: true,
      min: bb.min.map(round) as Vec3,
      max: bb.max.map(round) as Vec3,
      size: bb.size.map(round) as Vec3,
    });
  }
  return frames;
}
