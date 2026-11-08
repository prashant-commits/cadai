import { create } from 'zustand';
import * as THREE from 'three';
import { ChatMessage, ModelInfo, ViewportSettings, CompileResult, ChatThread, ScadParam, ContractDiff, ParamValue, StandingConstraints, DesignContract } from '@/types';
import {
  DEFAULT_CODE,
  clearThreadMessages,
  createInitialThread,
  deleteThreadCascade,
  loadAllThreads,
  setActiveThreadId,
  setCodeDebounced,
  upsertMessage,
  upsertThread,
} from '@/lib/storage/thread-storage';
import { applyContract } from '@/lib/design/contract';
import { parseParams } from '@/lib/design/parse-params';
import { toBody } from '@/lib/brep/prelude';
import { setParamValue } from '@/lib/design/write-params';
import { compileModel } from '@/lib/engine/build123d-client';
import { DEFAULT_MODEL } from '@/lib/agent/models';
import {
  listThreads,
  getThread,
  renameThread as renameServerThread,
  deleteThread as deleteServerThread,
  stopRun,
  tailRun,
  sendChat,
  buildChatRequest,
  getLatestViewingVersion,
  isServerThreadId,
  fetchArtifactText,
  uploadAttachment,
  type ServerThreadDetail,
} from '@/lib/client/server-thread';
import { parseStlToGeometry } from '@/lib/engine/geometry-utils';
import { readStream, streamMessagePatch } from '@/lib/stream-reader';
import { serializeTranscript } from '@/lib/agent/transcript';
import { BAD_ATTACHMENT } from '@/lib/persist/phrases';

function dataUrlToBlob(dataUrlOrBytes: string): Blob {
  if (!dataUrlOrBytes.startsWith('data:')) {
    return new Blob([dataUrlOrBytes], { type: 'image/png' });
  }
  const parts = dataUrlOrBytes.split(',');
  const byteString = atob(parts[1] || parts[0]);
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  const u8arr = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    u8arr[i] = byteString.charCodeAt(i);
  }
  return new Blob([u8arr], { type: mimeType });
}

interface AppState {
  selectedModel: string;
  threads: ChatThread[];
  activeThreadId: string;

  // Active Thread Data (mirrored for fast access)
  messages: ChatMessage[];
  code: string;
  geometry: THREE.BufferGeometry | null;
  stlContent: string | null;
  modelInfo: ModelInfo | null;
  step: string | null;
  
  // Design Contract & Parameters
  params: ScadParam[];
  contractDiff: ContractDiff | null;
  editorView: 'code' | 'design';

  // Runtime State & Generation
  isGenerating: boolean;
  generatingThreadId: string | null;
  inFlightRunId: string | null;
  compileStatus: 'idle' | 'compiling' | 'success' | 'error';
  compileError: string | null;
  compileTimeMs: number;
  viewportSettings: ViewportSettings;

  // Annotation & Input State
  isAnnotating: boolean;
  baseSnapshot: string | null;
  pendingAttachment: string | null;

  // Thread Actions
  createNewThread: (title?: string) => string;
  switchThread: (threadId: string) => void;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => void;

  // Settings & State Actions
  setSelectedModel: (model: string) => void;
  addMessage: (message: ChatMessage, threadId?: string) => void;
  updateMessage: (id: string, partial: Partial<ChatMessage>, threadId?: string) => void;
  setIsGenerating: (isGenerating: boolean) => void;
  setGeneratingThreadId: (threadId: string | null) => void;
  setInFlightRunId: (runId: string | null) => void;
  stopCurrentRun: () => Promise<void>;
  loadServerThread: (threadId: string) => Promise<ServerThreadDetail | null>;
  consumeRunStream: (opts: {
    response: Response;
    threadId: string;
    runId: string;
    reconnectCount?: number;
  }) => Promise<void>;
  sendMessage: (text: string, image?: string) => Promise<void>;
  setCode: (code: string, threadId?: string, source?: 'user' | 'agent') => void;
  setCompileResult: (result: CompileResult, threadId?: string) => void;
  setCompileStatus: (status: 'idle' | 'compiling' | 'success' | 'error', error?: string | null) => void;
  updateViewportSettings: (settings: Partial<ViewportSettings>) => void;
  
  // Editor View & Contract
  setEditorView: (view: 'code' | 'design') => void;
  pinParam: (name: string, value: ParamValue) => void;
  unpinParam: (name: string) => void;
  unpinAll: () => void;
  setStanding: (partial: Partial<StandingConstraints>) => void;
  /** Persist the contract the agent returned (carries the human-approved spec). */
  setThreadContract: (contract: DesignContract, threadId?: string) => void;
  dismissContractDiff: () => void;
  
