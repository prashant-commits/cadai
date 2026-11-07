import * as fs from 'node:fs';
import type { AgentStateType } from '@/lib/agent/graph';

/**
 * Writes a run's final script and assembly spec beside its results file:
 * `<base>-<id>.py|.scad` and `<base>-<id>.spec.json`, so a failing run can be
 * diagnosed, and rescored, without a re-run. Returns the paths written.
 */
export function saveRunArtifacts(
  jsonl: string,
  id: string,
  kernel: 'openscad' | 'brep' | undefined,
  state: Partial<Pick<AgentStateType, 'currentCode' | 'assemblySpec'>>,
): string[] {
  const base = jsonl.replace(/\.jsonl$/, `-${id}`);
  const written: string[] = [];
  if (state.currentCode) {
    const file = `${base}.${kernel === 'brep' ? 'py' : 'scad'}`;
    fs.writeFileSync(file, state.currentCode);
    written.push(file);
  }
  if (state.assemblySpec) {
    const file = `${base}.spec.json`;
    fs.writeFileSync(file, JSON.stringify(state.assemblySpec, null, 2));
    written.push(file);
  }
  return written;
}
