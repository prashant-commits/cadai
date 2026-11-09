'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseTranscript, type SectionStatus } from '@/lib/agent/transcript';
import { Check, AlertCircle, Loader2, MinusCircle, ChevronRight } from 'lucide-react';

const STATUS_ICON: Record<SectionStatus, React.ReactNode> = {
  running: <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />,
  ok: <Check className="w-3.5 h-3.5 text-primary" />,
  warn: <AlertCircle className="w-3.5 h-3.5 text-destructive/80" />,
  error: <AlertCircle className="w-3.5 h-3.5 text-destructive" />,
  skipped: <MinusCircle className="w-3.5 h-3.5 text-muted-foreground" />,
};

interface TranscriptViewProps {
  transcript: string;
}

export function TranscriptView({ transcript }: TranscriptViewProps) {
  const nodes = parseTranscript(transcript);
  if (nodes.length === 0) return null;

  return (
    <div className="space-y-1">
      {nodes.map((node, i) => (
        <details
          key={`${node.id}-${i}`}
          open={node.status === 'running'}
          className="group rounded-md border border-border/50 bg-card/40 open:bg-card/70"
        >
          <summary className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer select-none text-[11px] text-foreground/90 list-none">
            <ChevronRight className="w-3 h-3 text-muted-foreground transition-transform group-open:rotate-90" />
            {STATUS_ICON[node.status]}
            <span className="font-medium">{node.label}</span>
          </summary>
          <div className="px-3 pb-2 pt-1 text-xs text-foreground/80 max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.body}</ReactMarkdown>
          </div>
        </details>
      ))}
    </div>
  );
}
