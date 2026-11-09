'use client';

import React, { useRef, useEffect } from 'react';
import { useAppStore } from '@/store/app-store';
import { MessageBubble } from './message-bubble';
import { ChatInput } from './chat-input';
import { ThreadsMenu } from './threads-menu';
import { freezeStreamingMessages } from '@/lib/chat/chat-messages';
import { isServerThreadId } from '@/lib/client/server-thread';
import { LEGACY } from '@/lib/persist/phrases';
import { cn } from '@/lib/utils';

/** The scrollTop that centers `el` inside a scroll container whose top edge is at `containerTop`. */
export function centeredScrollTop(
  containerTop: number,
  el: { top: number; height: number },
  scrollTop: number,
  clientHeight: number
): number {
  return Math.max(0, el.top - containerTop + scrollTop - clientHeight / 2 + el.height / 2);
}

export function ChatPanel() {
  const {
    messages,
    isGenerating,
    generatingThreadId,
    runsByThread,
    threads,
    activeThreadId,
    highlightedVersion,
    initializeFromStorage,
    updateMessage,
    sendMessage,
    stopCurrentRun,
  } = useAppStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

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
  const isCurrentThreadGenerating =
    Boolean(runsByThread?.[activeThreadId]) ||
    (isGenerating && generatingThreadId === activeThreadId);
  const isLegacy = activeThread ? !isServerThreadId(activeThread.id) : false;

  // Scroll the message list itself. scrollIntoView would also scroll every clipped ancestor (the floating panel,
  // the workspace root) and shift the whole layout.
  const scrollToBottom = () => {
    const c = messagesRef.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Scroll highlighted message into view when inspector highlights a version
  useEffect(() => {
    if (highlightedVersion == null) return;
    const c = messagesRef.current;
    const el = c?.querySelector<HTMLElement>(`[data-design-version="${highlightedVersion}"]`);
    if (!c || !el) return;
    c.scrollTo({
      top: centeredScrollTop(c.getBoundingClientRect().top, el.getBoundingClientRect(), c.scrollTop, c.clientHeight),
      behavior: 'smooth',
    });
  }, [highlightedVersion]);

  const showPromptChips =
    messages.length === 0 ||
    (messages.length === 1 && messages[0].id === 'welcome-msg');

  const handleSendMessage = async (
    userText: string,
    attachment?: { id: string; kind: 'markup' | 'reference'; localUrl: string } | string
  ) => {
    if (isLegacy || isGenerating) return;
    await sendMessage(userText, attachment);
  };

  return (
    <div className="relative h-full flex flex-col bg-transparent">
      {/* Header with ThreadsMenu on the left, leaving ~44px on the right (pr-12) for Hide button */}
      <div className="px-3.5 py-2 border-b border-border flex items-center justify-between pr-12 select-none min-h-[44px]">
        <ThreadsMenu />
      </div>

      {/* Legacy Thread Banner */}
      {isLegacy && (
        <div
          role="alert"
          className="bg-destructive/10 border-b border-destructive/20 px-4 py-2.5 text-xs text-destructive font-medium text-center"
        >
          {LEGACY}
        </div>
      )}

      {/* Message List */}
      <div ref={messagesRef} data-slot="chat-messages" className="flex-1 overflow-y-auto p-4 space-y-2">
        {messages.map((msg) => {
          const isHighlighted =
            msg.designVersion !== undefined &&
            msg.designVersion !== null &&
            highlightedVersion === msg.designVersion;

          return (
            <div
              key={msg.id}
              data-design-version={
                msg.designVersion !== undefined && msg.designVersion !== null
                  ? msg.designVersion
                  : undefined
              }
              data-highlighted={isHighlighted ? 'true' : undefined}
              className={cn(
                'transition-all duration-200 rounded-2xl',
                isHighlighted && 'ring-1 ring-primary'
              )}
            >
              <MessageBubble message={msg} />
            </div>
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <ChatInput
        onSendMessage={handleSendMessage}
        onStop={() => void stopCurrentRun()}
        disabled={isCurrentThreadGenerating || isLegacy}
        isGenerating={isCurrentThreadGenerating}
        showPromptChips={showPromptChips}
      />
    </div>
  );
}
