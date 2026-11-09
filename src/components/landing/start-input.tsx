'use client';

import React from 'react';
import { ArrowUp, Loader2, X } from 'lucide-react';
import { ImageButton } from '@/components/input/image-button';
import { ModelSelect } from '@/components/input/model-select';
import { useAppStore, type PendingAttachment } from '@/store/app-store';
import { cn } from '@/lib/utils';

export function canStart(
  text: string,
  pending: PendingAttachment | null,
  starting?: boolean
): boolean {
  if (starting) return false;
  if (!text.trim()) return false;
  if (pending && (pending.status === 'uploading' || pending.status === 'failed')) {
    return false;
  }
  return true;
}

export interface StartInputProps {
  value: string;
  onChange(v: string): void;
  onStart(
    prompt: string,
    opts: {
      attachments?: Array<{
        id: string;
        kind: 'markup' | 'reference';
        localUrl?: string;
      }>;
      model?: string;
    }
  ): void | Promise<void>;
  starting?: boolean;
}

export function StartInput({
  value,
  onChange,
  onStart,
  starting,
}: StartInputProps) {
  const selectedModel = useAppStore((s) => s.selectedModel);
  const pendingAttachment = useAppStore((s) => s.pendingAttachment);
  const removeAttachment = useAppStore((s) => s.removeAttachment);
  const retryAttachment = useAppStore((s) => s.retryAttachment);

  const disabled = !canStart(value, pendingAttachment, starting);

  const handleSubmit = () => {
    if (disabled) return;
    const ready =
      pendingAttachment &&
      pendingAttachment.status === 'ready' &&
      pendingAttachment.id;

    void onStart(value.trim(), {
      attachments:
        ready && pendingAttachment
          ? [
              {
                id: pendingAttachment.id!,
                kind: pendingAttachment.kind,
                localUrl: pendingAttachment.localUrl,
              },
            ]
          : undefined,
      model: selectedModel,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      data-slot="start-input"
      className="glass w-full rounded-[var(--radius-panel)] p-4 flex flex-col gap-3 transition-shadow"
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe a part, or attach a sketch or photo"
        rows={2}
        className="w-full resize-none border-none bg-transparent p-0 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:outline-none focus-visible:ring-0 field-sizing-content min-h-[56px]"
      />

      {pendingAttachment && (
        <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/40 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={pendingAttachment.localUrl}
            alt=""
            className="size-10 rounded object-cover border border-border/50"
          />
          <div className="flex flex-1 items-center justify-between text-xs">
            {pendingAttachment.status === 'uploading' && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Uploading image
              </span>
            )}
            {pendingAttachment.status === 'failed' && (
              <span className="flex items-center gap-2 text-destructive">
                Upload failed
                <button
                  type="button"
                  onClick={retryAttachment}
                  className="text-foreground underline underline-offset-2 hover:opacity-80 transition-opacity cursor-pointer font-medium"
                >
                  Retry
                </button>
              </span>
            )}
            {pendingAttachment.status === 'ready' && <span />}

            <button
              type="button"
              onClick={removeAttachment}
              aria-label="Remove image"
              className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          <ImageButton disabled={starting} />
          <ModelSelect />
        </div>

        <button
          type="button"
          data-slot="start-button"
          disabled={disabled}
          onClick={handleSubmit}
          className={cn(
            'inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-pill)] bg-[image:var(--accent-gradient)] text-primary-foreground text-xs font-semibold shadow-[0_0_24px_var(--accent-glow)] hover:opacity-90 transition-opacity cursor-pointer disabled:pointer-events-none disabled:opacity-50'
          )}
        >
          <span>Start</span>
          <ArrowUp className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
