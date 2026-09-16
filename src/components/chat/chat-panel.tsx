'use client';

import React, { useRef, useEffect, useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { MessageBubble } from './message-bubble';
import { ChatInput } from './chat-input';
import { ThreadDrawer } from './thread-drawer';
import { GateDock } from './gate-dock';
import { readStream } from '@/lib/stream-reader';
import { serializeTranscript } from '@/lib/agent/transcript';
import { resumableGate, freezeStreamingMessages } from '@/lib/chat/rehydrate';
import { compileOpenScad } from '@/lib/engine/openscad-bridge';
import { parseStlToGeometry } from '@/lib/engine/geometry-utils';
import { ChatMessage, GatePayload, GateDecision, GateRecord } from '@/types';
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
    selectedModel,
    threads,
    activeThreadId,
    createNewThread,
    renameThread,
    initializeFromStorage,
    setCode,
    setCompileResult,
    setThreadContract,
    setCompileStatus,
    updateMessage,
  } = useAppStore();

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState('');
  const [pendingGate, setPendingGate] = useState<GatePayload | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  // The message a resumed run must continue appending to.
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize threads from IndexedDB on client mount
  useEffect(() => {
    void initializeFromStorage();
  }, [initializeFromStorage]);

  // Runs after storage has populated the store, and again on every thread
  // switch: a gate left open in another thread must not stay docked here.
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

    const open = resumableGate(thread.messages);
    setPendingGate(open?.gate ?? null);
    setPendingRunId(open?.runId ?? null);
    setPendingMessageId(open?.messageId ?? null);
    // `threads` is intentionally absent: this must react to the thread
    // CHANGING, not to every message mutation during a live stream, which
    // would re-dock a gate the user just answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const isCurrentThreadGenerating = isGenerating && generatingThreadId === activeThreadId;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, pendingGate]);

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

  // Renders an accept gate's candidate mesh into the viewport so the human is
  // judging the actual part rather than three numbers. Spec gates carry no
  // geometry yet, so they are a no-op here.
  const showGateGeometry = (gate: GatePayload | null | undefined, threadId: string) => {
    if (!gate || gate.kind !== 'accept') return;
    const stl = gate.stl;
    if (!stl || !stl.includes('facet normal')) return;
    try {
      const { geometry, modelInfo } = parseStlToGeometry(stl);
      setCompileResult(
        { success: true, stlContent: stl, geometry, modelInfo, compileTimeMs: 0 },
        threadId
      );
    } catch (e) {
      // A mesh we cannot parse must not take the gate down with it - the
      // numeric summary in the gate card still stands on its own.
      console.error('Failed to render gate geometry:', e);
    }
  };

  /** The one gate still awaiting a decision, if any. */
  function firstOpenGate(gates: Record<string, GateRecord>): GatePayload | null {
    for (const record of Object.values(gates)) {
      if (record.status === 'open') return record.payload;
    }
    return null;
  }

  /**
   * Drives one stream into ONE assistant message.
   *
   * The message is created when the stream opens and mutated as it grows,
   * because a turn that pauses at a gate spans two HTTP requests and both
   * halves belong to the same message.
   */
  const consumeStream = async (
    response: Response,
    targetThreadId: string,
    messageId: string
  ) => {
    // Persisting on every token would thrash IndexedDB, so the flush is
    // debounced and forced once at the end.
    let lastFlush = 0;
    const FLUSH_MS = 250;

    await readStream(response, {
      onUpdate: (state) => {
        const now = Date.now();
        if (now - lastFlush < FLUSH_MS) return;
        lastFlush = now;
        updateMessage(messageId, { transcript: serializeTranscript(state.nodes) }, targetThreadId);
      },
      onDone: async (state) => {
        const status = state.error
          ? 'error'
          : state.awaitingInput
            ? 'awaiting_input'
            : 'complete';

        updateMessage(
          messageId,
          {
            transcript: serializeTranscript(state.nodes),
            gates: Object.keys(state.gates).length ? state.gates : undefined,
            content: state.error ? `**Error:** ${state.error}` : state.summary,
            code: state.code,
            runId: state.runId,
            status,
          },
          targetThreadId
        );

        if (state.designContract) setThreadContract(state.designContract, targetThreadId);

        if (state.awaitingInput) {
          const open = firstOpenGate(state.gates);
          setPendingGate(open);
          setPendingRunId(state.runId ?? null);
          setPendingMessageId(messageId);
          showGateGeometry(open, targetThreadId);
          setIsGenerating(false);
          setGeneratingThreadId(null);
          return;
        }

        if (state.code) {
          setCode(state.code, targetThreadId);
          if (state.stl && state.stl.includes('facet normal')) {
            const { geometry, modelInfo } = parseStlToGeometry(state.stl);
            setCompileResult(
              { success: true, stlContent: state.stl, geometry, modelInfo, compileTimeMs: 0 },
              targetThreadId
            );
          } else {
            if (useAppStore.getState().activeThreadId === targetThreadId) setCompileStatus('compiling');
            setCompileResult(await compileOpenScad(state.code), targetThreadId);
          }
        }

        setIsGenerating(false);
        setGeneratingThreadId(null);
      },
    });
  };

  const handleSendMessage = async (userText: string, image?: string) => {
    const targetThreadId = activeThreadId;
    // An annotated screenshot on its own is a valid turn - the input enables
    // submit for image-without-text, so this guard must accept it too.
    if ((!userText.trim() && !image) || isGenerating || !targetThreadId) return;

    // 1. Add user message to target thread
    const userMsgId = 'user-' + Date.now();
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: userText,
      image,
      timestamp: Date.now(),
    };
    addMessage(userMsg, targetThreadId);

    // 2. Prepare assistant placeholder
    const assistantMsgId = 'assistant-' + Date.now();

    setIsGenerating(true);
    setGeneratingThreadId(targetThreadId);

    // Snapshot target thread messages up to this point
    const targetThreadObj = threads.find((t) => t.id === targetThreadId);
    const existingMessages = targetThreadObj ? targetThreadObj.messages : messages;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // `image` must survive this mapping: /api/chat turns it into the
          // image_url content block (route.ts:33-40) that is the only way
          // geometry feedback reaches the model.
          messages: [...existingMessages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
            image: m.image,
          })),
          model: selectedModel,
          threadId: targetThreadId,
          designContract: targetThreadObj?.designContract ?? null,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server responded with HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response stream received.');
      }

      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        transcript: '',
        status: 'streaming',
        timestamp: Date.now(),
      };
      addMessage(assistantMsg, targetThreadId);

      await consumeStream(response, targetThreadId, assistantMsgId);

    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      updateMessage(assistantMsgId, { content: `**Error:** ${errorMessage}`, status: 'error' }, targetThreadId);
      setIsGenerating(false);
      setGeneratingThreadId(null);
    }
  };

  const handleResume = async (decision: GateDecision) => {
    const targetThreadId = activeThreadId;
    const targetRunId = pendingRunId;
    const messageId = pendingMessageId;
    if (!targetThreadId || !targetRunId || !messageId) return;

    const thread = threads.find((t) => t.id === targetThreadId);
    const message = thread?.messages.find((m) => m.id === messageId);
    const gates = { ...(message?.gates ?? {}) };
    const openId = Object.keys(gates).find((k) => gates[k].status === 'open');
    if (openId) {
      gates[openId] = {
        ...gates[openId],
        decision,
        decidedAt: Date.now(),
        status:
          decision.action === 'approve' ? 'approved'
          : decision.action === 'revise' ? 'revised'
          : 'denied',
      };
    }
    updateMessage(messageId, { gates, status: 'streaming', runId: undefined }, targetThreadId);

    setPendingGate(null);
    setPendingRunId(null);
    setPendingMessageId(null);
    setIsGenerating(true);
    setGeneratingThreadId(targetThreadId);

    try {
      const response = await fetch('/api/chat/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          threadId: targetThreadId,
          runId: targetRunId,
          decision,
        }),
      });
      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server responded with HTTP ${response.status}`);
      }
      await consumeStream(response, targetThreadId, messageId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      updateMessage(messageId, { content: `**Resume failed:** ${errorMessage}`, status: 'error' }, targetThreadId);
      setIsGenerating(false);
      setGeneratingThreadId(null);
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

        <div ref={messagesEndRef} />
      </div>

      {/* Gate dock above composer */}
      {pendingGate && <GateDock gate={pendingGate} onResume={handleResume} />}

      {/* Input bar */}
      <ChatInput
        onSendMessage={handleSendMessage}
        disabled={isCurrentThreadGenerating}
      />
    </div>
  );
}
