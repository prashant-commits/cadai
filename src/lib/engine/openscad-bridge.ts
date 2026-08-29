import { parseStlToGeometry } from './geometry-utils';
import { CompileResult } from '@/types';

/**
 * Compiles OpenSCAD code and returns Three.js BufferGeometry + ModelInfo.
 * Uses the fast, reliable server compiler endpoint with client-side fallback.
 */
export async function compileOpenScad(code: string): Promise<CompileResult> {
  const startTime = performance.now();

  if (!code || code.trim().length === 0) {
    return {
      success: false,
      error: 'Empty OpenSCAD code provided.',
    };
  }

  try {
    // 1. Call server compilation endpoint
    const response = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    const data = await response.json();

    if (!response.ok || !data.success || !data.stl) {
      return {
        success: false,
        error: data.error || `Compilation failed with status ${response.status}`,
        compileTimeMs: Math.round(performance.now() - startTime),
      };
    }

    const { geometry, modelInfo } = parseStlToGeometry(data.stl);

    return {
      success: true,
      stlContent: data.stl,
      geometry,
      modelInfo,
      compileTimeMs: Math.round(performance.now() - startTime),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
      compileTimeMs: Math.round(performance.now() - startTime),
    };
  }
}
