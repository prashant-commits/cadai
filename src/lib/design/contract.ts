import { ScadParam, StandingConstraints, DesignContract, ContractDiff, ModelInfo } from '../../types';
import { SpecViolation } from '../agent/spec-audit';
import { setParamValue } from './write-params';
import { parseParams } from './parse-params';

function getMinWall(s: StandingConstraints | undefined): number | undefined {
  if (!s) return undefined;
  return s.minWallMm ?? (s.nozzleMm ? s.nozzleMm * 4 : undefined);
}

function isWallParam(name: string): boolean {
  const n = name.toLowerCase();
  return (n.includes('wall') || n.includes('shell') || n.includes('perimeter')) && 
         !n.includes('diffuser') && !n.includes('panel');
}

export function checkStanding(params: ScadParam[], info: ModelInfo | null, s: StandingConstraints): SpecViolation[] {
  const violations: SpecViolation[] = [];

  if (s.buildVolumeMm && info?.dimensions) {
    if (info.dimensions.x > s.buildVolumeMm[0] ||
        info.dimensions.y > s.buildVolumeMm[1] ||
        info.dimensions.z > s.buildVolumeMm[2]) {
      violations.push({
        kind: 'buildplate',
        field: 'dimensions',
        expected: `${s.buildVolumeMm[0]}x${s.buildVolumeMm[1]}x${s.buildVolumeMm[2]}`,
        measured: `${info.dimensions.x.toFixed(1)}x${info.dimensions.y.toFixed(1)}x${info.dimensions.z.toFixed(1)}`,
        severity: 'error',
        message: 'Part exceeds printer build volume.'
      });
    }
  }

  const minWall = getMinWall(s);
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
            message: `Value ${p.value} is below minimum wall thickness ${minWall}mm (nozzle ${s.nozzleMm ?? 'unknown'}mm).`
          });
        }
      }
    }
  }

  // analyzeStl already measures this on every compile (geometry-utils.ts) and
  // nothing ever read it. Warning severity, not error: an overhang is a
  // printability concern the user can answer with supports or a re-orientation,
  // not wrong geometry - and only `error` violations drive the repair loop.
  if (s.maxOverhangDeg !== undefined && info?.overhang) {
    const measured = info.overhang.maxOverhangDeg;
    if (measured > s.maxOverhangDeg) {
      violations.push({
        kind: 'buildplate',
        field: 'maxOverhangDeg',
        expected: s.maxOverhangDeg,
        measured,
        severity: 'warning',
        message:
          `Steepest overhang is ${measured}° from vertical, past the ${s.maxOverhangDeg}° support-free limit` +
          `${info.overhang.unsupportedAreaMm2 ? ` (${info.overhang.unsupportedAreaMm2.toFixed(1)}mm² unsupported)` : ''}. ` +
          'Re-orient the part on the build plate or add supports.',
      });
    }
  }

  if (s.layerHeightMm && s.nozzleMm) {
    if (s.layerHeightMm > s.nozzleMm * 0.8) {
      violations.push({
        kind: 'standing',
        field: 'layerHeightMm',
        expected: s.nozzleMm * 0.8,
        measured: s.layerHeightMm,
        severity: 'warning',
        message: `Layer height ${s.layerHeightMm} exceeds 80% of nozzle diameter (${s.nozzleMm}).`
      });
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
  const minWall = getMinWall(s);

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
          reason: `Value is below minimum wall thickness ${minWall}mm (nozzle ${s.nozzleMm ?? 'unknown'}mm).`
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
