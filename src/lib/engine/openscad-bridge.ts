import { parseStlToGeometry } from './geometry-utils';
import { CompileResult } from '@/types';
import { detectLanguage } from '@/lib/brep/language';

/**
 * Compiles CAD code (OpenSCAD or build123d) and returns Three.js BufferGeometry + ModelInfo.
 * Uses the server compiler endpoint (/api/compile).
 */
let compileTimeout: ReturnType<typeof setTimeout> | null = null;
let currentCompileId = 0;
let activeAbortController: AbortController | null = null;

export function compileModel(code: string, language?: 'openscad' | 'build123d'): Promise<CompileResult> {
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
        return resolve({ success: false, error: 'Empty CAD code provided.' });
      }

      const lang = language || detectLanguage(code);

      try {
        const response = await fetch('/api/compile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, language: lang }),
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
            language: lang,
          });
        }

        const { geometry, modelInfo } = parseStlToGeometry(data.stl);

        resolve({
          success: true,
          stlContent: data.stl,
          geometry,
          modelInfo,
          step: data.step,
          language: data.language || lang,
          compileTimeMs: typeof data.compileTimeMs === 'number' ? data.compileTimeMs : Math.round(performance.now() - startTime),
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
          language: lang,
        });
      }
    }, 250);
  });
}

export const compileOpenScad = compileModel;
