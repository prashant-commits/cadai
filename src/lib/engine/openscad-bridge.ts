import { parseStlToGeometry } from './geometry-utils';
import { CompileResult } from '@/types';

/**
 * Compiles OpenSCAD code and returns Three.js BufferGeometry + ModelInfo.
 * Uses the fast, reliable server compiler endpoint with client-side fallback.
 */
let compileTimeout: ReturnType<typeof setTimeout> | null = null;
let currentCompileId = 0;
let activeAbortController: AbortController | null = null;

export function compileOpenScad(code: string): Promise<CompileResult> {
  return new Promise((resolve) => {
    if (compileTimeout) clearTimeout(compileTimeout);
    
    currentCompileId++;
    const requestId = currentCompileId;

    compileTimeout = setTimeout(async () => {
      if (requestId !== currentCompileId) {
        // Discard gracefully; another request is pending
        return resolve({ success: false, error: 'aborted', aborted: true });
      }

      if (activeAbortController) {
        activeAbortController.abort();
      }
      
      activeAbortController = new AbortController();
      const signal = activeAbortController.signal;
      const startTime = performance.now();

      if (!code || code.trim().length === 0) {
        return resolve({ success: false, error: 'Empty OpenSCAD code provided.' });
      }

      try {
        const response = await fetch('/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
          signal,
        });

        const data = await response.json();

        if (requestId !== currentCompileId) {
          return resolve({ success: false, error: 'aborted', aborted: true });
        }

        if (!response.ok || !data.success || !data.stl) {
          return resolve({
            success: false,
            error: data.error || `Compilation failed with status ${response.status}`,
            compileTimeMs: Math.round(performance.now() - startTime),
          });
        }

        const { geometry, modelInfo } = parseStlToGeometry(data.stl);

        resolve({
          success: true,
          stlContent: data.stl,
          geometry,
          modelInfo,
          compileTimeMs: Math.round(performance.now() - startTime),
        });
      } catch (err: unknown) {
        if (requestId !== currentCompileId || (err instanceof Error && err.name === 'AbortError')) {
          return resolve({ success: false, error: 'aborted', aborted: true });
        }
        const message = err instanceof Error ? err.message : String(err);
        resolve({
          success: false,
          error: message,
          compileTimeMs: Math.round(performance.now() - startTime),
        });
      }
    }, 250);
  });
}
