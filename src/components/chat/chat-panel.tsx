'use client';

import React, { useRef, useEffect, useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { MessageBubble } from './message-bubble';
import { ThinkingIndicator } from './thinking-indicator';
import { ChatInput } from './chat-input';
import { ThreadDrawer } from './thread-drawer';
import { compileOpenScad } from '@/lib/engine/openscad-bridge';
import { parseStlToGeometry } from '@/lib/engine/geometry-utils';
import { extractOpenScadCode } from '@/lib/agent/code-extractor';
import { AgentProgress, ChatMessage } from '@/types';
import {
  FolderKanban,
  Plus,
  Edit2,
  Check,
  Loader2,
} from 'lucide-react';

export function ChatPanel() {
  const {
    messages,
    addMessage,
    isGenerating,
    setIsGenerating,
    generatingThreadId,
    setGeneratingThreadId,
    activeProgress,
    setActiveProgress,
    addProgressUpdate,
    clearProgress,
    progressHistory,
    apiKey,
    selectedModel,
    threads,
    activeThreadId,
    createNewThread,
    renameThread,
    initializeFromStorage,
    setCode,
    setCompileResult,
    setCompileStatus,
  } = useAppStore();

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize threads from localStorage on client mount
  useEffect(() => {
    initializeFromStorage();
  }, [initializeFromStorage]);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const isCurrentThreadGenerating = isGenerating && generatingThreadId === activeThreadId;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, activeProgress, progressHistory]);

  const handleStartRename = () => {
    if (activeThread) {
      setTempTitle(activeThread.title);
      setIsEditingTitle(true);
    }
  };

  const handleSaveRename = () => {
    if (activeThread && tempTitle.trim()) {
      renameThread(activeThread.id, tempTitle.trim());
    }
    setIsEditingTitle(false);
  };

  const handleSendMessage = async (userText: string) => {
    const targetThreadId = activeThreadId;
    if (!userText.trim() || isGenerating || !targetThreadId) return;

    // 1. Add user message to target thread
    const userMsgId = 'user-' + Date.now();
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: userText,
      timestamp: Date.now(),
    };
    addMessage(userMsg, targetThreadId);

    // 2. Prepare assistant placeholder and clear old progress steps
    const assistantMsgId = 'assistant-' + Date.now();
    const currentProgressList: AgentProgress[] = [];

    clearProgress();
    setIsGenerating(true);
    setGeneratingThreadId(targetThreadId);

    const initialProgress: AgentProgress = {
      id: 'step-init-' + Date.now(),
      type: 'thinking',
      message: 'Connecting to CAD AI Agent...',
      timestamp: Date.now(),
    };
    setActiveProgress(initialProgress);
    addProgressUpdate(initialProgress);
    currentProgressList.push(initialProgress);

    // Snapshot target thread messages up to this point
    const targetThreadObj = threads.find((t) => t.id === targetThreadId);
    const existingMessages = targetThreadObj ? targetThreadObj.messages : messages;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...existingMessages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          apiKey: apiKey || undefined,
          model: selectedModel,
          threadId: targetThreadId,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server responded with HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response stream received.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let buffer = '';
      let finalCode = '';
      let finalExplanation = '';
      let finalStl = '';

      while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              const dataStr = trimmed.substring(6);
              try {
                const event = JSON.parse(dataStr);

                const progressItem: AgentProgress = {
                  id: 'progress-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
                  type: event.type,
                  message: event.message,
                  timestamp: event.timestamp || Date.now(),
                  details: event.details,
                };

                setActiveProgress(progressItem);
                addProgressUpdate(progressItem);
                currentProgressList.push(progressItem);

                if (event.type === 'ready') {
                  if (event.code) finalCode = event.code;
                  if (event.stl) finalStl = event.stl;
                  finalExplanation = event.explanation || event.message;
                } else if (event.type === 'error') {
                  finalExplanation = event.explanation || event.message;
                }
              } catch (parseErr) {
                console.error('Error parsing SSE event:', parseErr);
              }
            }
          }
        }
      }

      // Fallback code extraction if not explicitly marked
      const resolvedCode = finalCode || extractOpenScadCode(finalExplanation) || '';

      // Add final assistant message targeting targetThreadId
      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: finalExplanation || 'Model generation completed.',
        code: resolvedCode || undefined,
        progressUpdates: currentProgressList,
        timestamp: Date.now(),
      };
      addMessage(assistantMsg, targetThreadId);

      // Render 3D model targeting targetThreadId
      if (resolvedCode) {
        setCode(resolvedCode, targetThreadId);

        // If STL was already generated in validation on server, parse directly
        if (finalStl && finalStl.includes('facet normal')) {
          const { geometry, modelInfo } = parseStlToGeometry(finalStl);
          setCompileResult(
            {
              success: true,
              stlContent: finalStl,
              geometry,
              modelInfo,
              compileTimeMs: 0,
            },
            targetThreadId
          );
        } else {
          // Otherwise compile via WASM bridge
          if (useAppStore.getState().activeThreadId === targetThreadId) {
            setCompileStatus('compiling');
          }
          const compileResult = await compileOpenScad(resolvedCode);
          setCompileResult(compileResult, targetThreadId);
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      addMessage(
        {
          id: assistantMsgId,
          role: 'assistant',
          content: `❌ **CAD AI Error**: ${errorMessage}\n\nPlease check your Google Gemini API key or try refining your prompt.`,
          timestamp: Date.now(),
        },
        targetThreadId
      );
    } finally {
      setIsGenerating(false);
      setGeneratingThreadId(null);
      clearProgress();
    }
  };

  return (
    <div className="relative h-full flex flex-col bg-slate-950">
      {/* Thread Drawer Overlay */}
      <ThreadDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
      />

      {/* Header with Thread Title & Drawer toggle */}
      <div className="px-3.5 py-2 border-b border-slate-800 flex items-center justify-between bg-slate-900/60 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => setIsDrawerOpen(!isDrawerOpen)}
            className="p-1 rounded-md bg-slate-800/80 hover:bg-slate-700 text-slate-300 transition-colors flex items-center gap-1.5 text-xs shrink-0 cursor-pointer"
            title="View saved design threads"
          >
            <FolderKanban className="w-3.5 h-3.5 text-indigo-400" />
            <span className="font-mono text-[11px] hidden sm:inline">Threads</span>
          </button>

          {/* Active Thread Title */}
          {isEditingTitle ? (
            <div className="flex items-center gap-1 min-w-0">
              <input
                type="text"
                value={tempTitle}
                onChange={(e) => setTempTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveRename()}
                className="bg-slate-950 border border-indigo-500 rounded px-1.5 py-0.5 text-xs text-slate-100 focus:outline-none font-semibold w-40"
                autoFocus
              />
              <button
                onClick={handleSaveRename}
                className="p-1 rounded bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer"
              >
                <Check className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <div
              onClick={handleStartRename}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-200 truncate cursor-pointer hover:text-indigo-300 transition-colors group"
              title="Click to rename design thread"
            >
              <span className="truncate">{activeThread?.title || 'Design'}</span>
              <Edit2 className="w-3 h-3 opacity-0 group-hover:opacity-100 text-slate-500 transition-opacity shrink-0" />
              {isCurrentThreadGenerating && (
                <span className="flex items-center gap-1 text-[10px] text-indigo-400 font-mono shrink-0">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Generating...</span>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Quick New Design button */}
        <button
          onClick={() => createNewThread()}
          className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800/80 hover:bg-slate-700 text-indigo-300 hover:text-indigo-200 text-xs font-medium transition-colors shrink-0 cursor-pointer"
          title="Start a new 3D design"
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="text-[11px] hidden sm:inline">New</span>
        </button>
      </div>

      {/* Message List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Live Active Progress Card only for current generating thread */}
        {isCurrentThreadGenerating && activeProgress && (
          <ThinkingIndicator
            activeProgress={activeProgress}
            history={progressHistory}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <ChatInput
        onSendMessage={handleSendMessage}
        disabled={isCurrentThreadGenerating}
      />
    </div>
  );
}
