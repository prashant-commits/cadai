import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { AgentStateType } from './state';
import { runBrep, type BrepResult } from '../../engine/brep-runner';
import { checkPythonScript, type BodyCheck } from '../../brep/body-check';
import { stlToAscii, toModelInfo } from '../../brep/measurements';
import { COMPILE_FAILED, FAILED_CHECKS, NO_CHANGE } from '../../persist/phrases';
import type { RunOutcome, UserKind } from '../../persist/types';
import { toBody, PRELUDE_VERSION } from '../../brep/prelude';
import { formatFlags } from './reviewer';
import type { ReviewFlag } from './types';
import { firstHumanText, latestHumanText } from './message-utils';

export function codeLabel(s: unknown): string {
  const str = String(s ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F`]/g, '')
    .trim()
    .slice(0, 40);
  return `\`${str}\``;
}

export function buildOutcome(params: {
  state: AgentStateType;
  script: string;
  hasMesh: boolean;
  stlAscii?: string;
  stepBase64?: string;
  failedChecks?: boolean;
  sentences?: string[];
  formatFlagsFn?: (flags: ReviewFlag[], final: boolean) => string;
}): RunOutcome {
  const { state, script, hasMesh, stlAscii, stepBase64, failedChecks, sentences } = params;
  const flagFormatter = params.formatFlagsFn ?? formatFlags;
  const isEdit = state.triageKind === 'edit';
  const userKind: UserKind = isEdit ? 'edit' : 'request';
  const startedAt = state.startedAt ?? Date.now();
  const wallMs = Date.now() - startedAt;
  const costUsd = state.designerCostUsd ?? 0;
  const turns = state.designerTurns ?? 0;
  const messages = state.messages ?? [];
  const latestText = latestHumanText(messages);
  const firstText = firstHumanText(messages) || latestText;

  // Unchanged body check for edit
  if (isEdit && !failedChecks) {
    const newBody = toBody(script).trim();
    const baseBody = toBody(state.baseBody ?? '').trim();
    if (newBody === baseBody) {
      return {
        replyKind: 'nochange',
        replyMarkdown: NO_CHANGE,
        userKind: 'edit',
        costUsd,
        wallMs,
        turns,
      };
    }
  }

  const finalFlags = (state.designerFlags ?? []).filter((f) => f.final);
  const reviewerText = finalFlags.length > 0 ? flagFormatter(finalFlags, true) : '';

  if (failedChecks) {
    let replyMarkdown = `${FAILED_CHECKS}\n${(sentences ?? []).join('\n')}`;
    if (state.designerSummary) {
      replyMarkdown += `\n\n**Designer**\n\n${state.designerSummary}`;
    }
    if (reviewerText) {
      replyMarkdown += `\n\n**Reviewer**\n\n${reviewerText}`;
    }

    if (!hasMesh) {
      return {
        replyKind: 'error',
        replyMarkdown,
        userKind,
        costUsd,
        wallMs,
        turns,
      };
    }

    const baseRequest = isEdit ? (state.baseRequest ?? firstText) : latestText;
    const edits = isEdit ? [latestText] : [];

    return {
      replyKind: 'error',
      replyMarkdown,
      userKind,
      design: {
        parentVersion: isEdit ? state.baseVersion : null,
        origin: 'designer',
        baseRequest,
        edits,
        body: toBody(script),
        preludeVersion: PRELUDE_VERSION,
        summary: state.designerSummary || '',
        facts: state.designerFacts ?? null,
        flags: ['failed_checks'],
        stl: stlAscii,
        step: stepBase64,
      },
      costUsd,
      wallMs,
      turns,
    };
  }

  // Normal result
  let replyMarkdown = `**Designer**\n\n${state.designerSummary || ''}`;
  if (reviewerText) {
    replyMarkdown += `\n\n**Reviewer**\n\n${reviewerText}`;
  }

  const baseRequest = isEdit ? (state.baseRequest ?? firstText) : latestText;
  const edits = isEdit ? [latestText] : [];

  return {
    replyKind: 'result',
    replyMarkdown,
    userKind,
    design: {
      parentVersion: isEdit ? state.baseVersion : null,
      origin: 'designer',
      baseRequest,
      edits,
      body: toBody(script),
      preludeVersion: PRELUDE_VERSION,
      summary: state.designerSummary || '',
      facts: state.designerFacts ?? null,
      flags: [],
      stl: hasMesh ? stlAscii : undefined,
      step: stepBase64,
    },
    costUsd,
    wallMs,
    turns,
  };
}

export interface DesignerCheckDeps {
  runBrep?: typeof runBrep;
  checkPythonScript?: typeof checkPythonScript;
  formatFlags?: (flags: ReviewFlag[], final: boolean) => string;
}

export function createDesignerCheck(deps: DesignerCheckDeps = {}) {
  const runner = deps.runBrep ?? runBrep;
  const scriptChecker = deps.checkPythonScript ?? checkPythonScript;

  return async function designerCheck(
    state: AgentStateType,
    config?: LangGraphRunnableConfig
  ): Promise<Partial<AgentStateType>> {
    if (config?.signal?.aborted) {
      throw Object.assign(new Error('The run was stopped before check started.'), {
        name: 'AbortError',
      });
    }

    const script = state.currentCode;
    const retryCount = state.designerRetryCount ?? 0;

    let didNotCompile = false;
    let compileError = '';
    const failures: string[] = [];
    const sentences: string[] = [];
    let r: BrepResult | null = null;

    if (!script || script.trim() === '') {
      didNotCompile = true;
      compileError = 'no script was produced';
      console.warn('Script compilation failed: no script was produced');
      failures.push('The script did not compile: no script was produced');
      sentences.push(`- ${COMPILE_FAILED}`);
    } else {
      const guard: BodyCheck = scriptChecker(script);
      if (!guard.ok) {
        didNotCompile = true;
        compileError = guard.reason;
        console.warn('Script guardrail failure:', guard.reason);
        failures.push(`Script guardrail failure: ${guard.reason}`);
        sentences.push(`- ${COMPILE_FAILED}`);
      } else {
        r = await runner(script, {
          signal: config?.signal,
          interferences: true,
          connectivity: true,
        });

        if (config?.signal?.aborted) {
          throw Object.assign(new Error('The run was stopped during geometry check.'), {
            name: 'AbortError',
          });
        }

        if (!r.ok) {
          didNotCompile = true;
          compileError = r.error ?? 'unknown compilation error';
          console.warn('Script compilation error:', r.error);
          failures.push(`The script did not compile: ${compileError}`);
          sentences.push(`- ${COMPILE_FAILED}`);
        } else {
          // Compiled ok! Now check validity, disconnected, interference:
          const parts = r.parts ?? [];
          if (parts.length === 0) {
            failures.push('no parts produced in _cadai_parts');
            sentences.push('- No parts were produced in _cadai_parts.');
          } else {
            const invalidParts = parts.filter((p) => !p.valid);
            if (invalidParts.length > 0) {
              const partWord = invalidParts.length > 1 ? 'parts' : 'part';
              failures.push(
                `invalid ${partWord}: ${invalidParts.map((p) => p.label || 'unnamed').join(', ')}`
              );
              sentences.push(
                `- Invalid ${partWord}: ${invalidParts.map((p) => codeLabel(p.label || 'unnamed')).join(', ')}.`
              );
            }
          }

          if (Array.isArray(r.disconnected) && r.disconnected.length > 0) {
            const partWord = r.disconnected.length > 1 ? 'parts' : 'part';
            failures.push(`disconnected parts: ${r.disconnected.join(', ')}`);
            sentences.push(`- Disconnected ${partWord}: ${r.disconnected.map(codeLabel).join(', ')}.`);
          }

          const clashes = (r.interferences ?? []).filter((i) =>
            typeof i.volume === 'number' ? i.volume > 1.0 : true
          );
          if (clashes.length > 0) {
            failures.push(
              `interferences in closed pose: ${clashes.map((c) => `${c.a} collides with ${c.b} (${c.volume.toFixed(1)} mm³)`).join(', ')}`
            );
            sentences.push(
              `- Interferences in closed pose: ${clashes.map((c) => `${codeLabel(c.a)} collides with ${codeLabel(c.b)} (${codeLabel(`${c.volume.toFixed(1)} mm³`)})`).join(', ')}.`
            );
          }
        }
      }
    }

    const passed = failures.length === 0;

    if (passed && r) {
      const ascii = r.stl ? stlToAscii(r.stl) : '';
      const hasMesh = ascii.includes('facet normal');
      const modelInfo = hasMesh ? toModelInfo(r, ascii) : null;

      const outcome = buildOutcome({
        state,
        script,
        hasMesh,
        stlAscii: hasMesh ? ascii : undefined,
        stepBase64: r.step ?? undefined,
        failedChecks: false,
        formatFlagsFn: deps.formatFlags,
      });

      return {
        isValid: true,
        stlContent: hasMesh ? ascii : null,
        stepContent: r.step ?? null,
        modelInfo: modelInfo ?? state.modelInfo,
        currentCode: script,
        failureKind: 'none',
        designerCheckFailures: null,
        designerCheckSentences: [],
        designerCheckCompleted: true,
        outcome,
      };
    }

    // Failed checks!
    const failuresText = failures.join('; ');

    if (retryCount === 0) {
      // First failure: route back to designerNode ONCE as an edit carrying the failures for the model
      return {
        isValid: false,
        designerRetryCount: 1,
        designerCheckFailures: failuresText,
        designerCheckSentences: sentences,
        designerCheckCompleted: false,
        failureKind: didNotCompile ? 'compile' : 'semantic',
      };
    }

    // Still fails after retry (retryCount >= 1):
    // No raw text in user-visible state: set explanation and designerCheckFailures to FAILED_CHECKS + sentences markdown (or COMPILE_FAILED)
    const userFacingFailures = didNotCompile
      ? COMPILE_FAILED
      : `${FAILED_CHECKS}\n${sentences.join('\n')}`;

    const ascii = r?.stl ? stlToAscii(r.stl) : '';
    const hasMesh = ascii.includes('facet normal');
    const modelInfo = hasMesh && r ? toModelInfo(r, ascii) : null;

    const outcome = buildOutcome({
      state,
      script,
      hasMesh,
      stlAscii: hasMesh ? ascii : undefined,
      stepBase64: r?.step ?? undefined,
      failedChecks: true,
      sentences,
      formatFlagsFn: deps.formatFlags,
    });

    return {
      isValid: false,
      designerRetryCount: retryCount + 1,
      designerCheckFailures: userFacingFailures,
      designerCheckSentences: sentences,
      designerCheckCompleted: true,
      explanation: userFacingFailures,
      stlContent: hasMesh ? ascii : null,
      stepContent: r?.step ?? null,
      modelInfo: modelInfo ?? state.modelInfo,
      failureKind: didNotCompile ? 'compile' : 'semantic',
      outcome,
    };
  };
}

export const designerCheck = createDesignerCheck();
