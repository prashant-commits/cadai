'use client';

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatMessage } from '@/types';
import { useAppStore } from '@/store/app-store';
import { compileOpenScad } from '@/lib/engine/openscad-bridge';
import { ThinkingIndicator } from './thinking-indicator';
import { Check, Copy, Play, User, Bot, Code } from 'lucide-react';

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const { setCode, setCompileResult, setCompileStatus } = useAppStore();
  const [copied, setCopied] = useState(false);
  const [messageCopied, setMessageCopied] = useState(false);

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
    const result = await compileOpenScad(codeToApply);
    setCompileResult(result);
  };

  const copyMessageButton = (
    <button
      onClick={handleCopyMessage}
      title="Copy message"
      aria-label="Copy message"
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-500 opacity-0 transition-all hover:bg-slate-800 hover:text-slate-300 focus-visible:opacity-100 group-hover:opacity-100"
    >
      {messageCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      <span>{messageCopied ? 'Copied' : 'Copy'}</span>
    </button>
  );

  return (
    <div className={`group flex gap-3 py-4 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
          <Bot className="w-4 h-4 text-white" />
        </div>
      )}

      <div className={`max-w-[88%] space-y-2 ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Progress history (if any was saved with this message) */}
        {message.progressUpdates && message.progressUpdates.length > 0 && (
          <ThinkingIndicator
            activeProgress={null}
            history={message.progressUpdates}
          />
        )}

        {/* Message body */}
        <div
          className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
              : 'bg-slate-900 border border-slate-800 text-slate-200'
          }`}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              h1: ({ children }) => <h1 className="text-base font-bold text-slate-100 mb-2">{children}</h1>,
              h2: ({ children }) => <h2 className="text-sm font-semibold text-slate-100 mb-1.5">{children}</h2>,
              h3: ({ children }) => <h3 className="text-xs font-semibold text-slate-200 mb-1">{children}</h3>,
              ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-1 text-xs">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-1 text-xs">{children}</ol>,
              li: ({ children }) => <li className="text-slate-300">{children}</li>,
              strong: ({ children }) => <strong className="font-semibold text-slate-100">{children}</strong>,
              code: ({ inline, className, children, ...props }: any) => {
                const match = /language-(\w+)/.exec(className || '');
                const language = match ? match[1] : '';
                const codeString = String(children).replace(/\n$/, '');

                if (!inline && (language === 'openscad' || language === 'scad' || codeString.includes('cube(') || codeString.includes('cylinder('))) {
                  return (
                    <div className="my-3 rounded-lg overflow-hidden border border-slate-800 bg-slate-950">
                      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900/90 border-b border-slate-800 text-xs">
                        <div className="flex items-center gap-1.5 text-indigo-400 font-mono">
                          <Code className="w-3.5 h-3.5" />
                          <span>OpenSCAD</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleCopy(codeString)}
                            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                          >
                            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                            <span>{copied ? 'Copied' : 'Copy'}</span>
                          </button>
                          <button
                            onClick={() => handleApplyCode(codeString)}
                            className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition-colors"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            <span>Render</span>
                          </button>
                        </div>
                      </div>
                      <pre className="p-3 text-xs font-mono text-cyan-300 overflow-x-auto max-h-60 bg-slate-950/80">
                        <code>{codeString}</code>
                      </pre>
                    </div>
                  );
                }

                return (
                  <code className="bg-slate-800/80 px-1.5 py-0.5 rounded text-xs font-mono text-indigo-300" {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>

        <div className={`flex items-center gap-1 px-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
          {isUser && copyMessageButton}
          <span className="text-[10px] text-slate-500">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {!isUser && copyMessageButton}
        </div>
      </div>

      {isUser && (
        <div className="w-7 h-7 rounded-lg bg-indigo-600/80 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
          <User className="w-4 h-4 text-white" />
        </div>
      )}
    </div>
  );
}
