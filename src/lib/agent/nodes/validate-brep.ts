import { HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentStateType } from '../graph';
import { auditSpec, type SpecViolation } from '../spec-audit';
import { auditSpecCoherence } from '../spec-coherence';
import { auditSpecShapes } from '../spec-shape-audit';
import { auditPlacement } from '../placement-audit';
import type { AttemptRecord } from '../graph';
import type { ValidationResult } from '../../engine/scad-compiler';
import { runBrep } from '../../engine/brep-runner';
import { repairHint } from '../../brep/repair-hints';
import { isBuilderModeReason, checkPythonScript } from '../../brep/body-check';
import { localOriginViolations, stlToAscii, toModelInfo, toModuleFrames, toPlacementReport } from '../../brep/measurements';
import { auditNesting } from '../nesting-audit';
import { contentText } from '../message-text';

/**
 * validateBrep: run the emitted build123d script and audit what it measured.
 * The audits are the ones validateCode runs, fed from the B-rep result.
 * Skipped on this kernel: the OpenSCAD-only static guards, the solo-module
 * hole/interference probes, the parameter sweep and the literal lint.
 */
export async function validateBrep(state: AgentStateType, config?: RunnableConfig): Promise<Partial<AgentStateType>> {
  // brepBuild got a cut-off or refused reply and emitted nothing: a failed attempt, nothing to run.
  if (state.failureKind === 'truncated' || state.failureKind === 'no_code') {
    return {
      isValid: false,
      attemptHistory: [{
        n: state.attemptCount,
        phase: state.attemptCount === 1 ? 'draft' : 'repair',
        code: state.currentCode,
        exitCode: 1,
        errors: [],
        warnings: [],
        violations: [],
        diagnosis: state.failureKind,
      }],
    };
  }
  if (!state.currentCode) return { isValid: false, failureKind: 'no_code' };

  const isAgentMode = (state as { buildMode?: string }).buildMode === 'agent' || process.env.CADAI_BUILD_MODE === 'agent';
  const guard = checkPythonScript(state.currentCode);
  if (!guard.ok) {
    const failure: SpecViolation = {
      kind: 'compile',
      field: '',
      expected: 'script passes guardrails',
      measured: 'rejected',
      severity: 'error',
      message: `Script guardrail failure: ${guard.reason}`,
    };
    const attempt: AttemptRecord = {
      n: state.attemptCount,
      phase: state.attemptCount === 1 ? 'draft' : 'repair',
      code: state.currentCode,
      exitCode: 1,
      errors: [{ severity: 'error', message: guard.reason ?? 'guardrail failure', count: 1, raw: guard.reason ?? '' }],
      warnings: [],
      violations: [failure],
      diagnosis: 'guardrail',
    };
    return {
      isValid: false,
      stlContent: null,
      stepContent: null,
      specViolations: [failure],
      attemptHistory: [attempt],
      failureKind: 'compile',
      compileFailures: state.compileFailures + 1,
      messages: [new HumanMessage(`[Validation Report]\nValidation Result: Failed\nViolations:\n- ERROR [compile]: ${failure.message}\n`)],
    };
  }

  const spec = state.assemblySpec;
  // The run's stop signal reaches the geometry process: a stopped run kills it
  // instead of waiting out the runner's own timeout.
  const signal = config?.signal;
  const r = await runBrep(state.currentCode, {
    signal,
    ...(isAgentMode ? { connectivity: true } : {}),
  });
  if (signal?.aborted) {
    throw Object.assign(new Error('The run was stopped during the geometry run.'), { name: 'AbortError' });
  }

  if (!r.ok) {
    const tail = tracebackTail(r.error ?? 'the script failed');
    const names = (spec?.components ?? []).map((c) => c.name);
    const hint = repairHint(r.error ?? '');
    const failures: SpecViolation[] = r.invalid?.length
      // The kernel built a solid it will not export: one error per part it names, so the build step rewrites those parts.
      ? r.invalid.map((name) => ({
          kind: 'manifold',
          field: names.includes(name) ? name : '',
          expected: true,
          measured: false,
          severity: 'error' as const,
          message: `${name} belongs to a solid that is not valid (${tail}). Check for zero-thickness walls, cutters that stop inside the part, and parts that only graze each other: overlap them by a few tenths of a millimetre or leave a real gap.`,
        }))
      : [{
          kind: 'compile',
          field: componentAtLine(state.currentCode, r.line, names) || componentInTraceback(r.error ?? '', names),
          expected: 'script runs',
          measured: 'error',
          severity: 'error',
          message: `build123d script failed: ${tail}${hint ? `\nFix: ${hint}` : ''}`,
        }];
    const attempt: AttemptRecord = {
      n: state.attemptCount,
      phase: state.attemptCount === 1 ? 'draft' : 'repair',
      code: state.currentCode,
      exitCode: 1,
      errors: [{ severity: 'error', message: tail, count: 1, raw: tail }],
      warnings: [],
      violations: failures,
      diagnosis: 'TBD',
    };
    return {
      isValid: false,
      stlContent: null,
      stepContent: null,
      specViolations: failures,
      attemptHistory: [attempt],
      failureKind: 'compile',
      compileFailures: state.compileFailures + 1,
      messages: [new HumanMessage(`[Validation Report]\nValidation Result: Failed\nViolations:\n${failures.map((v) => `- ERROR [${v.kind}]: ${v.message}`).join('\n')}\n`)],
    };
  }

  const ascii = r.stl ? stlToAscii(r.stl) : '';
  const hasMesh = ascii.includes('facet normal');
  const modelInfo = hasMesh ? toModelInfo(r, ascii) : null;
  const validation: ValidationResult = {
    valid: true,
    stl: hasMesh ? ascii : undefined,
    exitCode: 0,
    errors: [],
    warnings: [],
    isManifold: modelInfo?.isManifold,
    shellCount: r.solids,
    compileTimeMs: r.ms,
    rawStderr: [],
  };

  const violations = auditSpec(spec, modelInfo, validation, undefined, undefined);
  if (!hasMesh) {
    violations.push({
      kind: 'empty',
      field: 'stl',
      expected: 'a mesh',
      measured: 'no facets',
      severity: 'error',
      message: 'The script ran but produced no 3D geometry. Check that object dimensions are non-zero.',
    });
  }
  violations.push(...auditSpecCoherence(spec));
  // What the build itself replaced or dropped, so the model and the user see it.
  for (const note of state.buildNotes ?? []) {
    violations.push({
      kind: 'build',
      field: note.name,
      expected: 'used as written',
      measured: note.reason,
      // A with-Build... body is a known mistake with a known fix: it is an error, so the build step
      // is sent back to that part with the message instead of keeping the blockout silently.
      severity: isBuilderModeReason(note.reason) ? 'error' : 'warning',
      message: `${note.name}: ${note.reason}`,
    });
  }
  // What the runner itself did (e.g. the STEP was written as separate solids): a note, never a reason to rebuild.
  for (const note of r.notes ?? []) {
    violations.push({ kind: 'build', field: '', expected: 'runner note', measured: note, severity: 'warning', message: note });
  }
  violations.push(...auditSpecShapes(spec));

  // Check that every spec component survives in _cadai_parts or is recorded as omitted
  if (state.currentCode.includes('_cadai_parts') || r.parts.length > 0) {
    const measuredLabels = new Set(r.parts.map((p) => p.label));
    const omittedNotes = new Map((state.buildNotes ?? []).filter((n) => n.name).map((n) => [n.name, n.reason]));
    for (const comp of spec?.components ?? []) {
      if (!measuredLabels.has(comp.name)) {
        if (omittedNotes.has(comp.name)) {
          // Already recorded in buildNotes as a warning/note
        } else {
          violations.push({
            kind: 'feature',
            field: comp.name,
            expected: 'present in _cadai_parts',
            measured: 'missing',
            severity: isAgentMode ? 'error' : 'warning',
            message: `Spec component '${comp.name}' is missing from _cadai_parts and was not omitted.`,
          });
        }
      }
    }
  }

  const frames = toModuleFrames(r);
  const localFrames = r.local ? toModuleFrames({ ...r, parts: r.local }) : undefined;
  const placementReport = spec ? toPlacementReport(spec, frames, localFrames) : null;
  if (spec && localFrames) violations.push(...localOriginViolations(spec, localFrames));

  const jointedNames = new Set(
    (spec?.jointContracts ?? []).flatMap((j) => [j.partA, j.partB]).filter((n): n is string => Boolean(n))
  );

  const placementViolations = auditPlacement(placementReport, r.bbox?.min ?? modelInfo?.boundingBox.min ?? null, spec);
  // Replace the floating warning for jointed parts with the connectivity check
  for (const pv of placementViolations) {
    if (pv.kind === 'floating' && jointedNames.has(pv.field)) {
      continue;
    }
    violations.push(pv);
  }

  // Nesting and fit sanity check
  const humanMessages = (state.messages ?? []).filter((m) => m._getType() === 'human');
  const userPrompt = humanMessages.length > 0 ? contentText(humanMessages[0]) : '';
  const nestingViolations = auditNesting(spec, r.parts, userPrompt);
  violations.push(...nestingViolations.map((v) => (isAgentMode ? v : { ...v, severity: 'warning' as const })));

  // Connectivity check: error unless parts are allowed islands (placed apart on purpose, e.g. print layout)
  const isPrintLayout = /print\s+.*beside|print.*layout|coasters|chess|loose|separate/i.test(userPrompt) || /print/i.test((spec as { assemblyMode?: string })?.assemblyMode ?? '');
  if (r.disconnected === 'not checked') {
    violations.push({
      kind: 'floating',
      field: '',
      expected: 'connectivity verified (<= 40 parts)',
      measured: 'not checked',
      severity: (!isAgentMode || isPrintLayout) ? 'warning' : 'error',
      message: 'Connectivity not checked: model has more than 40 parts (consolidate parts or split the request).',
    });
  } else if (Array.isArray(r.disconnected)) {
    for (const name of r.disconnected) {
      violations.push({
        kind: 'floating',
        field: name,
        expected: 'connected to assembly',
        measured: 'disconnected',
        severity: (!isAgentMode || isPrintLayout) ? 'warning' : 'error',
        message: `'${name}' is a disconnected part: it does not touch and is not within 0.5 mm of any other part in the closed pose.`,
      });
    }
  }

  for (const frame of frames) {
    if (frame.valid || !frame.name) continue;
    violations.push({
      kind: 'manifold',
      field: frame.name,
      expected: true,
      measured: false,
      severity: 'error',
      message: `${frame.name} is not a valid solid (the kernel rejected it or it has no volume). Check for zero-thickness walls and cutters that stop inside the part.`,
    });
  }

  const isSemanticValid = violations.every((v) => v.severity !== 'error');
  const isValid = isSemanticValid;

  const attempt: AttemptRecord = {
    n: state.attemptCount,
    phase: state.attemptCount === 1 ? 'draft' : 'repair',
    code: state.currentCode,
    exitCode: 0,
    errors: [],
    warnings: [],
    measured: modelInfo ? {
      dimensions: modelInfo.dimensions,
      volumeMm3: modelInfo.volumeMm3,
      isManifold: modelInfo.isManifold,
      shellCount: modelInfo.shellCount,
      bottomAreaMm2: modelInfo.bottomAreaMm2,
      isFlatPackable: modelInfo.isFlatPackable,
      overhang: modelInfo.overhang,
    } : undefined,
    violations,
    diagnosis: 'TBD',
  };

  let report = `Validation Result: ${isValid ? 'Success' : 'Failed'}\n`;
  if (violations.length > 0) {
    report += `Violations:\n${violations.map((v) => `- ${v.severity.toUpperCase()} [${v.kind}]: ${v.message}`).join('\n')}\n`;
  }

  return {
    isValid,
    stlContent: hasMesh ? ascii : null,
    stepContent: r.step ?? null,
    validation,
    modelInfo: modelInfo ?? state.modelInfo,
    specViolations: violations,
    placementReport,
    attemptHistory: [attempt],
    failureKind: !isSemanticValid ? 'semantic' : 'none',
    semanticFailures: !isSemanticValid ? state.semanticFailures + 1 : state.semanticFailures,
    messages: [new HumanMessage(`[Validation Report]\n${report}`)],
  };
}

