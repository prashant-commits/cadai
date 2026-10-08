import { AssemblySpec } from '../agent/assembly-spec';

export interface MatingCut {
  host: string;
  inserted: string;
  clearance: number;
}

/**
 * For every jointContract with clearance > 0 that names both partA and partB,
 * partA is the host (it receives the cut) and partB is the inserted part.
 * Edge case: A part that is both host and inserted in different joints is cut only as a host.
 */
export function matingCuts(spec: AssemblySpec): MatingCut[] {
  if (!spec.jointContracts) return [];
  const cuts: MatingCut[] = [];
  const insertedSet = new Set<string>();

  for (const jc of spec.jointContracts) {
    if (jc.clearance > 0 && jc.partA && jc.partB) {
      insertedSet.add(jc.partB);
    }
  }

  for (const jc of spec.jointContracts) {
    if (jc.clearance > 0 && jc.partA && jc.partB) {
      // "A part that is both host and inserted in different joints is cut only as a host."
      // I interpret this as: if a part is a host in ANY joint, it does not act as an inserted part (does not cut other hosts).
      // Let's find out if partB is a host in any joint.
      const partBIsHost = spec.jointContracts.some(other => other.partA === jc.partB && other.clearance > 0 && other.partB);
      if (partBIsHost) {
        continue;
      }
      cuts.push({ host: jc.partA, inserted: jc.partB, clearance: jc.clearance });
    }
  }
  return cuts;
}
