'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/store/app-store';
import { Send, Loader2, Sparkles, X, Image as ImageIcon, Square } from 'lucide-react';

interface ChatInputProps {
  onSendMessage: (
    message: string,
    attachment?: { id: string; kind: 'markup' | 'reference'; localUrl: string } | string
  ) => void;
  onStop?: () => void;
  disabled?: boolean;
  isGenerating?: boolean;
  initialText?: string;
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
}: ChatInputProps) {
  const { pendingAttachment, removeAttachment, retryAttachment } = useAppStore();
  const [input, setInput] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    if (isSendDisabled) return;

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
    <div className="p-3 bg-slate-950 border-t border-slate-800 space-y-2">
      {/* Quick suggestions */}
      {!pendingAttachment && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none text-[11px]">
          <span className="text-slate-500 flex items-center gap-1 shrink-0 px-1 font-medium">
            <Sparkles className="w-3 h-3 text-indigo-400" />
            Try:
          </span>
          {QUICK_PROMPTS.map((prompt, idx) => (
            <button
              key={idx}
              type="button"
              disabled={disabled}
              onClick={() => onSendMessage(prompt)}
              className="shrink-0 px-2.5 py-1 rounded-full bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-slate-300 transition-colors disabled:opacity-50"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="relative flex flex-col gap-2 bg-slate-900 border border-slate-800 focus-within:border-indigo-500/80 rounded-xl p-2 transition-all">
        
        {/* Attachment Preview / Chip */}
        {pendingAttachment && (
          <div className="relative self-start mt-1 ml-1 group flex items-center gap-2 p-1.5 rounded-lg border border-slate-700 bg-slate-950">
            {pendingAttachment.status === 'uploading' && (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-slate-300">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                <span>Uploading…</span>
              </div>
            )}
            {pendingAttachment.status === 'failed' && (
              <div className="flex items-center gap-2 px-2 py-1 text-xs text-rose-300">
                <span>Upload failed</span>
                <button
                  type="button"
                  onClick={retryAttachment}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-medium transition-colors"
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
                  className="h-20 rounded-md border border-slate-700 shadow-md object-contain bg-slate-950"
                />
                <div className="absolute bottom-1 right-1 bg-black/60 rounded px-1 text-[9px] text-white flex items-center gap-1">
                  <ImageIcon className="w-2.5 h-2.5" /> Annotated
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={removeAttachment}
              className="p-1 rounded-full bg-slate-800 text-slate-300 hover:text-white hover:bg-rose-500 transition-colors shadow-sm"
              title="Remove attachment"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2 w-full">
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
                : 'Describe a 3D model, mechanical feature, or print tuning request...'
            }
            rows={2}
            className="flex-1 bg-transparent resize-none text-sm text-slate-100 placeholder-slate-500 focus:outline-none scrollbar-thin px-1 py-0.5"
          />

          {isGenerating && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-rose-600/30 transition-all shrink-0 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              disabled={isSendDisabled}
              aria-label="Send prompt"
              className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white shadow-md shadow-indigo-600/30 transition-all shrink-0 cursor-pointer disabled:cursor-not-allowed"
              title="Send prompt (Enter)"
            >
              {disabled ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </form>
      <div className="flex justify-between items-center text-[10px] text-slate-500 px-1">
        <span>Enter to send, Shift+Enter for new line</span>
        <span>Validation runs before live preview</span>
      </div>
    </div>
  );
}