/** The last lines of a traceback: what a builder needs to fix the script, without the noise. */
function tracebackTail(error: string): string {
  const lines = error.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  return lines.slice(-6).join('\n').slice(-800);
}

/** The component whose `def <name>` (or `in <name>` frame) the traceback names; the innermost wins. */
function componentInTraceback(error: string, names: string[]): string {
  let found = '';
  let at = -1;
  for (const name of names) {
    const re = new RegExp(`(?:\\bin ${name}(?:_part\\d*)?\\b|\\bdef ${name}(?:_part\\d*)?\\b)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(error)) !== null) {
      if (m.index > at) {
        at = m.index;
        found = name;
      }
    }
  }
  return found;
}

/**
 * The component whose code holds `line` of the emitted script: the `def` that
 * encloses it, or the `_p_<name>` / `_l_<name>` / `_cav_<name>` statement it is.
 * Empty when the line is in the prelude or no line was reported.
 */
export function componentAtLine(code: string | null | undefined, line: number | undefined, names: string[]): string {
  if (!code || !line || line < 1) return '';
  const lines = code.split('\n');
  if (line > lines.length) return '';
  const known = new Set(names);
  const fromFunction = (fn: string): string => {
    if (known.has(fn)) return fn;
    const m = /^(.*)_part\d*$/.exec(fn);
    return m && known.has(m[1]) ? m[1] : '';
  };
  const at = lines[line - 1];
  if (/^\S/.test(at)) {
    const stmt = /^(?:_(?:p|l|cav)_(\w+)|(\w+?)_pos_[xyz])\s*=/.exec(at);
    const name = stmt ? (stmt[1] ?? stmt[2]) : '';
    if (name && known.has(name)) return name;
    const def = /^def (\w+)\(\)/.exec(at);
    return def ? fromFunction(def[1]) : '';
  }
  for (let i = line - 1; i >= 0; i--) {
    const text = lines[i];
    if (text.trim() === '' || /^[ \t]/.test(text)) continue;
    const def = /^def (\w+)\(\)/.exec(text);
    return def ? fromFunction(def[1]) : '';
  }
  return '';
}
