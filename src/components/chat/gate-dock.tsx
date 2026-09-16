'use client';

import React, { useEffect, useState } from 'react';
import { Check, X, RefreshCw } from 'lucide-react';
import { GateDecision, GatePayload } from '@/types';

interface GateDockProps {
  gate: GatePayload | null;
  onResume: (decision: GateDecision) => void;
}

export function GateDock({ gate, onResume }: GateDockProps) {
  const [comment, setComment] = useState('');
  // questionId -> the user's answer. Seeded lazily from suggestedAnswer so
  // Approve-without-touching-anything still sends the architect's own
  // suggestion back as a confirmed fact rather than leaving it ambiguous.
  const [answers, setAnswers] = useState<Record<string, string>>({});

  // The radio selection at the research gate. Reset whenever a new gate
  // arrives so a choice made on one brief cannot carry over to another.
  const [chosenId, setChosenId] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setChosenId(null), [gate]);
  const isResearch = gate?.kind === 'research';

  const answerFor = (q: { id: string; suggestedAnswer?: string }) =>
    answers[q.id] ?? q.suggestedAnswer ?? '';

  const collectedAnswers = () => {
    if (gate?.kind !== 'spec' || !gate.spec?.openQuestions?.length) return undefined;
    const out: Record<string, string> = {};
    for (const q of gate.spec.openQuestions) {
      const a = answerFor(q).trim();
      if (a) out[q.id] = a;
    }
    return Object.keys(out).length ? out : undefined;
  };

  const title =
    gate?.kind === 'research' ? 'Choose a Design Approach'
    : gate?.kind === 'accept' ? 'Review Compiled Model'
    : 'Approval Required';

  return (
    <div className="border-t border-slate-800 bg-slate-900/90 px-3 py-2 space-y-2">
      <div className="text-[11px] font-semibold text-indigo-300">{title}</div>

      {!gate ? (
        <p className="text-xs text-slate-500 italic">Waiting for details from the agent...</p>
      ) : gate.kind === 'spec' ? (
        <>
          {gate.spec?.openQuestions?.length ? (
            <div className="space-y-2">
              <ul className="text-xs text-cyan-200/80 space-y-2">
                {gate.spec.openQuestions.map((q) => (
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
      ) : gate.kind === 'research' ? (
        <div className="space-y-2">
          <div role="radiogroup" aria-label="Design approach" className="space-y-2">
            {gate.brief.approaches.map((a) => {
              const selected = (chosenId ?? gate.brief.recommendedId) === a.id;
              return (
                <label
                  key={a.id}
                  className={`block rounded-lg border p-2 cursor-pointer transition-colors ${
                    selected ? 'border-emerald-500/60 bg-emerald-900/10' : 'border-slate-700 bg-slate-950/40 hover:border-slate-600'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="radio"
                      name="approach"
                      value={a.id}
                      checked={selected}
                      onChange={() => setChosenId(a.id)}
                      className="accent-emerald-500"
                    />
                    <span className="text-xs font-semibold text-slate-100">{a.name}</span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      ) : gate.kind === 'accept' ? null : null}

      <div className="space-y-2">
        {/* One research pass per thread: no comment box and no Revise here. */}
        {!isResearch && (
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add comments or request changes (optional)..."
            className="w-full h-16 bg-slate-900 border border-slate-700 rounded p-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 resize-none"
          />
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => onResume({ action: 'cancel' })}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
          >
            <X className="w-3.5 h-3.5" /> Deny
          </button>
          {!isResearch && (
            <button
              onClick={() => onResume({ action: 'revise', comment, answers: collectedAnswers() })}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 text-xs transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Revise
            </button>
          )}
          <button
            onClick={() =>
              onResume({
                action: 'approve',
                comment: isResearch ? undefined : comment || undefined,
                answers: collectedAnswers(),
                spec: gate?.kind === 'spec' ? gate.spec ?? undefined : undefined,
                chosenApproachId: gate?.kind === 'research' ? chosenId ?? gate.brief.recommendedId : undefined,
              })
            }
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow transition-colors"
          >
            <Check className="w-3.5 h-3.5" /> {isResearch ? 'Use this approach' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