  setIsAnnotating: (isAnnotating: boolean) => void;
  setBaseSnapshot: (snapshot: string | null) => void;
  setPendingAttachment: (image: string | null) => void;

  resetProject: () => void;
  initializeFromStorage: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  selectedModel: DEFAULT_MODEL,
  threads: [],
  activeThreadId: '',

  messages: [],
  code: DEFAULT_CODE,
  geometry: null,
  stlContent: null,
  modelInfo: null,
  step: null,
  params: [],
  contractDiff: null,
  editorView: 'design',

  isGenerating: false,
  generatingThreadId: null,
  inFlightRunId: null,
  compileStatus: 'idle',
  compileError: null,
  compileTimeMs: 0,
  isAnnotating: false,
  baseSnapshot: null,
  pendingAttachment: null,
  viewportSettings: {
    showGrid: true,
    showAxes: true,
    wireframe: false,
    isOrthographic: false,
    showEdges: true,
    autoRotate: false,
  },

  setInFlightRunId: (runId) => set({ inFlightRunId: runId }),

  stopCurrentRun: async () => {
    const runId = get().inFlightRunId;
    if (!runId) return;

    try {
      const res = await stopRun(runId);
      if (res.status === 202) {
        // 202 means "stopping": keep reading the stream; the end event (STOPPED) follows.
        return;
      }
      if (res.status === 200) {
        // 200 means it ended: reload the thread.
        const activeThreadId = get().activeThreadId;
        if (activeThreadId) {
          await get().loadServerThread(activeThreadId);
        }
        set({
          isGenerating: false,
          generatingThreadId: null,
          inFlightRunId: null,
        });
      }
    } catch (err) {
      console.warn('Failed to stop run:', err);
    }
  },

