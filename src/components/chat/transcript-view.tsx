'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseTranscript, type SectionStatus } from '@/lib/agent/transcript';
import type { GateRecord } from '@/types';
import { Check, AlertCircle, Loader2, MinusCircle, ChevronRight } from 'lucide-react';

const STATUS_ICON: Record<SectionStatus, React.ReactNode> = {
  running: <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />,
  ok: <Check className="w-3.5 h-3.5 text-emerald-400" />,
  warn: <AlertCircle className="w-3.5 h-3.5 text-amber-400" />,
  error: <AlertCircle className="w-3.5 h-3.5 text-rose-400" />,
  skipped: <MinusCircle className="w-3.5 h-3.5 text-slate-500" />,
};

interface TranscriptViewProps {
  transcript: string;
  gates?: Record<string, GateRecord>;
}

/**
 * Renders the streamed transcript as one collapsible section per graph hop.
 *
 * A running section is open so the user watches it fill; a finished one
 * collapses to its label, which is what keeps a ten-node run readable.
 */
export function TranscriptView({ transcript, gates }: TranscriptViewProps) {
  const nodes = parseTranscript(transcript);
  if (nodes.length === 0) return null;

  return (
    <div className="space-y-1">
      {nodes.map((node, i) => {
        if (node.kind === 'gate') {
          const record = gates?.[node.id];
          // An open gate is answered in the dock above the composer, so it has
          // nothing to show here yet.
          if (!record || record.status === 'open') return null;
          return (
            <div
              key={`gate-${node.id}-${i}`}
              className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-slate-900/60 border border-slate-800 text-[11px]"
            >
              <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-px" />
              <div className="min-w-0">
                <span className="text-slate-300 capitalize">{record.status}</span>
                {record.decidedAt ? (
                  <span className="text-slate-500">
                    {' · '}
                    {new Date(record.decidedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                ) : null}
                {record.decision?.comment ? (
                  <p className="text-slate-400 mt-0.5 break-words">{record.decision.comment}</p>
                ) : null}
              </div>
            </div>
          );
        }

        return (
          <details
            key={`${node.id}-${i}`}
            open={node.status === 'running'}
            className="group rounded-md border border-slate-800 bg-slate-900/40 open:bg-slate-900/70"
          >
            <summary className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer select-none text-[11px] text-slate-300 list-none">
              <ChevronRight className="w-3 h-3 text-slate-500 transition-transform group-open:rotate-90" />
              {STATUS_ICON[node.status]}
              <span className="font-medium">{node.label}</span>
            </summary>
            <div className="px-3 pb-2 pt-1 text-xs text-slate-300 max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.body}</ReactMarkdown>
            </div>
          </details>
        );
      })}
    </div>
  );
}
