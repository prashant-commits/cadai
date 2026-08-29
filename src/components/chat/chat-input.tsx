'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, Sparkles } from 'lucide-react';

interface ChatInputProps {
  onSendMessage: (message: string) => void;
  disabled?: boolean;
}

const QUICK_PROMPTS = [
  '📱 Phone stand with 60° angle & cable notch',
  '📦 Snap-fit enclosure with 2mm walls',
  '🔩 Mounting bracket with M3 screw holes',
  '⚙️ Parametric 16-tooth GT2 pulley',
];

export function ChatInput({ onSendMessage, disabled = false }: ChatInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || disabled) return;

    onSendMessage(input.trim());
    setInput('');
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

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="relative flex items-end gap-2 bg-slate-900 border border-slate-800 focus-within:border-indigo-500/80 rounded-xl p-2 transition-all">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={disabled ? 'CAD AI is generating & validating model...' : 'Describe a 3D model, mechanical feature, or print tuning request...'}
          rows={2}
          className="w-full bg-transparent resize-none text-sm text-slate-100 placeholder-slate-500 focus:outline-none scrollbar-thin px-1 py-0.5"
        />

        <button
          type="submit"
          disabled={disabled || !input.trim()}
          className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white shadow-md shadow-indigo-600/30 transition-all shrink-0 cursor-pointer disabled:cursor-not-allowed"
          title="Send prompt (Enter)"
        >
          {disabled ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </form>
      <div className="flex justify-between items-center text-[10px] text-slate-500 px-1">
        <span>Enter to send, Shift+Enter for new line</span>
        <span>Validation runs before live preview</span>
      </div>
    </div>
  );
}
