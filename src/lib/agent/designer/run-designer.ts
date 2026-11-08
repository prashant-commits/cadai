import { HumanMessage, ToolMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import { checkPythonScript } from '../../brep/body-check';
import { toBody, withGeneratedPrelude } from '../../brep/prelude';
import { runBrep, type BrepResult } from '../../engine/brep-runner';
import { unusableStop } from '../llm-schemas';
import { DEFAULT_MODEL, isOfferedModel } from '../models';
import { getChatModel, isAbortOrTimeout } from '../model-provider';
import { applyParameterOverrides, estimateCostUsd } from './cost-params';
import { cachedSystemMessage } from '../system-prompt';
import { buildFirstUserMessage, DESIGNER_SYSTEM_PROMPT } from './prompt';
import {
  applyRollingCacheBreakpoint,
  checkRun,
  designerTools,
  factsFromRun,
  findPoseParams,
  formatFactsTable,
  formatFlags,
  INTERFERENCE_MIN_VOLUME,
  renderPartViews,
  replyUsage,
  scriptBaseKey,
  toRenderImages,
} from './tools';
import type {
  DesignerDeps,
  DesignerEvent,
  DesignerFacts,
  DesignerInput,
  DesignerResult,
  RenderImage,
  ReviewFlag,
  RunDesignerFn,
} from './types';

export const MAX_TURNS = 18;
export const MAX_COST_USD = 1.5;
export const MAX_WALL_MS = 420_000;
/** One geometry run never waits longer than this (it is also clipped to the wall time left). */
export const RUN_TIMEOUT_MS = 120_000;
/** Blocking reviewer flags reject `finish` this many times per build; after that the finish is accepted. */
export const MAX_REVIEW_REJECTIONS = 2;

const EMPTY_FACTS: DesignerFacts = { ok: false, parts: [], interferences: [], disconnected: [], dimensions: [] };
const POSE_TOLERANCE = 0.1;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const runDesigner: RunDesignerFn = async (input: DesignerInput, deps: DesignerDeps): Promise<DesignerResult> => {
  const startedAt = Date.now();
  const deadline = startedAt + MAX_WALL_MS;
  const isEdit = !!(input.priorScript && input.editRequest);
  const minRunScripts = isEdit ? 1 : 2;
  const reviewRequest = isEdit ? `${input.request}\n\nFollow-up edit: ${input.editRequest}` : input.request;

  const modelSlug =
    deps.model ?? (process.env.CADAI_MODEL && isOfferedModel(process.env.CADAI_MODEL) ? process.env.CADAI_MODEL : DEFAULT_MODEL);

  // The wall cap also aborts an in-flight model call or geometry run.
  const wall = new AbortController();
  const wallTimer = setTimeout(() => wall.abort(), MAX_WALL_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, wall.signal]) : wall.signal;

  const emit = (e: DesignerEvent) => {
    try {
      deps.onEvent?.(e);
    } catch {
      // a failing listener must not end the build
    }
  };

  let costUsd = 0;
  let turns = 0;
  let runScriptCount = 0;
  let rendersSinceRun = 0;
  let finished = false;
  let summary = '';
  let cap: 'turns' | 'wall' | 'cost' | undefined;
  let stopReason: 'refusal' | 'max_tokens' | 'model_context_window_exceeded' | 'pause_turn' | undefined;
  let reviewRejections = 0;
  let pendingRevision = false;

  const referenceImages: RenderImage[] = (input.attachments ?? []).map((att, idx) => ({
    view: `reference:${idx + 1}`,
    dataUrl: `data:image/png;base64,${att.base64}`,
  }));

  const startingBody = isEdit ? toBody(input.priorScript as string) : '';
  const startingScript = withGeneratedPrelude(startingBody);
  let lastScript = isEdit ? (input.priorScript as string) : startingScript;
  let lastOkScript = isEdit ? (input.priorScript as string) : '';
  let lastPassingScript = '';
  let lastPassingFacts: DesignerFacts | null = null;
  let lastRun: BrepResult | null = null;
  let lastFacts: DesignerFacts | null = null;
  let lastImages: RenderImage[] = [];
  let activeBaseKey = '';
  const testedAtMax = new Set<string>();
  const reviewerFlags: DesignerResult['reviewerFlags'] = [];

  const tools = designerTools();
  const model = getChatModel(deps.model, { role: 'build' });
  const bound = typeof model.bindTools === 'function' ? model.bindTools(tools, { tool_choice: 'auto' }) : model;

  const firstUserBlocks: Array<
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'text'; text: string }
  > = [];
  if (input.attachments && input.attachments.length > 0) {
    for (const att of input.attachments) {
      firstUserBlocks.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${att.base64}` },
      });
    }
  }
  firstUserBlocks.push({ type: 'text', text: buildFirstUserMessage(input, startingBody) });

  const conversation: BaseMessage[] = [
    cachedSystemMessage(DESIGNER_SYSTEM_PROMPT),
    new HumanMessage({ content: firstUserBlocks as never }),
  ];
  let cachedMsg: BaseMessage | null = null;

  /** Guardrail first, always; the script reaches the geometry runner only when it passes. */
  const guardedRun = async (
    script: string,
    withMeshes: boolean,
  ): Promise<{ guard: string } | { result: BrepResult }> => {
    const guard = checkPythonScript(script);
    if (!guard.ok) return { guard: guard.reason };
    const remaining = Math.max(1_000, deadline - Date.now());
    const result = await runBrep(script, {
      interferences: true,
      connectivity: true,
      partMeshes: withMeshes,
      timeoutMs: Math.min(RUN_TIMEOUT_MS, remaining),
      signal,
    });
    return { result };
  };

  const callReviewer = async (images: RenderImage[], facts: DesignerFacts, final: boolean): Promise<ReviewFlag[] | null> => {
    if (!deps.review) return null;
    let flags: ReviewFlag[] = [];
    try {
      const reviewImages = referenceImages.length > 0 ? [...referenceImages, ...images] : images;
      const out = await deps.review({ request: reviewRequest, images: reviewImages, facts, final, signal, buildId: input.buildId });
      costUsd += Number.isFinite(out.costUsd) ? out.costUsd : 0;
      flags = (out.flags ?? []).slice(0, 3);
    } catch {
      flags = []; // a failed review is no review: the designer carries on
    }
    for (const f of flags) reviewerFlags.push({ ...f, round: turns, final });
    emit({ kind: 'review', flags, final });
    if (flags.some((f) => f.severity !== 'minor')) pendingRevision = true;
    return flags;
  };

  try {
    while (turns < MAX_TURNS && !finished) {
      if (signal.aborted) break;
      if (Date.now() >= deadline) {
        cap = 'wall';
        break;
      }
      if (costUsd >= MAX_COST_USD) {
        cap = 'cost';
        break;
      }
      turns++;
      cachedMsg = applyRollingCacheBreakpoint(conversation, cachedMsg, tools);

      let reply: AIMessage;
      try {
        reply = await bound.invoke(conversation, { signal, tags: ['nostream'] });
      } catch (err) {
        if (isAbortOrTimeout(err) || signal.aborted) {
          if (wall.signal.aborted && !deps.signal?.aborted) cap = 'wall';
        } else {
          emit({ kind: 'note', text: 'The model call failed' });
        }
        break;
      }
      costUsd += estimateCostUsd(modelSlug, replyUsage(reply));

      const stop = unusableStop(reply);
      if (stop) {
        stopReason = stop;
        emit({ kind: 'note', text: 'The model reply was unusable' });
        break;
      }
      conversation.push(reply);

      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) {
        conversation.push(new HumanMessage('Please continue your design using run_script, render, or finish.'));
        continue;
      }

      for (const call of calls) {
        const callId = call.id ?? `call_${turns}_${Math.random().toString(36).slice(2, 8)}`;
        const answer = (content: string | unknown[]) =>
          conversation.push(new ToolMessage({ tool_call_id: callId, name: call.name, content: content as never }));

        if (finished) {
          answer('Ignored: finish was already accepted.');
          continue;
        }
        if (signal.aborted) {
          answer('Stopped.');
          continue;
        }

        if (call.name === 'run_script') {
          const rawArg = typeof call.args?.script === 'string' ? call.args.script : (lastScript ? toBody(lastScript) : '');
          const body = toBody(rawArg);
          const script = withGeneratedPrelude(body);
          runScriptCount++;
          rendersSinceRun = 0;
          lastScript = script;
          const key = scriptBaseKey(script);
          if (key !== activeBaseKey) {
            activeBaseKey = key;
            testedAtMax.clear();
          }
          if (pendingRevision) {
            emit({ kind: 'step', text: 'Revising after review' });
            pendingRevision = false;
          }

          const run = await guardedRun(script, false);
          if ('guard' in run) {
            lastRun = null;
            emit({ kind: 'step', text: 'The script was rejected by the safety check; revising' });
            answer(`Script guardrail check failed: ${run.guard}`);
            continue;
          }
          const r = run.result;
          lastRun = r;
          lastFacts = factsFromRun(r, script);
          if (r.ok) {
            lastOkScript = script;
            if (checkRun(r).passing) {
              lastPassingScript = script;
              lastPassingFacts = lastFacts;
            }
            emit({ kind: 'step', text: `Built the model (${plural((r.parts ?? []).length, 'part')})` });
          } else {
            emit({ kind: 'step', text: 'The model did not build; revising' });
          }
          answer(formatFactsTable(r, script));
        } else if (call.name === 'render') {
          rendersSinceRun++;
          const overrides = (call.args?.overrides as Record<string, number> | undefined) ?? {};
          if (!lastOkScript) {
            answer('Nothing to render yet: call run_script with a script that builds first.');
            continue;
          }
          const script = applyParameterOverrides(lastOkScript, overrides);
          const run = await guardedRun(script, true);
          if ('guard' in run) {
            answer(`Render script guardrail failure: ${run.guard}`);
            continue;
          }
          const r = run.result;
          if (!r.ok) {
            answer(`Render geometry run failed: ${(r.error ?? 'unknown error').slice(-1500)}`);
            continue;
          }

          const views = renderPartViews(r);
          const clashes = (r.interferences ?? []).filter((i) => i.volume > INTERFERENCE_MIN_VOLUME);
          const posed = findPoseParams(script);
          const entries = Object.entries(overrides);
          for (const [k, v] of entries) {
            const p = posed.find((q) => q.name === k);
            if (p && p.max !== undefined && Math.abs(p.value - v) < POSE_TOLERANCE && v >= p.max - POSE_TOLERANCE && clashes.length === 0) {
              testedAtMax.add(p.name);
            }
          }

          const pose = entries.map(([k, v]) => `${k}=${v}`).join(',');
          const images = toRenderImages(views, pose || undefined);
          const facts = factsFromRun(r, script);
          lastImages = images;
          emit({ kind: 'step', text: `Rendered ${plural(views.length, 'view')}${pose ? ' (open pose)' : ''}` });

          let header = `Rendered ${views.length} views (${views.map((v) => v.name).join(', ')})`;
          if (pose) header += ` with overrides: ${JSON.stringify(overrides)}`;
          if (clashes.length > 0) {
            header += `\nWARNING: interferences detected in this pose: ${clashes.map((c) => `${c.a} collides with ${c.b} (${c.volume.toFixed(1)} mm³)`).join(', ')}`;
          }
          const flags = await callReviewer(images, facts, false);
          if (flags) {
            header += `\n\nIndependent reviewer notes:${flags.length > 0 ? `\n${formatFlags(flags)}` : ' no issues flagged.'}`;
          }
          const blocks: unknown[] = [{ type: 'text', text: header }];
          for (const v of views) {
            blocks.push({ type: 'text', text: `View: ${v.name}` });
            blocks.push({ type: 'image_url', image_url: { url: v.dataUrl } });
          }
          answer(blocks);
        } else if (call.name === 'finish') {
          const given = typeof call.args?.summary === 'string' ? call.args.summary : '';
          const reject = (reason: string) => {
            emit({ kind: 'step', text: 'Finish checks not met; continuing' });
            answer(`Finish rejected: ${reason}`);
          };

          const finishScript = typeof call.args?.script === 'string' ? call.args.script.trim() : '';
          if (finishScript && toBody(finishScript).trim() !== toBody(lastScript).trim()) {
            reject('the script was modified in the finish call. Geometry changes must go through run_script and be checked with render before finishing.');
            continue;
          }
          if (runScriptCount < minRunScripts) {
            reject(`at least ${plural(minRunScripts, 'run_script call')} ${minRunScripts === 1 ? 'is' : 'are'} required before finishing (you have made ${runScriptCount}).`);
            continue;
          }
          if (rendersSinceRun === 0) {
            reject('at least one render call is required after the last run_script.');
            continue;
          }
          const passing = lastRun ? checkRun(lastRun) : { passing: false, reason: 'no script has run since the last change' };
          if (!passing.passing) {
            reject(`the last run did not pass the checks: ${passing.reason}`);
            continue;
          }

          let poseError: string | null = null;
          for (const p of findPoseParams(lastScript)) {
            if (p.min === undefined || p.max === undefined) {
              poseError = `parameter '${p.name}' ends in _deg/_travel but has no range comment # [min:step:max].`;
            } else if (Math.abs(p.value - p.min) > POSE_TOLERANCE) {
              poseError = `parameter '${p.name}' must default to its range min (${p.min}), but defaults to ${p.value}.`;
            } else if (!testedAtMax.has(p.name)) {
              poseError = `parameter '${p.name}' must be rendered at its range max (${p.max}) with no interference. Call render with {"${p.name}": ${p.max}} before finishing.`;
            }
            if (poseError) break;
          }
          if (poseError) {
            reject(poseError);
            continue;
          }

          if (deps.review && lastFacts) {
            const flags = (await callReviewer(lastImages, lastFacts, true)) ?? [];
            const blocking = flags.filter((f) => f.severity === 'blocking');
            if (blocking.length > 0 && reviewRejections < MAX_REVIEW_REJECTIONS) {
              reviewRejections++;
              emit({ kind: 'step', text: 'Revising after review' });
              pendingRevision = false;
              answer(`Finish rejected by the independent reviewer:\n${formatFlags(blocking)}`);
              continue;
            }
          }

          finished = true;
          summary = given;
          emit({ kind: 'step', text: 'Finished' });
          answer(JSON.stringify({ status: 'finished' }));
        } else {
          answer(`Unknown tool "${call.name}".`);
        }
      }
    }
  } finally {
    clearTimeout(wallTimer);
  }

  if (!finished && !cap) {
    if (turns >= MAX_TURNS) cap = 'turns';
    else if (!signal.aborted && Date.now() >= deadline) cap = 'wall';
    else if (costUsd >= MAX_COST_USD) cap = 'cost';
  }
  if (cap) {
    const text = { turns: 'Reached the turn limit', wall: 'Reached the time limit', cost: 'Reached the cost limit' }[cap];
    emit({ kind: 'note', text: `${text}; using the last version that passed the checks` });
  }

  const failed = lastPassingScript === '';
  const script = lastPassingScript || lastOkScript || lastScript;
  const result: DesignerResult = {
    script,
    facts: lastPassingFacts ?? lastFacts ?? EMPTY_FACTS,
    summary: finished
      ? summary
      : failed
        ? 'The designer stopped before producing a model that passed the checks.'
        : 'The designer stopped before finishing; this is the last version that passed the checks.',
    reviewerFlags,
    turns,
    costUsd,
  };
  if (cap && !finished) result.capped = cap;
  if (stopReason) result.stop = stopReason;
  if (failed) result.failed = true;
  return result;
};
