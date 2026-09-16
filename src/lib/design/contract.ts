import { ScadParam, StandingConstraints, DesignContract, ContractDiff, ModelInfo } from '../../types';
import { SpecViolation } from '../agent/spec-audit';
import { setParamValue } from './write-params';
import { parseParams } from './parse-params';

function isWallParam(name: string): boolean {
  const n = name.toLowerCase();
  return (n.includes('wall') || n.includes('shell') || n.includes('perimeter')) &&
         !n.includes('diffuser') && !n.includes('panel');
}

/**
 * Checks the code and the compiled model against the user's standing bounds.
 *
 * These are geometric limits only. The overhang, layer-height and nozzle
 * checks that used to live here were fabrication-process rules: they measured
 * a finished model against printing assumptions, and their messages ("re-orient
 * the part", "add supports") reached the repair node and invited it to reshape
 * geometry that was correct. Printability is a separate, opt-in analysis;
 * analyzeStl still measures overhang for it.
 */
export function checkStanding(params: ScadParam[], info: ModelInfo | null, s: StandingConstraints): SpecViolation[] {
  const violations: SpecViolation[] = [];

  if (s.maxSizeMm && info?.dimensions) {
    if (info.dimensions.x > s.maxSizeMm[0] ||
        info.dimensions.y > s.maxSizeMm[1] ||
        info.dimensions.z > s.maxSizeMm[2]) {
      violations.push({
        kind: 'buildplate',
        field: 'dimensions',
        expected: `${s.maxSizeMm[0]}x${s.maxSizeMm[1]}x${s.maxSizeMm[2]}`,
        measured: `${info.dimensions.x.toFixed(1)}x${info.dimensions.y.toFixed(1)}x${info.dimensions.z.toFixed(1)}`,
        severity: 'error',
        message: `Assembly is larger than the maximum size of ${s.maxSizeMm.join(' x ')}mm. Reduce its dimensions.`
      });
    }
  }

  const minWall = s.minWallMm;
  if (minWall !== undefined) {
    for (const p of params) {
      if (isWallParam(p.name) && typeof p.value === 'number') {
        if (p.value < minWall) {
          violations.push({
            kind: 'standing',
            field: p.name,
            expected: minWall,
            measured: p.value,
            severity: 'error',
            message: `Value ${p.value} is below the minimum wall thickness of ${minWall}mm.`
          });
        }
      }
    }
  }

  return violations;
}

export function applyContract(newCode: string, contract: DesignContract): { code: string; diff: ContractDiff } {
  let code = newCode;
  const currentParams = parseParams(newCode);
  
  const diff: ContractDiff = {
    applied: [],
    dropped: [],
    unchanged: [],
    rejected: []
  };
  
  if (!contract.pinnedParams) return { code, diff };

  const s = contract.standing || {};
  const minWall = s.minWallMm;

  for (const [name, pin] of Object.entries(contract.pinnedParams)) {
    const aiParam = currentParams.find(p => p.name === name);
    if (!aiParam) {
      diff.dropped.push(name);
      continue;
    }

    let rejected = false;
    if (minWall !== undefined && typeof pin.value === 'number' && isWallParam(name)) {
      if (pin.value < minWall) {
        diff.rejected.push({
          name,
          value: pin.value,
          reason: `Value is below the minimum wall thickness of ${minWall}mm.`
        });
        rejected = true;
      }
    }

    if (rejected) {
      continue;
    }

    if (aiParam.value === pin.value) {
      diff.unchanged.push(name);
      continue;
    }
    
    code = setParamValue(code, name, pin.value);
    diff.applied.push({ name, pinned: pin.value, aiValue: aiParam.value });
  }

  return { code, diff };
}
