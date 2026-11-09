import { Annotation } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { DesignContract, ModelInfo } from '@/types/designer';
import type { RunOutcome } from '@/lib/persist/types';
import type { DesignerFacts, ReviewFlag } from './types';

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  designContract: Annotation<DesignContract | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  currentCode: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  explanation: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  modelInfo: Annotation<ModelInfo | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  isValid: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => false,
  }),
  stlContent: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  stepContent: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  attemptCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  maxAttempts: Annotation<number>({
    reducer: (_, y) => y,
    default: () => Number(process.env.CADAI_MAX_ATTEMPTS ?? 1),
  }),
  failureKind: Annotation<'none'|'no_code'|'truncated'|'compile'|'semantic'|'interference'>({
    reducer: (_, y) => y,
    default: () => 'none',
  }),
  pipeline: Annotation<'designer' | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  kernel: Annotation<'brep' | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  designerFacts: Annotation<DesignerFacts | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  designerFlags: Annotation<Array<ReviewFlag & { round: number; final: boolean }>>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  designerCostUsd: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  designerRetryCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  designerCheckFailures: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  designerCheckCompleted: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => false,
  }),
  designerSummary: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  designerTurns: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  baseVersion: Annotation<number | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  baseBody: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  baseRequest: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  baseEdits: Annotation<string[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  attachments: Annotation<Array<{ mediaType: 'image/png'; base64: string; kind?: 'markup' | 'reference' }>>({
    reducer: (_, y) => y,
    default: () => [],
  }),
  outcome: Annotation<RunOutcome | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  triageKind: Annotation<'edit' | 'new' | 'question' | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  startedAt: Annotation<number | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  designerCheckSentences: Annotation<string[]>({
    reducer: (_, y) => y,
    default: () => [],
  }),
});

export type AgentStateType = typeof AgentState.State;
