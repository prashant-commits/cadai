'use client';

import React, { useRef, useEffect, useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { MessageBubble } from './message-bubble';
import { ThinkingIndicator } from './thinking-indicator';
import { ChatInput } from './chat-input';
import { ThreadDrawer } from './thread-drawer';
import { GateInlineUI } from './gate-inline-ui';
import { readStream } from '@/lib/stream-reader';
import { compileOpenScad } from '@/lib/engine/openscad-bridge';
import { parseStlToGeometry } from '@/lib/engine/geometry-utils';
import { extractOpenScadCode } from '@/lib/agent/code-extractor';
import { AgentProgress, ChatMessage, GatePayload, GateDecision } from '@/types';
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
    setThreadContract,
    setCompileStatus,
  } = useAppStore();

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState('');
  const [pendingGate, setPendingGate] = useState(false);
  const [pendingGateData, setPendingGateData] = useState<GatePayload | null>(null);
  // The paused run behind the open gate. Its checkpoint is keyed threadId::runId,
  // so resuming without it would address a checkpoint that does not exist.
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize threads from IndexedDB on client mount
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
  }, [messages, activeProgress, progressHistory, pendingGate, pendingGateData]);

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
          // `image` must survive this mapping: /api/chat turns it into the
          // image_url content block (route.ts:33-40) that is the only way
          // geometry feedback reaches the model.
          messages: [...existingMessages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
            image: m.image,
          })),
          apiKey: apiKey || undefined,
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

      const handleStreamResponse = async (response: Response, currentProgressList: AgentProgress[]) => {
        await readStream(response, targetThreadId, {
          onProgress: (progressItem) => {
            if (progressItem.type === 'awaiting_input') {
              setPendingGateData(progressItem.gate ?? null);
              setPendingRunId(progressItem.runId ?? null);
              setPendingGate(true);
              setIsGenerating(false);
              setGeneratingThreadId(null);
              // Put the candidate mesh in the viewport while the gate is open.
              // The accept gate asks a human to sign off on geometry; without
              // this the viewport still shows the PREVIOUS model and the only
              // evidence is a bounding box and a volume.
              showGateGeometry(progressItem.gate, targetThreadId);
            } else {
              setActiveProgress(progressItem);
              addProgressUpdate(progressItem);
            }
          },
          onFinalize: async (finalCode, finalExplanation, finalStl, _progress, finalContract) => {
            // readStream now suppresses onFinalize entirely while a gate is
            // open, so no guard is needed here. The old `if (pendingGate)`
            // check read a stale render-time closure and never fired.
            if (finalContract) setThreadContract(finalContract, targetThreadId);

            // Fallback code extraction if not explicitly marked
            const extracted = extractOpenScadCode(finalExplanation);
            const resolvedCode = finalCode || extracted.code || '';

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
            
            setIsGenerating(false);
            setGeneratingThreadId(null);
            clearProgress();
          }
        });
      };
      
      await handleStreamResponse(response, currentProgressList);

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
      setIsGenerating(false);
      setGeneratingThreadId(null);
      clearProgress();
    }
  };

  const handleResume = async (decision: GateDecision) => {
    const targetThreadId = activeThreadId;
    if (!targetThreadId) return;

    // Captured before the state resets below; the resume is meaningless
    // without it, so fail loudly rather than posting a request the server
    // will reject.
    const targetRunId = pendingRunId;
    if (!targetRunId) {
      addMessage(
        {
          id: 'assistant-' + Date.now(),
          role: 'assistant',
          content:
            '❌ **CAD AI Error**: Lost track of the paused run, so this review can no longer be applied. Please send your request again.',
          timestamp: Date.now(),
        },
        targetThreadId
      );
      setPendingGate(false);
      setPendingGateData(null);
      return;
    }

    setPendingGate(false);
    setPendingGateData(null);
    setPendingRunId(null);

    // Prepare assistant placeholder and clear old progress steps
    const assistantMsgId = 'assistant-' + Date.now();
    const currentProgressList: AgentProgress[] = [];

    clearProgress();
    setIsGenerating(true);
    setGeneratingThreadId(targetThreadId);

    try {
      const response = await fetch('/api/chat/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKey || undefined,
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

      // Cancel resolves in a single event (no streamed generation follows) -
      // still route it through readStream so the "Cancelled." message lands
      // in the thread the same way any other assistant message would.
      if (decision.action === 'cancel') {
        await readStream(response, targetThreadId, {
          onProgress: () => {},
          onFinalize: (_finalCode, finalExplanation) => {
            addMessage(
              {
                id: assistantMsgId,
                role: 'assistant',
                content: finalExplanation || 'Generation cancelled.',
                timestamp: Date.now(),
              },
              targetThreadId
            );
            setIsGenerating(false);
            setGeneratingThreadId(null);
            clearProgress();
          },
        });
        return;
      }

      const handleStreamResponse = async (response: Response, currentProgressList: AgentProgress[]) => {
        await readStream(response, targetThreadId, {
          onProgress: (progressItem) => {
            if (progressItem.type === 'awaiting_input') {
              setPendingGateData(progressItem.gate ?? null);
              setPendingRunId(progressItem.runId ?? null);
              setPendingGate(true);
              setIsGenerating(false);
              setGeneratingThreadId(null);
              // Put the candidate mesh in the viewport while the gate is open.
              // The accept gate asks a human to sign off on geometry; without
              // this the viewport still shows the PREVIOUS model and the only
              // evidence is a bounding box and a volume.
              showGateGeometry(progressItem.gate, targetThreadId);
            } else {
              setActiveProgress(progressItem);
              addProgressUpdate(progressItem);
            }
          },
          onFinalize: async (finalCode, finalExplanation, finalStl, _progress, finalContract) => {
            // Same as the send path: readStream suppresses this while a gate
            // is open. The old guard checked an activeProgress value that the
            // awaiting_input branch never sets, so it never fired either.
            if (finalContract) setThreadContract(finalContract, targetThreadId);

            // Fallback code extraction if not explicitly marked
            const extracted = extractOpenScadCode(finalExplanation);
            const resolvedCode = finalCode || extracted.code || '';

            // Add final assistant message targeting targetThreadId
            const assistantMsg: ChatMessage = {
              id: assistantMsgId,
              role: 'assistant',
              content: finalExplanation || 'Model generation resumed and completed.',
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
            
            setIsGenerating(false);
            setGeneratingThreadId(null);
            clearProgress();
          }
        });
      };
      
      await handleStreamResponse(response, currentProgressList);

    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      addMessage(
        {
          id: assistantMsgId,
          role: 'assistant',
          content: `❌ **CAD AI Resume Error**: ${errorMessage}`,
          timestamp: Date.now(),
        },
        targetThreadId
      );
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

        {/* The gate belongs IN the transcript, not in a band above the
            composer. It is the agent's turn - it follows the run that produced
            it, scrolls with the conversation, and reads as the thing the user
            is answering rather than as detached chrome. */}
        {pendingGate && <GateInlineUI gate={pendingGateData} onResume={handleResume} />}

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
