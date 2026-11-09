'use client';

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatMessage } from '@/types';
import { useAppStore } from '@/store/app-store';
import { compileModel } from '@/lib/engine/build123d-client';
import { parseTranscript } from '@/lib/agent/transcript';
import { TranscriptView } from './transcript-view';
import { cn } from '@/lib/utils';
import { Check, Copy, Play, User, Bot, Code, AlertCircle, PenLine, Layers } from 'lucide-react';

interface MessageBubbleProps {
  message: ChatMessage;
}

function AttachmentThumbnail({ id }: { id: string }) {
  const [error, setError] = useState(false);
  if (error) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card/40 text-[11px] text-muted-foreground">
        <AlertCircle className="size-3.5 text-muted-foreground shrink-0" />
        <span>Image unavailable</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/artifacts/${encodeURIComponent(id)}`}
      alt="Attachment thumbnail"
      onError={() => setError(true)}
      className="max-h-48 rounded-lg border border-border object-contain bg-background/50"
    />
  );
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const { setCode, setCompileResult, setCompileStatus } = useAppStore();
  const [copied, setCopied] = useState(false);
  const [messageCopied, setMessageCopied] = useState(false);

  if (message.kind === 'tool_edit') {
    return (
      <div
        data-kind="tool_edit"
        className="flex items-center gap-2 py-2 px-3 text-xs text-muted-foreground"
      >
        <PenLine className="size-3.5 text-muted-foreground shrink-0" />
        <span className="truncate">{message.content}</span>
        {message.designVersion != null && !/· v\d+$/.test(message.content.trim()) && (
          <span className="font-mono text-[11px] text-muted-foreground shrink-0">
            · v{message.designVersion}
          </span>
        )}
      </div>
    );
  }

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyMessage = () => {
    navigator.clipboard.writeText(message.content);
    setMessageCopied(true);
    setTimeout(() => setMessageCopied(false), 2000);
  };

  const handleApplyCode = async (codeToApply: string) => {
    setCode(codeToApply);
    setCompileStatus('compiling');
    const result = await compileModel(codeToApply);
    setCompileResult(result);
  };

  const copyMessageButton = (
    <button
      onClick={handleCopyMessage}
      title="Copy message"
      aria-label="Copy message"
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 cursor-pointer"
    >
      {messageCopied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
      <span>{messageCopied ? 'Copied' : 'Copy'}</span>
    </button>
  );

  return (
    <div className={cn('group flex gap-3 py-3', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser && (
        <div className="size-7 rounded-xl bg-[image:var(--accent-gradient)] flex items-center justify-center shrink-0 shadow-xs mt-0.5">
          <Bot className="size-3.5 text-primary-foreground" />
        </div>
      )}

      <div className={cn('max-w-[88%] space-y-2', isUser ? 'items-end' : 'items-start')}>
        {/* Message body */}
        <div
          className={cn(
            'rounded-2xl px-4 py-3 text-sm leading-relaxed',
            isUser
              ? 'bg-[image:linear-gradient(135deg,color-mix(in_srgb,var(--accent-from)_22%,transparent),color-mix(in_srgb,var(--accent-to)_16%,transparent))] border border-primary/30 text-foreground shadow-xs'
              : 'glass text-foreground'
          )}
        >
          {isUser && message.layer && (
            <div
              data-slot="layer-chip"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 mb-2 rounded-[var(--radius-pill)] border border-border/50 bg-card/40 text-xs text-foreground font-medium"
            >
              <Layers className="size-3 text-muted-foreground shrink-0" />
              <span>Layer {message.layer.name}</span>
            </div>
          )}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              h1: ({ children }) => <h1 className="text-base font-bold text-foreground mb-2">{children}</h1>,
              h2: ({ children }) => <h2 className="text-sm font-semibold text-foreground mb-1.5">{children}</h2>,
              h3: ({ children }) => <h3 className="text-xs font-semibold text-foreground/90 mb-1">{children}</h3>,
              ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-1 text-xs">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-1 text-xs">{children}</ol>,
              li: ({ children }) => <li className="text-foreground/90">{children}</li>,
              strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
              code: ({ inline, className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { inline?: boolean }) => {
                const match = /language-(\w+)/.exec(className || '');
                const language = match ? match[1] : '';
                const codeString = String(children).replace(/\n$/, '');

                if (!inline && (language === 'python' || language === 'build123d')) {
                  return (
                    <div className="my-3 rounded-lg overflow-hidden border border-border bg-card/60">
                      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border-b border-border text-xs">
                        <div className="flex items-center gap-1.5 text-primary font-mono">
                          <Code className="size-3.5" />
                          <span>build123d</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleCopy(codeString)}
                            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-accent hover:bg-accent/80 text-foreground transition-colors cursor-pointer"
                          >
                            {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
                            <span>{copied ? 'Copied' : 'Copy'}</span>
                          </button>
                          <button
                            onClick={() => handleApplyCode(codeString)}
                            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-[image:var(--accent-gradient)] text-primary-foreground shadow-xs hover:opacity-90 transition-opacity cursor-pointer"
                          >
                            <Play className="size-3 fill-current" />
                            <span>Render</span>
                          </button>
                        </div>
                      </div>
                      <pre className="p-3 text-xs font-mono text-foreground/90 overflow-x-auto max-h-60 bg-background/60">
                        <code>{codeString}</code>
                      </pre>
                    </div>
                  );
                }

                return (
                  <code className="bg-accent px-1.5 py-0.5 rounded text-xs font-mono text-primary" {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {message.content}
          </ReactMarkdown>

          {isUser && message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {message.attachments.map((att) => (
                <AttachmentThumbnail key={att.id} id={att.id} />
              ))}
            </div>
          )}

          {isUser && message.image && (!message.attachments || message.attachments.length === 0) && (
            <div className="mt-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={message.image}
                alt="Attachment preview"
                className="max-h-48 rounded-lg border border-border object-contain bg-background/50"
              />
            </div>
          )}
        </div>

        {!isUser && message.transcript && parseTranscript(message.transcript).length > 0 && (
          <details
            open={message.status === 'streaming'}
            className="rounded-lg border border-border/50 bg-card/30 overflow-hidden"
          >
            <summary className="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground list-none font-medium">
              <span>Steps</span>
            </summary>
            <div className="p-2 border-t border-border/40">
              <TranscriptView transcript={message.transcript} />
            </div>
          </details>
        )}

        {message.code && (
          <details className="rounded-lg border border-border bg-card/30 overflow-hidden">
            <summary className="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer select-none text-[11px] text-primary list-none">
              <Code className="size-3.5" />
              <span>View code</span>
            </summary>
            <pre className="p-3 text-xs font-mono text-foreground/90 overflow-x-auto max-h-60">
              <code>{message.code}</code>
            </pre>
          </details>
        )}

        <div className={cn('flex items-center gap-1 px-1', isUser ? 'justify-end' : 'justify-start')}>
          {isUser && copyMessageButton}
          <span className="text-[10px] text-muted-foreground">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {!isUser && copyMessageButton}
        </div>
      </div>

      {isUser && (
        <div className="size-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0 shadow-xs mt-0.5">
          <User className="size-3.5 text-primary" />
        </div>
      )}
    </div>
  );
}
