import type { AssemblySpec } from './assembly-spec';
import type { SpecViolation } from './spec-audit';
import type { ModelInfo } from '@/types';
import type { ChosenApproach } from '../research/design-brief';

export interface RunSummaryInput {
  spec: AssemblySpec | null;
  modelInfo: ModelInfo | null;
  violations: SpecViolation[];
  /** Total draft+repair passes. 1 means the first draft compiled. */
  attempts: number;
  isValid: boolean;
  approach?: ChosenApproach;
}

/**
 * The assistant message body for a finished run.
 *
 * Deliberately deterministic and compact: this string becomes
 * ChatMessage.content, which is the only field replayed to the model on the
 * next turn. The model's own prose and the generated code are NOT here - the
 * prose streams into the transcript, and the code lives in the editor and
 * behind the message's own code disclosure.
 */
export function composeRunSummary(input: RunSummaryInput): string {
  const { spec, modelInfo, violations, attempts, isValid, approach } = input;
  const lines: string[] = [];

  // ChosenApproach wraps the Approach ({ partClass, approach, chosenAt }), so
  // the human-readable name is one level in.
  if (approach?.approach?.name) lines.push(`Approach: ${approach.approach.name}.`);

  if (!isValid) {
    lines.push(
      spec?.assemblyName
        ? `**${spec.assemblyName}** did not compile to a valid model after ${attempts} attempt${attempts === 1 ? '' : 's'}.`
        : 'No valid model could be produced for this request.'
    );
  } else {
    const name = spec?.assemblyName ?? 'the model';
    const d = modelInfo?.dimensions;
    lines.push(
      d
        ? `Built **${name}**, measuring ${d.x} x ${d.y} x ${d.z} mm.`
        : `Built **${name}**.`
    );
    if (spec?.components?.length) {
      lines.push(`${spec.components.length} component${spec.components.length === 1 ? '' : 's'}: ${spec.components.map((c) => c.name).join(', ')}.`);
    }
    if (attempts > 1) {
      lines.push(`Took ${attempts - 1} repair pass${attempts - 1 === 1 ? '' : 'es'} after the first draft.`);
    }
  }

  if (violations.length) {
    lines.push(`\n${violations.length} finding${violations.length === 1 ? '' : 's'} waived:`);
    for (const v of violations) lines.push(`- [${v.kind}] ${v.message}`);
  }

  // Never empty: an empty assistant bubble is a bug the user should see as
  // text, not as a blank. The old code papered over this with a literal
  // "Model generation completed." fallback on the client.
  return lines.length ? lines.join('\n') : 'The run finished without producing a summary.';
}
