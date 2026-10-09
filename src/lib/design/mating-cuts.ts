import { AssemblySpec } from '../agent/assembly-spec';

export interface MatingCut {
  host: string;
  inserted: string;
  clearance: number;
}

/**
 * Determines mating cuts for clearance joints.
 *
 * For each jointContract with clearance > 0 naming distinct partA and partB,
 * partA is the host (it receives the cut) and partB is the inserted part.
 *
 * A part is cut as a host for each part inserted into it, and its own grown
 * skeleton is subtracted from each host it is inserted into; the two roles
 * are independent.
 *
 * True mutual cycles (where partA hosts partB and partB hosts partA) are
 * skipped, with an optional callback to record a report note.
 */
export function matingCuts(
  spec: AssemblySpec,
  onCycle?: (partA: string, partB: string) => void
): MatingCut[] {
  if (!spec.jointContracts) return [];
  const cuts: MatingCut[] = [];

  const candidateJoints = spec.jointContracts.filter(
    (jc) => jc.clearance > 0 && jc.partA && jc.partB && jc.partA !== jc.partB
  );

  const cyclePairs = new Set<string>();
  const reportedPairs = new Set<string>();

  for (const jc of candidateJoints) {
    const hasReverse = candidateJoints.some(
      (other) => other.partA === jc.partB && other.partB === jc.partA
    );
    if (hasReverse && jc.partA && jc.partB) {
      cyclePairs.add(`${jc.partA}:${jc.partB}`);
      const pairKey = [jc.partA, jc.partB].sort().join(':');
      if (!reportedPairs.has(pairKey)) {
        reportedPairs.add(pairKey);
        onCycle?.(jc.partA, jc.partB);
      }
    }
  }

  for (const jc of candidateJoints) {
    if (cyclePairs.has(`${jc.partA}:${jc.partB}`)) {
      continue;
    }
    cuts.push({ host: jc.partA!, inserted: jc.partB!, clearance: jc.clearance });
  }

  return cuts;
}
