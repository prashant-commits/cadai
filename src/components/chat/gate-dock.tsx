'use client';

import React, { useEffect, useState } from 'react';
import { Check, X, RefreshCw } from 'lucide-react';
import { GateDecision, GatePayload, GateVariant } from '@/types';
import { gateVariants, type VariantId } from '@/lib/agent/spec-variants';
import { EXPIRED_GATE_MESSAGE } from '@/lib/chat/rehydrate';

interface GateDockProps {
  gate: GatePayload | null;
  onResume: (decision: GateDecision) => void;
  /** An open gate older than 24 h. Approve and Revise stay disabled; Deny closes it. */
  expired?: boolean;
}

type OpenQuestion = NonNullable<Extract<GatePayload, { kind: 'spec' }>['openQuestions']>[number];

/** UTF-8 safe. `btoa` only accepts latin1, and a sheet may contain ° or ×. */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** First selectable variant, preferring the payload's recommendedId. */
export function defaultVariantId(gate: GatePayload | null): VariantId | null {
  if (!gate || gate.kind !== 'spec') return null;
  const selectable = gateVariants(gate).filter((variant) => variant.spec);
  if (selectable.length === 0) return null;
  const recommended = gate.recommendedId
    ? selectable.find((variant) => variant.id === gate.recommendedId)
    : undefined;
  return (recommended ?? selectable[0]).id;
}

/**
 * The highlighted variant. An explicit choice wins when that card has a spec;
 * otherwise the recommendation (or the first card that has a spec).
 */
export function selectableChosen(gate: GatePayload | null, chosenId: VariantId | null): VariantId | null {
  if (!gate || gate.kind !== 'spec') return null;
  const selectable = gateVariants(gate).filter((variant) => variant.spec);
  if (chosenId && selectable.some((variant) => variant.id === chosenId)) return chosenId;
  return defaultVariantId(gate);
}

/**
 * Shared questions for the dock. A new payload carries them on the gate;
 * a legacy record only has them on the spec, which `gateVariants` surfaces.
 */
export function sharedOpenQuestions(gate: GatePayload | null): OpenQuestion[] {
  if (!gate || gate.kind !== 'spec') return [];
  if (gate.openQuestions) return gate.openQuestions;
  const seen = new Set<string>();
  const questions: OpenQuestion[] = [];
  for (const variant of gateVariants(gate)) {
    for (const question of variant.spec?.openQuestions ?? []) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      questions.push(question);
    }
  }
  return questions;
}

/** Approve and Revise name the chosen variant and do not send a spec. */
export function specGateDecision(
  gate: GatePayload | null,
  action: 'approve' | 'revise',
  comment: string,
  answers: Record<string, string> | undefined,
  chosenId: VariantId | null,
): GateDecision {
  const chosenVariantId = selectableChosen(gate, chosenId) ?? undefined;
  const chosen = chosenVariantId ? { chosenVariantId } : {};
  if (action === 'revise') return { action, comment, answers, ...chosen };
  return { action, comment: comment || undefined, answers, ...chosen };
}

export function closeOnEscape(event: { key: string }, close: () => void) {
  if (event.key === 'Escape') close();
}

