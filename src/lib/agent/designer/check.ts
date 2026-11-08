import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { AgentStateType } from './state';
import { runBrep, type BrepResult } from '../../engine/brep-runner';
import { checkPythonScript, type BodyCheck } from '../../brep/body-check';
import { stlToAscii, toModelInfo } from '../../brep/measurements';

export interface DesignerCheckDeps {
  runBrep?: typeof runBrep;
  checkPythonScript?: typeof checkPythonScript;
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
    let r: BrepResult | null = null;

    if (!script || script.trim() === '') {
      didNotCompile = true;
      compileError = 'no script was produced';
      failures.push('The script did not compile: no script was produced');
    } else {
      const guard: BodyCheck = scriptChecker(script);
      if (!guard.ok) {
        didNotCompile = true;
        compileError = guard.reason;
        failures.push(`Script guardrail failure: ${guard.reason}`);
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
          failures.push(`The script did not compile: ${compileError}`);
        } else {
          // Compiled ok! Now check validity, disconnected, interference:
          const parts = r.parts ?? [];
          if (parts.length === 0) {
            failures.push('no parts produced in _cadai_parts');
          } else {
            const invalidParts = parts.filter((p) => !p.valid);
            if (invalidParts.length > 0) {
              failures.push(
                `invalid part${invalidParts.length > 1 ? 's' : ''}: ${invalidParts.map((p) => p.label || 'unnamed').join(', ')}`
              );
            }
          }

          if (Array.isArray(r.disconnected) && r.disconnected.length > 0) {
            failures.push(`disconnected parts: ${r.disconnected.join(', ')}`);
          }

          const clashes = (r.interferences ?? []).filter((i) =>
            typeof i.volume === 'number' ? i.volume > 1.0 : true
          );
          if (clashes.length > 0) {
            failures.push(
              `interferences in closed pose: ${clashes.map((c) => `${c.a} collides with ${c.b} (${c.volume.toFixed(1)} mm³)`).join(', ')}`
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

      return {
        isValid: true,
        stlContent: hasMesh ? ascii : null,
        stepContent: r.step ?? null,
        modelInfo: modelInfo ?? state.modelInfo,
        acceptedDesignerScript: script,
        currentCode: script,
        failureKind: 'none',
        designerCheckFailures: null,
        designerCheckCompleted: true,
      };
    }

    // Failed checks!
    const failuresText = failures.join('; ');

    if (retryCount === 0) {
      // First failure: route back to designerNode ONCE as an edit
      return {
        isValid: false,
        designerRetryCount: 1,
        designerCheckFailures: failuresText,
        designerCheckCompleted: false,
        failureKind: didNotCompile ? 'compile' : 'semantic',
      };
    }

    // Still fails after retry (retryCount >= 1):
    // Honest message: "Built, but failed checks: …". Say "did not compile" ONLY when it did not compile.
    const honestMessage = didNotCompile
      ? `The script did not compile: ${compileError}`
      : `Built, but failed checks: ${failuresText}`;

    const ascii = r?.stl ? stlToAscii(r.stl) : '';
    const hasMesh = ascii.includes('facet normal');
    const modelInfo = hasMesh && r ? toModelInfo(r, ascii) : null;

    return {
      isValid: false,
      designerRetryCount: retryCount + 1,
      designerCheckFailures: honestMessage,
      designerCheckCompleted: true,
      explanation: honestMessage,
      stlContent: hasMesh ? ascii : null,
      stepContent: r?.step ?? null,
      modelInfo: modelInfo ?? state.modelInfo,
      failureKind: didNotCompile ? 'compile' : 'semantic',
    };
  };
}

export const designerCheck = createDesignerCheck();
