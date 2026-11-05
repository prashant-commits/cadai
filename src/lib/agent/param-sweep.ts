import { parseParams } from '../design/parse-params';
import { setParamValue } from '../design/write-params';
import { stripGeneratedAssembly } from '../design/compose-assembly';
import { validateOpenScadCode } from './code-validator';
import { analyzeStl } from '../engine/geometry-utils';

export interface ParamSweepOpts {
  factor?: number;
  budgetMs: number;
}

export interface ParamSweepResult {
  dead: string[];
  failures: { name: string; reason: string }[];
  skipped: string[];
}

async function evaluateVariant(
  variantCode: string
): Promise<{ ok: true; stl: string } | { ok: false; reason: string }> {
  let valRes;
  try {
    valRes = await validateOpenScadCode(variantCode);
  } catch (err) {
    return {
      ok: false,
      reason: `Compilation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!valRes.valid || !valRes.stl) {
    return { ok: false, reason: valRes.error || 'Compilation failed' };
  }

  if (valRes.isManifold === false || valRes.warnings.some((w) => w.code === 'non_manifold')) {
    return { ok: false, reason: 'Variant geometry is non-manifold' };
  }

  const info = analyzeStl(valRes.stl);
  if (info.boundingBox.min[2] < -0.01) {
    return {
      ok: false,
      reason: `Variant goes below z = 0 (z = ${info.boundingBox.min[2]})`,
    };
  }

  return { ok: true, stl: valRes.stl };
}

/**
 * Sweeps design-panel numeric parameters by ±factor and tests if they alter geometry,
 * break compilation, produce non-manifold geometry, or go below z = 0.
 */
export async function sweepParameters(
  code: string,
  opts: ParamSweepOpts
): Promise<ParamSweepResult> {
  const dead: string[] = [];
  const failures: { name: string; reason: string }[] = [];
  const skipped: string[] = [];

  try {
    const startTime = Date.now();
    const factor = opts.factor ?? 0.2;
    const designCode = stripGeneratedAssembly(code);
    const params = parseParams(designCode).filter(
      (p) => typeof p.value === 'number' && !p.name.startsWith('$')
    );

    if (opts.budgetMs <= 0 || Date.now() - startTime >= opts.budgetMs) {
      return {
        dead: [],
        failures: [],
        skipped: params.map((p) => p.name),
      };
    }

    if (params.length === 0) {
      return { dead: [], failures: [], skipped: [] };
    }

    const tBase0 = Date.now();
    const baseValidation = await validateOpenScadCode(code);
    let lastCompileMs = Date.now() - tBase0;

    if (!baseValidation.valid || !baseValidation.stl) {
      return { dead: [], failures: [], skipped: [] };
    }

    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (Date.now() - startTime + lastCompileMs > opts.budgetMs) {
        skipped.push(...params.slice(i).map((rem) => rem.name));
        break;
      }

      const val = p.value as number;
      let v1: number;
      let v2: number;

      if (val === 0) {
        const m = Math.max(
          p.min !== undefined ? Math.abs(p.min) : 0,
          p.max !== undefined ? Math.abs(p.max) : 0,
          1
        );
        v1 = -factor * m;
        v2 = factor * m;
      } else {
        v1 = val * (1 - factor);
        v2 = val * (1 + factor);
      }

      if (p.step !== undefined && p.step > 0) {
        const step = p.step;
        let s1 = Math.round(v1 / step) * step;
        let s2 = Math.round(v2 / step) * step;
        if (s1 === val) {
          s1 = val - step;
        }
        if (s2 === val) {
          s2 = val + step;
        }
        v1 = s1;
        v2 = s2;
      }

      if (p.min !== undefined) {
        v1 = Math.max(p.min, v1);
        v2 = Math.max(p.min, v2);
      }
      if (p.max !== undefined) {
        v1 = Math.min(p.max, v1);
        v2 = Math.min(p.max, v2);
      }

      v1 = Number(v1.toFixed(6));
      v2 = Number(v2.toFixed(6));

      // Variant 1
      const codeV1 = setParamValue(code, p.name, v1);
      const t1 = Date.now();
      const res1 = await evaluateVariant(codeV1);
      lastCompileMs = Math.max(lastCompileMs, Date.now() - t1);
      if (!res1.ok) {
        failures.push({ name: p.name, reason: res1.reason });
        continue;
      }

      // Check budget before Variant 2
      if (Date.now() - startTime + lastCompileMs > opts.budgetMs) {
        skipped.push(...params.slice(i).map((rem) => rem.name));
        break;
      }

      // Variant 2
      const codeV2 = setParamValue(code, p.name, v2);
      const t2 = Date.now();
      const res2 = await evaluateVariant(codeV2);
      lastCompileMs = Math.max(lastCompileMs, Date.now() - t2);
      if (!res2.ok) {
        failures.push({ name: p.name, reason: res2.reason });
        continue;
      }

      // Both variants succeeded - check if geometry is dead
      if (
        res1.stl.trim() === baseValidation.stl.trim() &&
        res2.stl.trim() === baseValidation.stl.trim()
      ) {
        dead.push(p.name);
      }
    }

    return { dead, failures, skipped };
  } catch {
    return { dead, failures, skipped };
  }
}