export function SheetOverlay({ svg, label, onClose }: { svg: string; label: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => closeOnEscape(event, onClose);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"
      role="dialog"
      aria-label={label}
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-3 right-3 p-1.5 rounded bg-slate-800 text-slate-200 hover:bg-slate-700"
      >
        <X className="w-4 h-4" />
      </button>
      {/* A data-URL image cannot run a script that was written into the sheet. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={svgDataUrl(svg)}
        alt={label}
        className="max-h-[90vh] max-w-[90vw] bg-slate-950"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

function VariantCard({
  variant,
  selected,
  onSelect,
  onEnlarge,
}: {
  variant: GateVariant;
  selected: boolean;
  onSelect: () => void;
  onEnlarge: () => void;
}) {
  const selectable = variant.spec !== null;
  const majors = (variant.review?.findings ?? []).filter((finding) => finding.severity === 'major');
  return (
    <div
      className={`w-40 max-w-full overflow-hidden rounded-lg border p-2 transition-colors ${
        selected ? 'border-emerald-500/60 bg-emerald-900/10' : 'border-slate-700 bg-slate-950/40'
      } ${selectable ? '' : 'opacity-60'}`}
    >
      <label className={`flex items-center gap-1.5 ${selectable ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
        <input
          type="radio"
          name="spec-variant"
          value={variant.id}
          checked={selected}
          disabled={!selectable}
          onChange={onSelect}
          className="accent-emerald-500"
        />
        <span className="text-xs font-semibold text-slate-100">{variant.id} - {variant.name}</span>
      </label>
      {variant.idea ? (
        <p className="mt-0.5 text-[11px] text-slate-400 truncate">{variant.idea}</p>
      ) : null}
      {variant.sheetSvg ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={svgDataUrl(variant.sheetSvg)}
          alt={`${variant.id} concept sheet`}
          className="mt-1 w-full h-auto cursor-zoom-in rounded border border-slate-800 bg-slate-950"
          onClick={onEnlarge}
        />
      ) : (
        <p className="mt-1 text-[11px] text-slate-500">no sheet</p>
      )}
      {variant.review ? (
        <p className={`mt-1 text-[11px] font-medium ${variant.review.validated ? 'text-emerald-300' : 'text-amber-300'}`}>
          {variant.review.validated ? 'Validated' : `Not validated after ${variant.review.attempts} attempts`}
        </p>
      ) : null}
      {majors.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5">
          {majors.map((finding, index) => (
            <li key={`${index}:${finding.severity}`} className="text-[11px] text-amber-200/90">{finding.issue}</li>
          ))}
        </ul>
      ) : null}
      {variant.error ? <p className="mt-0.5 text-[11px] text-slate-400">{variant.error}</p> : null}
      {variant.review?.note ? <p className="mt-0.5 text-[11px] text-slate-400">{variant.review.note}</p> : null}
    </div>
  );
}

export function GateDock({ gate, onResume, expired = false }: GateDockProps) {
  const [comment, setComment] = useState('');
  // questionId -> the user's answer. Seeded lazily from suggestedAnswer so
  // Approve-without-touching-anything still sends the architect's own
  // suggestion back as a confirmed fact rather than leaving it ambiguous.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // The choice and the enlarged sheet are stored with the gate they belong
  // to. A new gate is a new object, so the previous choice simply stops
  // matching and the recommendation shows again. No effect, no reset render.
  const [choice, setChoice] = useState<{ gate: GatePayload; id: VariantId } | null>(null);
  const [enlarged, setEnlarged] = useState<{ gate: GatePayload; svg: string; label: string } | null>(null);
  const chosenId = choice && gate && choice.gate === gate ? choice.id : null;
  const openSheet = enlarged && gate && enlarged.gate === gate ? enlarged : null;

  const answerFor = (q: { id: string; suggestedAnswer?: string }) =>
    answers[q.id] ?? q.suggestedAnswer ?? '';

  const questions = sharedOpenQuestions(gate);
  const collectedAnswers = () => {
    if (questions.length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const q of questions) {
      const a = answerFor(q).trim();
      if (a) out[q.id] = a;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const variants = gate?.kind === 'spec' ? gateVariants(gate) : [];
  const selectedId = selectableChosen(gate, chosenId);
  const title = gate?.kind === 'accept' ? 'Review Compiled Model' : 'Approval Required';

  return (
    <div className="border-t border-slate-800 bg-slate-900/90 px-3 py-2 space-y-2">
      <div className="text-[11px] font-semibold text-indigo-300">{title}</div>
      {expired ? <p className="text-xs text-amber-300">{EXPIRED_GATE_MESSAGE}</p> : null}

      {!gate ? (
        <p className="text-xs text-slate-500 italic">Waiting for details from the agent...</p>
      ) : gate.kind === 'spec' ? (
        <>
          {variants.length > 0 ? (
            <div role="radiogroup" aria-label="Spec variants" className="flex flex-wrap gap-2">
              {variants.map((variant) => (
                <VariantCard
                  key={variant.id}
                  variant={variant}
                  selected={selectedId === variant.id}
                  onSelect={() => {
                    if (variant.spec) setChoice({ gate, id: variant.id });
                  }}
                  onEnlarge={() => {
                    if (!variant.sheetSvg) return;
                    setEnlarged({ gate, svg: variant.sheetSvg, label: `${variant.id} - ${variant.name}` });
                  }}
                />
              ))}
            </div>
          ) : null}
          {questions.length > 0 ? (
            <div className="space-y-2">
              <ul className="text-xs text-cyan-200/80 space-y-2">
                {questions.map((q) => (
                  <li key={q.id} className="space-y-1">
                    <span>{q.question}</span>
                    {/* Options become one-click answers; anything else is
                        free text. Either way the answer is captured and
                        folded into the spec on Approve. */}
                    {q.options?.length ? (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {q.options.map((opt) => (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                            className={`px-1.5 py-0.5 rounded text-[11px] border transition-colors ${
                              answerFor(q) === opt
                                ? 'bg-emerald-600/30 border-emerald-500/50 text-emerald-200'
                                : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                            }`}
                          >
                            {opt}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <input
                      type="text"
                      value={answerFor(q)}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder={q.suggestedAnswer ? `Suggested: ${q.suggestedAnswer}` : 'Your answer...'}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-emerald-500"
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : gate.kind === 'accept' ? null : null}

      {openSheet ? (
        <SheetOverlay svg={openSheet.svg} label={openSheet.label} onClose={() => setEnlarged(null)} />
      ) : null}

      <div className="space-y-2">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add comments or request changes (optional)..."
          className="w-full h-16 bg-slate-900 border border-slate-700 rounded p-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onResume({ action: 'cancel' })}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
          >
            <X className="w-3.5 h-3.5" /> Deny
          </button>
          <button
            type="button"
            disabled={expired}
            onClick={() => onResume(specGateDecision(gate, 'revise', comment, collectedAnswers(), selectedId))}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Revise
          </button>
          <button
            type="button"
            disabled={expired}
            onClick={() => onResume(specGateDecision(gate, 'approve', comment, collectedAnswers(), selectedId))}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Check className="w-3.5 h-3.5" /> Approve
          </button>
        </div>
      </div>
    </div>
  );
}
