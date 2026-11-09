'use client';

import React, { useRef, useEffect, useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { MessageBubble } from './message-bubble';
import { ChatInput } from './chat-input';
import { ThreadDrawer } from './thread-drawer';
import { VersionList } from './version-list';
import { freezeStreamingMessages } from '@/lib/chat/chat-messages';
import { isServerThreadId } from '@/lib/client/server-thread';
import { LEGACY } from '@/lib/persist/phrases';
import {
  FolderKanban,
  Plus,
  Edit2,
  Check,
  Loader2,
  Square,
} from 'lucide-react';

export function ChatPanel() {
  const {
    messages,
    isGenerating,
    generatingThreadId,
    inFlightRunId,
    runsByThread,
    threads,
    activeThreadId,
    createNewThread,
    renameThread,
    initializeFromStorage,
    updateMessage,
    sendMessage,
    stopCurrentRun,
  } = useAppStore();

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize threads from IndexedDB on client mount
  useEffect(() => {
    void initializeFromStorage();
  }, [initializeFromStorage]);

  // Runs after storage has populated the store, and again on every thread switch.
  useEffect(() => {
    if (!activeThreadId) return;
    const thread = threads.find((t) => t.id === activeThreadId);
    if (!thread) return;

    for (const frozen of freezeStreamingMessages(thread.messages)) {
      const original = thread.messages.find((m) => m.id === frozen.id);
      if (original && original.status !== frozen.status) {
        updateMessage(frozen.id, { status: frozen.status, content: frozen.content }, activeThreadId);
      }
    }
    // `threads` is intentionally absent: this must react to the thread CHANGING,
    // not to every message mutation during a live stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const activeRunId = runsByThread?.[activeThreadId] ?? inFlightRunId;
  const isCurrentThreadGenerating = Boolean(runsByThread?.[activeThreadId]) || (isGenerating && generatingThreadId === activeThreadId);
  const isLegacy = activeThread ? !isServerThreadId(activeThread.id) : false;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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

  const handleSendMessage = async (
    userText: string,
    attachment?: { id: string; kind: 'markup' | 'reference'; localUrl: string } | string
  ) => {
    if (isLegacy || isGenerating) return;
    await sendMessage(userText, attachment);
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
              <span className="truncate">{activeThread?.title || 'New design'}</span>
              <Edit2 className="w-3 h-3 opacity-0 group-hover:opacity-100 text-slate-500 transition-opacity shrink-0" />
              {isCurrentThreadGenerating && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="flex items-center gap-1 text-[10px] text-indigo-400 font-mono">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Generating...</span>
                  </span>
                  {activeRunId && (
                    <button
                      onClick={() => void stopCurrentRun()}
                      aria-label="Stop"
                      title="Stop"
                      className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <Square className="w-2.5 h-2.5 fill-current" />
                      <span>Stop</span>
                    </button>
                  )}
                </div>
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

      {/* Legacy Thread Banner */}
      {isLegacy && (
        <div
          role="alert"
          className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2.5 text-xs text-amber-300 font-medium text-center"
        >
          {LEGACY}
        </div>
      )}

      {/* Version List */}
      {!isLegacy && activeThread?.versions && activeThread.versions.length > 0 && (
        <VersionList />
      )}

      {/* Message List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <ChatInput
        onSendMessage={handleSendMessage}
        onStop={() => void stopCurrentRun()}
        disabled={isCurrentThreadGenerating || isLegacy}
        isGenerating={isCurrentThreadGenerating}
      />
    </div>
  );
}
