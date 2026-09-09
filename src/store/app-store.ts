import { create } from 'zustand';
import * as THREE from 'three';
import { ChatMessage, AgentProgress, ModelInfo, ViewportSettings, CompileResult, ChatThread, ScadParam, ContractDiff, ParamValue, StandingConstraints, DesignContract } from '@/types';
import {
  DEFAULT_OPENSCAD_CODE,
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
import { setParamValue } from '@/lib/design/write-params';
import { compileOpenScad } from '@/lib/engine/openscad-bridge';

interface AppState {
  apiKey: string;
  selectedModel: string;
  threads: ChatThread[];
  activeThreadId: string;

  // Active Thread Data (mirrored for fast access)
  messages: ChatMessage[];
  code: string;
  geometry: THREE.BufferGeometry | null;
  stlContent: string | null;
  modelInfo: ModelInfo | null;
  
  // Design Contract & Parameters
  params: ScadParam[];
  contractDiff: ContractDiff | null;
  editorView: 'code' | 'design';

  // Runtime State & Generation
  isGenerating: boolean;
  generatingThreadId: string | null;
  activeProgress: AgentProgress | null;
  progressHistory: AgentProgress[];
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
  setApiKey: (key: string) => void;
  setSelectedModel: (model: string) => void;
  addMessage: (message: ChatMessage, threadId?: string) => void;
  updateMessage: (id: string, partial: Partial<ChatMessage>, threadId?: string) => void;
  setIsGenerating: (isGenerating: boolean) => void;
  setGeneratingThreadId: (threadId: string | null) => void;
  setActiveProgress: (progress: AgentProgress | null) => void;
  addProgressUpdate: (progress: AgentProgress) => void;
  clearProgress: () => void;
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
  apiKey: '',
  selectedModel: 'deepseek-v4-flash',
  threads: [],
  activeThreadId: '',

  messages: [],
  code: DEFAULT_OPENSCAD_CODE,
  geometry: null,
  stlContent: null,
  modelInfo: null,
  params: [],
  contractDiff: null,
  editorView: 'design',

  isGenerating: false,
  generatingThreadId: null,
  activeProgress: null,
  progressHistory: [],
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

  initializeFromStorage: async () => {
    const { threads, activeThreadId } = await loadAllThreads();
    const active = threads.find((t) => t.id === activeThreadId) || threads[0];
    const initialCode = active.code || DEFAULT_OPENSCAD_CODE;

    set({
      threads,
      activeThreadId: active.id,
      messages: active.messages,
      code: initialCode,
      params: parseParams(initialCode),
      stlContent: active.stlContent || null,
      modelInfo: active.modelInfo || null,
      selectedModel: active.selectedModel || 'deepseek-v4-flash',
    });
  },

  createNewThread: (title) => {
    const newThread: ChatThread = {
      id: 'thread-' + Date.now(),
      title: title || `Design #${get().threads.length + 1}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      selectedModel: get().selectedModel,
      code: DEFAULT_OPENSCAD_CODE,
      messages: [
        {
          id: 'welcome-' + Date.now(),
          role: 'assistant',
          content: `👋 **New 3D Design Started!** What would you like to model? Describe your dimensions, features, or 3D print requirements.`,
          code: DEFAULT_OPENSCAD_CODE,
          timestamp: Date.now(),
        },
      ],
    };

    const updatedThreads = [newThread, ...get().threads];
    set({
      threads: updatedThreads,
      activeThreadId: newThread.id,
      messages: newThread.messages,
      code: newThread.code,
      params: parseParams(newThread.code),
      geometry: null,
      stlContent: null,
      modelInfo: null,
      compileStatus: 'idle',
      compileError: null,
      progressHistory: [],
      activeProgress: null,
    });

    void upsertThread(newThread);
    newThread.messages.forEach((m) => void upsertMessage(newThread.id, m));
    void setActiveThreadId(newThread.id);
    return newThread.id;
  },

  switchThread: (threadId) => {
    const target = get().threads.find((t) => t.id === threadId);
    if (!target) return;

    const initialCode = target.code || DEFAULT_OPENSCAD_CODE;
    set({
      activeThreadId: target.id,
      messages: target.messages,
      code: initialCode,
      params: parseParams(initialCode),
      geometry: null, // will recompile on mount/switch
      stlContent: target.stlContent || null,
      modelInfo: target.modelInfo || null,
      selectedModel: target.selectedModel || get().selectedModel,
      compileStatus: 'idle',
      compileError: null,
      progressHistory: [],
      activeProgress: null,
    });

    void setActiveThreadId(target.id);
  },

  deleteThread: (threadId) => {
    const { threads, activeThreadId } = get();
    if (threads.length <= 1) {
      // Don't delete the last thread; reset it instead
      get().resetProject();
      return;
    }

    const filtered = threads.filter((t) => t.id !== threadId);
    const newActiveId = activeThreadId === threadId ? filtered[0].id : activeThreadId;
    const newActive = filtered.find((t) => t.id === newActiveId)!;
    const initialCode = newActive.code || DEFAULT_OPENSCAD_CODE;

    set({
      threads: filtered,
      activeThreadId: newActive.id,
      messages: newActive.messages,
      code: initialCode,
      params: parseParams(initialCode),
      geometry: null,
      stlContent: newActive.stlContent || null,
      modelInfo: newActive.modelInfo || null,
    });

    void deleteThreadCascade(threadId);
    void setActiveThreadId(newActive.id);
  },

  renameThread: (threadId, title) => {
    const updated = get().threads.map((t) =>
      t.id === threadId ? { ...t, title, updatedAt: Date.now() } : t
    );
    set({ threads: updated });

    const renamed = updated.find((t) => t.id === threadId);
    if (renamed) void upsertThread(renamed);
  },

  setApiKey: (key) => set({ apiKey: key }),
  setSelectedModel: (model) => set({ selectedModel: model }),

  addMessage: (message, threadId) => {
    const targetId = threadId || get().activeThreadId;
    const { threads, activeThreadId } = get();
    const targetThread = threads.find((t) => t.id === targetId);
    if (!targetThread) return;

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
    if (!targetThread) return;

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
  setActiveProgress: (progress) => set({ activeProgress: progress }),
  addProgressUpdate: (progress) =>
    set((state) => ({
      activeProgress: progress,
      progressHistory: [...state.progressHistory, progress],
    })),
  clearProgress: () =>
    set({
      activeProgress: null,
      progressHistory: [],
    }),

  setCode: (code, threadId, source = 'agent') => {
    const targetId = threadId || get().activeThreadId;
    const { threads, activeThreadId } = get();
    const targetThread = threads.find((t) => t.id === targetId);
    if (!targetThread) return;

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
        const parsedParams = parseParams(code);
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

    const currentParams = parseParams(finalCode);

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
            updatedAt: Date.now(),
          }
        : t
    );

    if (targetId === activeThreadId) {
      set({
        compileStatus: result.success ? 'success' : 'error',
        compileError: result.error || null,
        geometry: result.geometry || null,
        stlContent: result.stlContent || null,
        modelInfo: result.modelInfo || null,
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
    compileOpenScad(get().code).then(result => {
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
    compileOpenScad(get().code).then(result => {
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
    compileOpenScad(get().code).then(result => {
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

  setThreadContract: (contract, threadId) => {
    const targetId = threadId || get().activeThreadId;
    const { threads } = get();
    const targetThread = threads.find((t) => t.id === targetId);
    if (!targetThread) return;

    // The client owns standing constraints and pins - the user edits those
    // locally and they are already POSTed on every turn. Only `spec` and its
    // approval stamp are authoritative from the server, so merge rather than
    // replace, or a slider pinned mid-run would be clobbered on completion.
    const updatedContract: DesignContract = {
      ...(targetThread.designContract ?? { standing: {}, pinnedParams: {} }),
      spec: contract.spec,
      specApprovedAt: contract.specApprovedAt,
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
            code: DEFAULT_OPENSCAD_CODE,
            designContract: undefined,
            stlContent: null,
            modelInfo: null,
            messages: createInitialThread().messages,
            updatedAt: Date.now(),
          }
        : t
    );

    set({
      code: DEFAULT_OPENSCAD_CODE,
      params: parseParams(DEFAULT_OPENSCAD_CODE),
      contractDiff: null,
      geometry: null,
      stlContent: null,
      modelInfo: null,
      compileStatus: 'idle',
      compileError: null,
      progressHistory: [],
      activeProgress: null,
      threads: resetThreads,
    });

    const resetThread = resetThreads.find((t) => t.id === activeThreadId);
    if (resetThread) {
      // Old messages go first, so the fresh welcome message isn't swept up with them.
      void (async () => {
        await clearThreadMessages(activeThreadId);
        await upsertThread(resetThread);
        await Promise.all(
          resetThread.messages.map((m) => upsertMessage(activeThreadId, m))
        );
      })();
    }
  },
}));
