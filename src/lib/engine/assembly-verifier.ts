import { compileScad } from './scad-compiler';
import { analyzeStl } from './geometry-utils';

export interface InterferenceResult {
  hasInterference: boolean;
  intersectionVolumeMm3?: number;
  intersectionTriangleCount?: number;
  /** Bounding box of the overlapping material, when there is any. */
  intersectionSizeMm?: [number, number, number];
  error?: string;
}

/**
 * Checks for physical interference (collision) between two parts in an assembly
 * by compiling intersection(){A(); B();} and measuring the result.
 *
 * OpenSCAD reports a genuinely empty intersection as exit code 1 with
 * "Current top level object is empty" - that is the SUCCESS case for a
 * clearance fit, not a compile failure, and must not be conflated with one.
 *
 * @param code The shared OpenSCAD code containing module definitions.
 * @param callA The instantiation code for part A (e.g., 'translate([0,0,0]) moduleA();')
 * @param callB The instantiation code for part B (e.g., 'translate([10,0,0]) moduleB();')
 */
export async function checkInterference(
  code: string,
  callA: string,
  callB: string
): Promise<InterferenceResult> {
  const testCode = `
// Original Assembly Code (Modules)
${code}

// Interference Test Probe
intersection() {
  ${callA}
  ${callB}
}
`;

  try {
    const result = await compileScad(testCode);

    // Empty intersection: the parts clear each other.
    const isEmpty = result.errors.some((e) => e.code === 'empty_object');
    if (isEmpty) {
      return {
        hasInterference: false,
        intersectionVolumeMm3: 0,
        intersectionTriangleCount: 0,
      };
    }

    if (!result.valid) {
      return {
        hasInterference: false, // Indeterminate
        error: `Compilation failed during interference check: ${result.error || 'Unknown error'}`,
      };
    }

    if (!result.stl || !result.stl.includes('facet normal')) {
      return {
        hasInterference: false,
        intersectionVolumeMm3: 0,
        intersectionTriangleCount: 0,
      };
    }

    const info = analyzeStl(result.stl);

    // Solid overlap is what matters. Faces that merely touch produce facets with
    // ~zero enclosed volume, and a flush contact is a valid fit, not a collision.
    const hasInterference = info.volumeMm3 > 1e-3;

    return {
      hasInterference,
      intersectionVolumeMm3: info.volumeMm3,
      intersectionTriangleCount: info.triangleCount,
      intersectionSizeMm: [info.dimensions.x, info.dimensions.y, info.dimensions.z],
    };
  } catch (e: any) {
    return {
      hasInterference: false,
      error: `Exception during interference check: ${e?.message ?? String(e)}`,
    };
  }
}
