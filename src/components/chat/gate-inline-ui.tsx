import React, { useState } from 'react';
import { Target, SlidersHorizontal, Check, X, RefreshCw, Ruler, ShieldAlert, Box, ClipboardCheck } from 'lucide-react';
import { GateDecision, GatePayload } from '@/types';

interface GateInlineUIProps {
  gate: GatePayload | null;
  onResume: (decision: GateDecision) => void;
}

export function GateInlineUI({ gate, onResume }: GateInlineUIProps) {
  const [comment, setComment] = useState('');
  // questionId -> the user's answer. Seeded lazily from suggestedAnswer so
  // Approve-without-touching-anything still sends the architect's own
  // suggestion back as a confirmed fact rather than leaving it ambiguous.
  const [answers, setAnswers] = useState<Record<string, string>>({});

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

  const title = gate?.kind === 'accept' ? 'Review Compiled Model' : 'Approval Required';

  return (
    // Laid out like an assistant turn: avatar gutter on the left, card capped
    // at the same width as a message bubble. `self-end`/`mx-4` were sized for
    // life outside the scroll container and made this read as floating chrome.
    <div className="group flex gap-3 py-4 justify-start">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
        <ClipboardCheck className="w-4 h-4 text-white" />
      </div>
      <div className="max-w-[88%] w-full bg-slate-900 border border-slate-700 rounded-xl overflow-hidden shadow-md">
      <div className="px-3 py-2 bg-indigo-900/30 border-b border-slate-700 flex items-center justify-between">
        <span className="text-xs font-semibold text-indigo-300">{title}</span>
        {gate && gate.revisionCount > 0 && (
          <span className="text-[10px] text-slate-500">Revision {gate.revisionCount}</span>
        )}
      </div>

      <div className="p-3 space-y-3">
        {!gate ? (
          <p className="text-xs text-slate-500 italic">Waiting for details from the agent...</p>
        ) : gate.kind === 'spec' ? (
          <>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-cyan-400">
                <Ruler className="w-3.5 h-3.5" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider">Bounding Box</h4>
              </div>
              {gate.spec?.boundingBox ? (
                <p className="text-xs text-slate-300 font-mono">
                  {gate.spec.boundingBox.width} x {gate.spec.boundingBox.length} x {gate.spec.boundingBox.height} mm
                </p>
              ) : (
                <p className="text-xs text-slate-500 italic">No Assembly Spec was generated.</p>
              )}
            </div>

            <div className="border-t border-slate-800" />

            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-rose-400">
                <Target className="w-3.5 h-3.5" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider">Design Intent</h4>
              </div>
              {gate.spec?.components?.length ? (
                <ul className="text-xs text-slate-300 list-disc list-inside space-y-0.5">
                  {gate.spec.components.map((p, i) => (
                    <li key={i}>
                      {p.description}
                      {/* Print posture the architect committed to; the audit
                          warns when the compiled part does not rest on it. */}
                      {p.bedFace || p.matingFaces?.length ? (
                        <span className="text-[10px] text-slate-500 font-mono">
                          {p.bedFace ? ` bed ${p.bedFace}` : ''}
                          {p.matingFaces?.length ? ` · flat: ${p.matingFaces.join(', ')}` : ''}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-500 italic">No parts specified.</p>
              )}
              {gate.spec?.assumptions?.length ? (
                <div className="mt-2">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">Assumptions</span>
                  <ul className="text-xs text-amber-200/80 list-disc list-inside space-y-0.5">
                    {gate.spec.assumptions.map((a, i) => (
                      <li key={i}>{a.field}: {a.value} - {a.rationale}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {gate.spec?.openQuestions?.length ? (
                <div className="mt-2">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">Open Questions</span>
                  <ul className="text-xs text-cyan-200/80 list-disc list-inside space-y-0.5">
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
            </div>

            {gate.spec?.edgeTreatments?.length ? (
              <>
                <div className="border-t border-slate-800" />
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-cyan-400">
                    <Ruler className="w-3.5 h-3.5" />
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider">Edge Treatments</h4>
                  </div>
                  <ul className="text-xs text-slate-300 space-y-1">
                    {gate.spec.edgeTreatments.map((e, i) => (
                      <li key={i} className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="px-1 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-cyan-200">{e.category}</span>
                        <span className="font-mono text-slate-200">{e.kind} {e.sizeMm}mm</span>
                        <span className="text-slate-400">
                          {e.component ? `${e.component}: ` : ''}{e.location}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}

            {gate.spec?.stressPoints?.length ? (
              <>
                <div className="border-t border-slate-800" />
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider">Stress Points</h4>
                  </div>
                  <ul className="text-xs text-slate-300 space-y-1">
                    {gate.spec.stressPoints.map((s, i) => (
                      <li key={i} className="space-y-0.5">
                        <div className="flex flex-wrap items-baseline gap-x-1.5">
                          <span
                            className={`px-1 py-0.5 rounded text-[10px] font-mono ${
                              s.risk === 'high'
                                ? 'bg-rose-900/40 text-rose-200'
                                : s.risk === 'medium'
                                  ? 'bg-amber-900/40 text-amber-200'
                                  : 'bg-slate-800 text-slate-300'
                            }`}
                          >
                            {s.risk}
                          </span>
                          <span className="text-slate-200">
                            {s.component ? `${s.component}: ` : ''}{s.location}
                          </span>
                          <span className="text-slate-500">({s.loadCase})</span>
                        </div>
                        <div className="text-[11px] text-emerald-200/80 pl-1">↳ {s.mitigation}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}

            {gate.contract && Object.keys(gate.contract.pinnedParams || {}).length > 0 && (
              <>
                <div className="border-t border-slate-800" />
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-cyan-400">
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider">Pinned Parameters</h4>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(gate.contract.pinnedParams).map(([name, pin]) => (
                      <div key={name} className="px-1.5 py-0.5 bg-slate-800 rounded text-[11px] font-mono text-slate-300">
                        {name}: <span className="text-emerald-400">{String(pin.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-cyan-400">
                <Box className="w-3.5 h-3.5" />
                <h4 className="text-[11px] font-semibold uppercase tracking-wider">Measured Geometry</h4>
              </div>
              {gate.modelInfo ? (
                <p className="text-xs text-slate-300 font-mono">
                  {gate.modelInfo.dimensions.x} x {gate.modelInfo.dimensions.y} x {gate.modelInfo.dimensions.z} mm
                  {' - '}{(gate.modelInfo.volumeMm3 / 1000).toFixed(1)} cm3
                  {gate.modelInfo.isManifold === false && <span className="text-rose-400"> - non-manifold</span>}
                  {/* Nef/CGAL-only field. Staying silent here let a simple part
                      read as though it had passed a manifold check that never
                      ran - say so, since this gate is asking a human to sign off. */}
                  {gate.modelInfo.isManifold === undefined && (
                    <span className="text-slate-500"> - manifold not verified</span>
                  )}
                </p>
              ) : (
                <p className="text-xs text-slate-500 italic">No geometry was produced.</p>
              )}
            </div>

            {gate.violations?.length > 0 && (
              <>
                <div className="border-t border-slate-800" />
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <ShieldAlert className="w-3.5 h-3.5" />
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider">Violations</h4>
                  </div>
                  <ul className="text-xs list-disc list-inside space-y-0.5">
                    {gate.violations.map((v, i) => (
                      <li key={i} className={v.severity === 'error' ? 'text-rose-300' : 'text-amber-200/80'}>
                        [{v.kind}] {v.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="p-3 bg-slate-950 border-t border-slate-800 space-y-2">
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
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
          <button
            onClick={() => onResume({ action: 'revise', comment, answers: collectedAnswers() })}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 text-xs transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Revise
          </button>
          <button
            onClick={() =>
              onResume({
                action: 'approve',
                comment: comment || undefined,
                answers: collectedAnswers(),
                spec: gate?.kind === 'spec' ? gate.spec ?? undefined : undefined,
              })
            }
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow transition-colors"
          >
            <Check className="w-3.5 h-3.5" /> Approve
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
