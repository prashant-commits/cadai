'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/store/app-store';
import { ArrowUp, Square, Loader2, Sparkles, X, Layers } from 'lucide-react';
import { ImageButton } from '@/components/input/image-button';
import { ModelSelect } from '@/components/input/model-select';
import { cn } from '@/lib/utils';
import { resolveSelectedLayer } from '@/lib/tools/layers';

export interface ChatInputProps {
  onSendMessage: (
    message: string,
    attachment?: { id: string; kind: 'markup' | 'reference'; localUrl: string } | string
  ) => void;
  onStop?: () => void;
  disabled?: boolean;
  isGenerating?: boolean;
  initialText?: string;
  showPromptChips?: boolean;
}

const QUICK_PROMPTS = [
  'Phone stand with 60° angle & cable notch',
  'Snap-fit enclosure with 2mm walls',
  'Mounting bracket with M3 screw holes',
  'Parametric 16-tooth GT2 pulley',
];

export function ChatInput({
  onSendMessage,
  onStop,
  disabled = false,
  isGenerating = false,
  initialText = '',
  showPromptChips = false,
}: ChatInputProps) {
  const {
    pendingAttachment,
    removeAttachment,
    retryAttachment,
    selectedLayerId,
    setSelectedLayerId,
    code,
    parts,
    threads,
    activeThreadId,
    viewingVersion,
  } = useAppStore();
  const [input, setInput] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const currentVersion = activeThread?.versions?.find((v) => v.version === viewingVersion);
  const selectedLayer = resolveSelectedLayer(code, parts, currentVersion, selectedLayerId);

  const isUploadingOrFailed =
    pendingAttachment?.status === 'uploading' || pendingAttachment?.status === 'failed';
  const isSendDisabled =
    disabled ||
    isUploadingOrFailed ||
    (!input.trim() && (!pendingAttachment || pendingAttachment.status !== 'ready'));

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled, pendingAttachment]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isGenerating || isSendDisabled) return;

    const attToSend =
      pendingAttachment && pendingAttachment.status === 'ready' && pendingAttachment.id
        ? {
            id: pendingAttachment.id,
            kind: pendingAttachment.kind,
            localUrl: pendingAttachment.localUrl,
          }
        : undefined;

    onSendMessage(input.trim(), attToSend);
    setInput('');
    removeAttachment();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="p-3 space-y-2 select-none">
      {/* Quick suggestions */}
      {showPromptChips && !pendingAttachment && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none text-[11px]">
          <span className="text-muted-foreground flex items-center gap-1 shrink-0 px-1 font-medium">
            <Sparkles className="size-3 text-primary" />
            Try:
          </span>
          {QUICK_PROMPTS.map((prompt, idx) => (
            <button
              key={idx}
              type="button"
              disabled={disabled}
              onClick={() => onSendMessage(prompt)}
              className="glass shrink-0 px-2.5 py-1 rounded-[var(--radius-pill)] hover:bg-accent text-foreground/80 hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {/* Input Form Box */}
      <form onSubmit={handleSubmit} data-slot="chat-input" className="glass rounded-3xl p-3 flex flex-col gap-2 relative">
        {/* Task 17: layer chip */}
        {selectedLayer && (
          <div
            data-slot="layer-chip"
            className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-pill)] border border-border/50 bg-card/40 text-xs text-foreground font-medium"
          >
            <Layers className="size-3 text-muted-foreground shrink-0" />
            <span>Layer {selectedLayer.name}</span>
            <button
              type="button"
              onClick={() => setSelectedLayerId(null)}
              aria-label="Clear layer"
              className="p-0.5 rounded-full hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="size-3 text-current" />
            </button>
          </div>
        )}

        {/* Attachment Chip */}
        {pendingAttachment && (
          <div className="relative self-start group flex items-center gap-2 p-1.5 rounded-xl border border-border/50 bg-card/40">
            {pendingAttachment.status === 'uploading' && (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                <span>Uploading…</span>
              </div>
            )}
            {pendingAttachment.status === 'failed' && (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-destructive">
                <span>Upload failed</span>
                <button
                  type="button"
                  onClick={retryAttachment}
                  className="px-2 py-0.5 rounded-md bg-accent hover:bg-accent/80 text-foreground text-[11px] font-medium transition-colors cursor-pointer"
                >
                  Retry
                </button>
              </div>
            )}
            {pendingAttachment.status === 'ready' && (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pendingAttachment.localUrl}
                  alt="Attachment preview"
                  className="h-16 rounded-md border border-border/50 object-contain bg-background/50"
                />
              </div>
            )}
            <button
              type="button"
              onClick={removeAttachment}
              aria-label="Remove image"
              className="p-1 rounded-full bg-accent/80 text-muted-foreground hover:text-foreground hover:bg-destructive transition-colors cursor-pointer"
            >
              <X className="size-3 text-current" />
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={
            disabled
              ? 'CAD AI is generating & validating model...'
              : pendingAttachment
              ? 'Describe the changes marked in the image...'
              : 'Ask the AI to edit, or describe a feature...'
          }
          rows={2}
          className="w-full resize-none border-none bg-transparent p-1 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:outline-none focus-visible:ring-0 field-sizing-content min-h-[44px]"
        />

        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-2">
            <ImageButton disabled={disabled || isGenerating} />
            <ModelSelect />
          </div>

          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              data-slot="send-button"
              className="inline-flex size-8 items-center justify-center rounded-[var(--radius-pill)] bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={isSendDisabled}
              aria-label="Send prompt"
              data-slot="send-button"
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-[var(--radius-pill)] bg-[image:var(--accent-gradient)] text-primary-foreground text-xs font-semibold shadow-[0_0_24px_var(--accent-glow)] hover:opacity-90 transition-opacity cursor-pointer disabled:pointer-events-none disabled:opacity-50'
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </form>

      <div className="flex justify-between items-center text-[10px] text-muted-foreground px-1">
        <span>Enter to send, Shift+Enter for new line</span>
        <span>Validation runs before live preview</span>
      </div>
    </div>
  );
}