  loadServerThread: async (threadId: string) => {
    if (!isServerThreadId(threadId)) return null;

    let serverThread: ServerThreadDetail | null = null;
    let isNotFound = false;
    try {
      serverThread = await getThread(threadId);
      if (serverThread === null) {
        isNotFound = true;
      }
    } catch (err) {
      console.warn(`Failed to fetch thread ${threadId}:`, err);
      return null;
    }

    if (isNotFound) {
      // 404: thread was deleted on server
      const { threads } = get();
      const remaining = threads.filter((t) => t.id !== threadId);
      void deleteThreadCascade(threadId);
      if (remaining.length > 0) {
        const nextActive = remaining[0];
        set({
          threads: remaining,
          activeThreadId: nextActive.id,
          messages: nextActive.messages,
          code: nextActive.code || DEFAULT_CODE,
          stlContent: nextActive.stlContent || null,
          geometry: null,
          modelInfo: nextActive.modelInfo || null,
          step: nextActive.step || null,
          isGenerating: false,
          generatingThreadId: null,
          inFlightRunId: null,
        });
        void setActiveThreadId(nextActive.id);
        if (isServerThreadId(nextActive.id)) {
          void get().loadServerThread(nextActive.id);
        }
      } else {
        set({
          threads: [],
        });
        get().createNewThread();
      }
      return null;
    }

    if (!serverThread) {
      return null;
    }

    const { threads, activeThreadId } = get();
    const currentThread = threads.find((t) => t.id === threadId);

    const mappedMessages: ChatMessage[] =
      serverThread.messages.length > 0
        ? serverThread.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.markdown,
            status: 'complete',
            timestamp: Date.now(),
          }))
        : currentThread?.messages || [];

    let newCode = currentThread?.code || DEFAULT_CODE;
    let newStl = currentThread?.stlContent || null;
    let newGeometry: THREE.BufferGeometry | null =
      threadId === activeThreadId ? get().geometry : null;
    let newModelInfo = currentThread?.modelInfo || null;
    let newStep = currentThread?.step || null;

    if (serverThread.versions && serverThread.versions.length > 0) {
      // Stale STEP: when loadServerThread shows a server version, set step to null
      newStep = null;
      const latest = serverThread.versions.reduce(
        (max, v) => (v.version > max.version ? v : max),
        serverThread.versions[0]
      );
      newCode = latest.body;

      if (latest.stl) {
        try {
          const stlText = await fetchArtifactText(latest.stl);
          newStl = stlText;
          if (stlText.includes('facet normal')) {
            const parsed = parseStlToGeometry(stlText);
            newGeometry = parsed.geometry;
            newModelInfo = parsed.modelInfo;
          }
        } catch (err) {
          console.warn('Failed to fetch artifact for version:', err);
        }
      } else {
        if (threadId === activeThreadId) {
          set({ compileStatus: 'compiling' });
        }
        try {
          const res = await compileModel(latest.body);
          newStl = res.stlContent || null;
          newGeometry = res.geometry || null;
          newModelInfo = res.modelInfo || null;
        } catch (err) {
          console.warn('Failed to compile version with null stl:', err);
        }
      }
    }

    const updatedThread: ChatThread = {
      id: serverThread.id,
      title: serverThread.title || currentThread?.title || 'Design',
      createdAt: currentThread?.createdAt || Date.now(),
      updatedAt: Date.now(),
      messages: mappedMessages,
      code: newCode,
      stlContent: newStl,
      modelInfo: newModelInfo,
      step: newStep,
      activeRunId: serverThread.activeRun?.id || null,
      versions: serverThread.versions,
      selectedModel: currentThread?.selectedModel || get().selectedModel,
    };

    const updatedThreads = threads.map((t) => (t.id === threadId ? updatedThread : t));
    if (!updatedThreads.some((t) => t.id === threadId)) {
      updatedThreads.push(updatedThread);
    }

    if (threadId === activeThreadId) {
      set({
        threads: updatedThreads,
        messages: mappedMessages,
        code: newCode,
        params: parseParams(toBody(newCode)),
        stlContent: newStl,
        geometry: newGeometry,
        modelInfo: newModelInfo,
        step: newStep,
        compileStatus: 'idle',
        compileError: null,
      });
    } else {
      set({ threads: updatedThreads });
    }

    void upsertThread(updatedThread);
    mappedMessages.forEach((m) => void upsertMessage(threadId, m));

    if (
      serverThread.activeRun &&
      serverThread.activeRun.status === 'running' &&
      !get().isGenerating
    ) {
      const runId = serverThread.activeRun.id;
      try {
        const tailRes = await tailRun(runId, 0);
        await get().consumeRunStream({
          response: tailRes,
          threadId,
          runId,
        });
      } catch (err) {
        console.warn('Failed to tail active run:', err);
      }
    }

    return serverThread;
  },

  consumeRunStream: async ({
    response,
    threadId,
    runId,
    reconnectCount = 0,
  }: {
    response: Response;
    threadId: string;
    runId: string;
    reconnectCount?: number;
  }) => {
    set({
      isGenerating: true,
      generatingThreadId: threadId,
      inFlightRunId: runId,
    });

    const { threads } = get();
    const thread = threads.find((t) => t.id === threadId);
    const assistantMsg = thread?.messages.find((m) => m.status === 'streaming');
    const assistantMsgId = assistantMsg ? assistantMsg.id : 'assistant-' + Date.now();
    if (!assistantMsg) {
      get().addMessage(
        {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          transcript: '',
          status: 'streaming',
          runId,
          timestamp: Date.now(),
        },
        threadId
      );
    }

    let seenEnd = false;
    let lastFlush = 0;
    const FLUSH_MS = 250;

    try {
      await readStream(response, {
        onUpdate: (state) => {
          const now = Date.now();
          if (now - lastFlush < FLUSH_MS) return;
          lastFlush = now;
          get().updateMessage(
            assistantMsgId,
            { transcript: serializeTranscript(state.nodes) },
            threadId
          );
        },
        onDone: async (state) => {
          if (state.endEvent || state.summary) {
            seenEnd = true;
          }
          get().updateMessage(
            assistantMsgId,
            streamMessagePatch(state),
            threadId
          );
        },
      });
    } catch (err) {
      console.error('Error during readStream:', err);
    }

    if (seenEnd) {
      await get().loadServerThread(threadId);
      set({
        isGenerating: false,
        generatingThreadId: null,
        inFlightRunId: null,
      });
    } else {
      const reloaded = await get().loadServerThread(threadId);
      if (
        reloaded &&
        reloaded.activeRun &&
        reloaded.activeRun.status === 'running' &&
        reconnectCount < 1
      ) {
        try {
          const tailRes = await tailRun(reloaded.activeRun.id, 0);
          await get().consumeRunStream({
            response: tailRes,
            threadId,
            runId: reloaded.activeRun.id,
            reconnectCount: reconnectCount + 1,
          });
        } catch (err) {
          console.warn('Failed to reconnect tail:', err);
          set({
            isGenerating: false,
            generatingThreadId: null,
            inFlightRunId: null,
          });
        }
      } else {
        set({
          isGenerating: false,
          generatingThreadId: null,
          inFlightRunId: null,
        });
      }
    }
  },

  sendMessage: async (userText: string, image?: string) => {
    const targetThreadId = get().activeThreadId;
    if (!targetThreadId) return;

    if (!isServerThreadId(targetThreadId)) return;
    if (get().isGenerating) return;
    if (!userText.trim() && !image) return;

    const userMsgId = 'user-' + Date.now();
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: userText,
      image,
      timestamp: Date.now(),
    };
    get().addMessage(userMsg, targetThreadId);

    const assistantMsgId = 'assistant-' + Date.now();
    get().addMessage(
      {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
        transcript: '',
        status: 'streaming',
        timestamp: Date.now(),
      },
      targetThreadId
    );

    set({ isGenerating: true, generatingThreadId: targetThreadId });

    let attachmentIds: string[] | undefined;
    if (image) {
      try {
        const blob = dataUrlToBlob(image);
        const attachmentId = await uploadAttachment(blob);
        attachmentIds = [attachmentId];
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : BAD_ATTACHMENT;
        get().updateMessage(
          assistantMsgId,
          { content: `**Error:** ${msg}`, status: 'error' },
          targetThreadId
        );
        set({ isGenerating: false, generatingThreadId: null, inFlightRunId: null });
        return;
      }
    }

    const targetThread = get().threads.find((t) => t.id === targetThreadId);
    const viewingVersion = getLatestViewingVersion(targetThread?.versions);
    const req = buildChatRequest({
      threadId: targetThreadId,
      text: userText,
      viewingVersion,
      attachmentIds,
      model: get().selectedModel,
    });

    const sendRes = await sendChat(req);

    if (sendRes.kind === 'error') {
      get().updateMessage(
        assistantMsgId,
        { content: `**Error:** ${sendRes.message}`, status: 'error' },
        targetThreadId
      );
      set({ isGenerating: false, generatingThreadId: null, inFlightRunId: null });
      return;
    }

    // When sendChat returns stream or attach:
    // If it was a draft, add the thread to the top of threads and to the IndexedDB cache
    const existingThread = get().threads.find((t) => t.id === targetThreadId);
    if (!existingThread) {
      const firstLine = userText.split('\n')[0].trim().slice(0, 80);
      const newThread: ChatThread = {
        id: targetThreadId,
        title: firstLine || 'Design',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        selectedModel: get().selectedModel,
        code: get().code,
        messages: get().messages,
        step: null,
      };
      const updatedThreads = [newThread, ...get().threads];
      set({ threads: updatedThreads });
      void upsertThread(newThread);
      void setActiveThreadId(targetThreadId);
      newThread.messages.forEach((m) => void upsertMessage(targetThreadId, m));
    }

    if (sendRes.kind === 'attach') {
      const tailRes = await tailRun(sendRes.runId, 0);
      await get().consumeRunStream({
        response: tailRes,
        threadId: targetThreadId,
        runId: sendRes.runId,
      });
      return;
    }

    set({ inFlightRunId: sendRes.runId });
    await get().consumeRunStream({
      response: sendRes.response,
      threadId: targetThreadId,
      runId: sendRes.runId,
    });
  },

  initializeFromStorage: async () => {
    const { threads: cachedThreads, activeThreadId: cachedActiveId } = await loadAllThreads();
    const active = cachedThreads.find((t) => t.id === cachedActiveId) || cachedThreads[0];
    const initialCode = active?.code || DEFAULT_CODE;

    set({
      threads: cachedThreads,
      activeThreadId: active ? active.id : '',
      messages: active ? active.messages : [],
      code: initialCode,
      params: parseParams(toBody(initialCode)),
      stlContent: active?.stlContent || null,
      modelInfo: active?.modelInfo || null,
      step: active?.step || null,
      selectedModel: active?.selectedModel || DEFAULT_MODEL,
    });

    try {
      const serverSummaries = await listThreads();
      let legacyThreads = cachedThreads.filter((t) => !isServerThreadId(t.id));
      if (serverSummaries.length > 0) {
        legacyThreads = legacyThreads.filter(
          (t) => !(t.messages.length <= 1 && t.messages[0]?.id === 'welcome-msg')
        );
      }

      const serverIds = new Set(serverSummaries.map((s) => s.id));
      const serverThreadsList: ChatThread[] = serverSummaries.map((summary) => {
        const cached = cachedThreads.find((t) => t.id === summary.id);
        if (cached) {
          return {
            ...cached,
            title: summary.title || cached.title,
            updatedAt: summary.updatedAt,
            activeRunId: summary.activeRunId,
          };
        }
        return {
          id: summary.id,
          title: summary.title || 'Design',
          createdAt: summary.updatedAt,
          updatedAt: summary.updatedAt,
          activeRunId: summary.activeRunId,
          messages: [],
          code: DEFAULT_CODE,
        };
      });

      for (const t of cachedThreads) {
        if (isServerThreadId(t.id) && !serverIds.has(t.id)) {
          void deleteThreadCascade(t.id);
        }
      }

      const mergedThreads = [...serverThreadsList, ...legacyThreads];

      if (mergedThreads.length === 0) {
        set({ threads: [] });
        get().createNewThread();
        return;
      }

      let targetActiveId: string;
      if (mergedThreads.some((t) => t.id === cachedActiveId)) {
        targetActiveId = cachedActiveId;
      } else if (serverSummaries.length > 0) {
        targetActiveId = serverSummaries[0].id;
      } else {
        targetActiveId = mergedThreads[0].id;
      }

      const activeObj = mergedThreads.find((t) => t.id === targetActiveId) || mergedThreads[0];
      set({
        threads: mergedThreads,
        activeThreadId: activeObj.id,
        messages: activeObj.messages,
        code: activeObj.code || DEFAULT_CODE,
        stlContent: activeObj.stlContent || null,
        modelInfo: activeObj.modelInfo || null,
        step: activeObj.step || null,
      });

      if (isServerThreadId(activeObj.id)) {
        await get().loadServerThread(activeObj.id);
      }
    } catch (err) {
      console.warn('Failed to load threads from server:', err);
    }
  },

  createNewThread: () => {
    const id = crypto.randomUUID();
    set({
      activeThreadId: id,
      messages: [],
      code: DEFAULT_CODE,
      params: parseParams(toBody(DEFAULT_CODE)),
      geometry: null,
      stlContent: null,
      modelInfo: null,
      step: null,
      compileStatus: 'idle',
      compileError: null,
      isGenerating: false,
      generatingThreadId: null,
      inFlightRunId: null,
    });
    return id;
  },

  switchThread: (threadId) => {
    const target = get().threads.find((t) => t.id === threadId);
    if (!target) return;

    const initialCode = target.code || DEFAULT_CODE;
    set({
      activeThreadId: target.id,
      messages: target.messages,
      code: initialCode,
      params: parseParams(toBody(initialCode)),
      geometry: null, // will recompile on mount/switch
      stlContent: target.stlContent || null,
      modelInfo: target.modelInfo || null,
      step: target.step || null,
      selectedModel: target.selectedModel || get().selectedModel,
      compileStatus: 'idle',
      compileError: null,
    });

    void setActiveThreadId(target.id);

    if (isServerThreadId(target.id)) {
      void get().loadServerThread(target.id);
    }
  },

  deleteThread: (threadId) => {
    const { threads, activeThreadId } = get();
    if (threads.length <= 1) {
      if (threads.some((t) => t.id === threadId)) {
        void deleteThreadCascade(threadId);
        if (isServerThreadId(threadId)) {
          void deleteServerThread(threadId).catch(() => {});
        }
      }
      set({ threads: [] });
      get().createNewThread();
      return;
    }

    const filtered = threads.filter((t) => t.id !== threadId);
    if (filtered.length === 0) {
      set({ threads: [] });
      get().createNewThread();
      return;
    }
    const newActiveId = activeThreadId === threadId ? filtered[0].id : activeThreadId;
    const newActive = filtered.find((t) => t.id === newActiveId)!;
    const initialCode = newActive.code || DEFAULT_CODE;

    set({
      threads: filtered,
      activeThreadId: newActive.id,
      messages: newActive.messages,
      code: initialCode,
      params: parseParams(toBody(initialCode)),
      geometry: null,
      stlContent: newActive.stlContent || null,
      modelInfo: newActive.modelInfo || null,
      step: newActive.step || null,
    });

    void deleteThreadCascade(threadId);
    void setActiveThreadId(newActive.id);

    if (isServerThreadId(threadId)) {
      void deleteServerThread(threadId).catch(() => {});
    }
    if (isServerThreadId(newActive.id)) {
      void get().loadServerThread(newActive.id).catch(() => {});
    }
  },

  renameThread: (threadId, title) => {
    const updated = get().threads.map((t) =>
      t.id === threadId ? { ...t, title, updatedAt: Date.now() } : t
    );
    set({ threads: updated });

    const renamed = updated.find((t) => t.id === threadId);
    if (renamed) void upsertThread(renamed);

    if (isServerThreadId(threadId)) {
      void renameServerThread(threadId, title).catch(() => {});
    }
  },

  setSelectedModel: (model) => set({ selectedModel: model }),

  addMessage: (message, threadId) => {
    const targetId = threadId || get().activeThreadId;
    const { threads, activeThreadId } = get();
    const targetThread = threads.find((t) => t.id === targetId);
    if (!targetThread) {
      if (targetId === activeThreadId) {
        set({ messages: [...get().messages, message] });
      }
      return;
    }

    const updatedMessages = [...targetThread.messages, message];

    // Smart title generation on first user prompt
    let title = targetThread.title || 'Design';
    if (message.role === 'user' && title.startsWith('Design #')) {
      title = message.content.slice(0, 32) + (message.content.length > 32 ? '...' : '');
    }

    const updatedThreads = threads.map((t) =>
      t.id === targetId
        ? { ...t, title, messages: updatedMessages, updatedAt: Date.now() }
        : t
    );

    if (targetId === activeThreadId) {
      set({ messages: updatedMessages, threads: updatedThreads });
    } else {
      set({ threads: updatedThreads });
    }

    void upsertMessage(targetId, message);

    // Thread row carries the (possibly auto-generated) title and updatedAt.
    const updatedThread = updatedThreads.find((t) => t.id === targetId);
    if (updatedThread) void upsertThread(updatedThread);
  },

  updateMessage: (id, partial, threadId) => {
    const targetId = threadId || get().activeThreadId;
    const { threads, activeThreadId } = get();
    const targetThread = threads.find((t) => t.id === targetId);
    if (!targetThread) {
      if (targetId === activeThreadId) {
        const updatedMessages = get().messages.map((m) =>
          m.id === id ? { ...m, ...partial } : m
        );
        set({ messages: updatedMessages });
      }
      return;
    }

    const updatedMessages = targetThread.messages.map((m) =>
      m.id === id ? { ...m, ...partial } : m
    );

    const updatedThreads = threads.map((t) =>
      t.id === targetId
        ? { ...t, messages: updatedMessages, updatedAt: Date.now() }
        : t
    );

    if (targetId === activeThreadId) {
      set({ messages: updatedMessages, threads: updatedThreads });
    } else {
      set({ threads: updatedThreads });
    }

    const updatedMessage = updatedMessages.find((m) => m.id === id);
    if (updatedMessage) void upsertMessage(targetId, updatedMessage);
  },

  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setGeneratingThreadId: (threadId) => set({ generatingThreadId: threadId }),

  setCode: (code, threadId, source = 'agent') => {
    const targetId = threadId || get().activeThreadId;
    const { threads, activeThreadId } = get();
    const targetThread = threads.find((t) => t.id === targetId);
    if (!targetThread) {
      if (targetId === activeThreadId) {
        set({
          code,
          params: parseParams(toBody(code)),
        });
      }
      return;
    }

    let finalCode = code;
    let newContractDiff: ContractDiff | null = null;
    let newContract = targetThread.designContract;
    
    if (newContract) {
      if (source === 'agent') {
        const { code: contractAppliedCode, diff } = applyContract(code, newContract);
        finalCode = contractAppliedCode;
        
        // Only surface the diff in the active thread if changes were actually applied or rejected
        if (targetId === activeThreadId && (diff.applied.length > 0 || diff.rejected.length > 0)) {
          newContractDiff = diff;
        }
      } else {
        // User manual edit: do not apply contract. Instead, update pins to match hand-typed values.
        const parsedParams = parseParams(toBody(code));
        let contractUpdated = false;
        const newPinnedParams = { ...(newContract.pinnedParams || {}) };

        for (const [name, pin] of Object.entries(newPinnedParams)) {
          const editedParam = parsedParams.find(p => p.name === name);
          if (editedParam && editedParam.value !== pin.value) {
            newPinnedParams[name] = { ...pin, value: editedParam.value, pinnedAt: Date.now() };
            contractUpdated = true;
          }
        }
        
        if (contractUpdated) {
          newContract = { ...newContract, pinnedParams: newPinnedParams };
        }
      }
    }

    const currentParams = parseParams(toBody(finalCode));

    const updatedThreads = threads.map((t) =>
      t.id === targetId ? { ...t, code: finalCode, designContract: newContract, updatedAt: Date.now() } : t
    );

    if (targetId === activeThreadId) {
      set({ 
        code: finalCode, 
        params: currentParams,
        threads: updatedThreads 
      });
      if (newContractDiff) {
        set({ contractDiff: newContractDiff });
      }
    } else {
      set({ threads: updatedThreads });
    }

    // Editor keystrokes land here, so the code write is debounced. A contract
    // change (pins rewritten by a manual edit) is rare — write it straight through.
    if (newContract !== targetThread.designContract) {
      const updatedThread = updatedThreads.find((t) => t.id === targetId);
      if (updatedThread) void upsertThread(updatedThread);
    } else {
      setCodeDebounced(targetId, finalCode, Date.now());
    }
  },

  setCompileResult: (result, threadId) => {
    if (result.aborted) return; // Do not process stale compile results

    const targetId = threadId || get().activeThreadId;
    const { threads, activeThreadId } = get();
    const updatedThreads = threads.map((t) =>
      t.id === targetId
        ? {
            ...t,
            stlContent: result.stlContent || t.stlContent,
            modelInfo: result.modelInfo || t.modelInfo,
            step: result.step !== undefined ? (result.step || null) : (t.step || null),
            updatedAt: Date.now(),
          }
        : t
    );

    if (targetId === activeThreadId) {
      const activeT = updatedThreads.find((t) => t.id === activeThreadId);
      set({
        compileStatus: result.success ? 'success' : 'error',
        compileError: result.error || null,
        geometry: result.geometry || null,
        stlContent: result.stlContent || null,
        modelInfo: result.modelInfo || null,
        step: activeT?.step || null,
        compileTimeMs: result.compileTimeMs || 0,
        threads: updatedThreads,
      });
    } else {
      set({
        threads: updatedThreads,
      });
    }

    const updatedThread = updatedThreads.find((t) => t.id === targetId);
    if (updatedThread) void upsertThread(updatedThread);
  },

  setCompileStatus: (status, error = null) =>
    set({ compileStatus: status, compileError: error }),

  updateViewportSettings: (settings) =>
    set((state) => ({
      viewportSettings: { ...state.viewportSettings, ...settings },
    })),

  setEditorView: (view) => set({ editorView: view }),

  pinParam: (name, value) => {
    const { activeThreadId, threads, code, params } = get();
    const targetThread = threads.find((t) => t.id === activeThreadId);
    if (!targetThread) return;

    // Determine supersededValue if not already pinned
    let supersededValue = value;
    const existingContract = targetThread.designContract || { standing: {}, pinnedParams: {} };
    const existingPins = existingContract.pinnedParams || {};
    
    if (existingPins[name]) {
      supersededValue = existingPins[name].supersededValue;
    } else {
      const p = params.find(param => param.name === name);
      if (p) supersededValue = p.value;
    }

    // 1. Write the literal to code
    const newCode = setParamValue(code, name, value);

    // 2. Record the pin in thread
    const updatedContract = {
      ...existingContract,
      pinnedParams: {
        ...existingPins,
        [name]: { value, supersededValue, pinnedAt: Date.now() },
      }
    };

    const updatedThreads = threads.map((t) =>
      t.id === activeThreadId ? { ...t, designContract: updatedContract } : t
    );
    set({ threads: updatedThreads });

    const updatedThread = updatedThreads.find((t) => t.id === activeThreadId);
    if (updatedThread) void upsertThread(updatedThread);

    // 3. Call setCode to derive params and apply contract (but don't overwrite user intent)
    get().setCode(newCode, activeThreadId, 'user');

    // 4. Schedule debounced compile
    set({ compileStatus: 'compiling' });
    compileModel(get().code).then(result => {
      get().setCompileResult(result);
    });
  },

  unpinParam: (name) => {
    const { activeThreadId, threads, code } = get();
    const targetThread = threads.find((t) => t.id === activeThreadId);
    if (!targetThread || !targetThread.designContract?.pinnedParams) return;

    const pinnedParam = targetThread.designContract.pinnedParams[name];
    if (!pinnedParam) return;

    const newPinned = { ...targetThread.designContract.pinnedParams };
    delete newPinned[name];

    const updatedContract = { ...targetThread.designContract, pinnedParams: newPinned };

    const updatedThreads = threads.map((t) =>
      t.id === activeThreadId ? { ...t, designContract: updatedContract } : t
    );
    set({ threads: updatedThreads });

    const updatedThread = updatedThreads.find((t) => t.id === activeThreadId);
    if (updatedThread) void upsertThread(updatedThread);

    // Restore supersededValue
    const newCode = setParamValue(code, name, pinnedParam.supersededValue);
    get().setCode(newCode, activeThreadId, 'user');

    set({ compileStatus: 'compiling' });
    compileModel(get().code).then(result => {
      get().setCompileResult(result);
    });
  },

  unpinAll: () => {
    const { activeThreadId, threads, code } = get();
    const targetThread = threads.find((t) => t.id === activeThreadId);
    if (!targetThread || !targetThread.designContract?.pinnedParams) return;

    const pinnedParams = targetThread.designContract.pinnedParams;
    if (Object.keys(pinnedParams).length === 0) return;

    const updatedContract = { ...targetThread.designContract, pinnedParams: {} };

    const updatedThreads = threads.map((t) =>
      t.id === activeThreadId ? { ...t, designContract: updatedContract } : t
    );
    set({ threads: updatedThreads });

    const updatedThread = updatedThreads.find((t) => t.id === activeThreadId);
    if (updatedThread) void upsertThread(updatedThread);

    // Restore supersededValues
    let newCode = code;
    for (const [name, pin] of Object.entries(pinnedParams)) {
      newCode = setParamValue(newCode, name, pin.supersededValue);
    }
    get().setCode(newCode, activeThreadId, 'user');

    set({ compileStatus: 'compiling' });
    compileModel(get().code).then(result => {
      get().setCompileResult(result);
    });
  },

  setStanding: (partial) => {
    const { activeThreadId, threads } = get();
    const targetThread = threads.find((t) => t.id === activeThreadId);
    if (!targetThread) return;

    const existingContract = targetThread.designContract || { standing: {}, pinnedParams: {} };
    const updatedContract = {
      ...existingContract,
      standing: { ...existingContract.standing, ...partial },
    };

    const updatedThreads = threads.map((t) =>
      t.id === activeThreadId ? { ...t, designContract: updatedContract } : t
    );
    set({ threads: updatedThreads });

    const updatedThread = updatedThreads.find((t) => t.id === activeThreadId);
    if (updatedThread) void upsertThread(updatedThread);
  },

  setThreadContract: (_contract, threadId) => {
    void _contract;
    const targetId = threadId || get().activeThreadId;
    const { threads } = get();
    const targetThread = threads.find((t) => t.id === targetId);
    if (!targetThread) return;

    // The client owns standing constraints and pins; since the spec left the
    // contract, the server's copy carries nothing authoritative, so it is not
    // merged.
    const updatedContract: DesignContract = targetThread.designContract ?? {
      standing: {},
      pinnedParams: {},
    };

    const updatedThreads = threads.map((t) =>
      t.id === targetId ? { ...t, designContract: updatedContract, updatedAt: Date.now() } : t
    );
    set({ threads: updatedThreads });

    const updatedThread = updatedThreads.find((t) => t.id === targetId);
    if (updatedThread) void upsertThread(updatedThread);
  },

  dismissContractDiff: () => set({ contractDiff: null }),

  setIsAnnotating: (isAnnotating) => set({ isAnnotating }),
  setBaseSnapshot: (snapshot) => set({ baseSnapshot: snapshot }),
  setPendingAttachment: (image) => set({ pendingAttachment: image }),

  resetProject: () => {
    const { threads, activeThreadId } = get();
    const resetThreads = threads.map((t) =>
      t.id === activeThreadId
        ? {
            ...t,
            code: DEFAULT_CODE,
            designContract: undefined,
            stlContent: null,
            modelInfo: null,
            step: null,
            messages: createInitialThread().messages,
            updatedAt: Date.now(),
          }
        : t
    );

    set({
      code: DEFAULT_CODE,
      params: parseParams(toBody(DEFAULT_CODE)),
      contractDiff: null,
      geometry: null,
      stlContent: null,
      modelInfo: null,
      step: null,
      compileStatus: 'idle',
      compileError: null,
      threads: resetThreads,
    });

    const resetThread = resetThreads.find((t) => t.id === activeThreadId);
    if (resetThread) {
      // Old messages go first, so the fresh welcome message isn't swept up with them.
      void (async () => {
        await clearThreadMessages(activeThreadId);
        await upsertThread(resetThread);
        await Promise.all(
          resetThread.messages.map((m: ChatMessage) => upsertMessage(activeThreadId, m))
        );
      })();
    }
  },
}));
