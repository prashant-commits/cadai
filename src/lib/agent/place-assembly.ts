import type { AssemblySpec } from './assembly-spec';
import { analyzeTopLevel, composeAssembly } from '../design/compose-assembly';
import type { PlacementReport } from '../design/placement-report';
import { measureModuleFrames, type ModuleFrame } from '../engine/module-frames';

/**
 * Measures each component module, then hands placement to deterministic code.
 * Every outcome except a clean compose leaves the model's script untouched.
 */
export async function placeAssembly(
  code: string,
  spec: AssemblySpec | null,
): Promise<{ code: string; report: PlacementReport | null; frames: ModuleFrame[] }> {
  if (!code || !spec?.components?.length) return { code, report: null, frames: [] };

  const defined = new Set(analyzeTopLevel(code).moduleNames);
  const names = spec.components.map((c) => c.name).filter((n) => defined.has(n));
  const frames = await measureModuleFrames(code, names);
  const result = composeAssembly(code, spec, frames);

  if (result.reason === 'missing_modules') {
    return { code: result.code, report: null, frames };
  }

  return { code: result.code, report: result.report, frames };
}
