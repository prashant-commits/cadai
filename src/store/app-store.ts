import { create } from 'zustand';
import * as THREE from 'three';
import {
  ChatMessage,
  ModelInfo,
  ViewportSettings,
  CompileResult,
  ChatThread,
  ScadParam,
  ParamValue,
  StandingConstraints,
} from '@/types';
import type { PartInfo } from '@/lib/contract/run-contract';
import {
  clearThreadMessages,
  deleteThreadCascade,
  setActiveThreadId,
  setCodeDebounced,
  upsertMessage,
  upsertThread,
  getDraft,
  setDraft,
  clearDraft,
  type LocalDraft,
} from '@/lib/storage/thread-storage';
import { parseParams } from '@/lib/design/parse-params';
import { toBody, PRELUDE_VERSION } from '@/lib/brep/prelude';
import { setParamValue } from '@/lib/design/write-params';
import { compileModel } from '@/lib/engine/build123d-client';
import { DEFAULT_MODEL } from '@/lib/agent/models';
import {
  getThread,
  renameThread as renameServerThread,
  deleteThread as deleteServerThread,
  stopRun,
  tailRun,
  sendChat,
  buildChatRequest,
  isServerThreadId,
  fetchArtifactText,
  uploadAttachment,
  type ServerThreadDetail,
  type ServerThreadVersion,
} from '@/lib/client/server-thread';
import { parseStlToGeometry } from '@/lib/engine/geometry-utils';
import { readStream, streamMessagePatch } from '@/lib/stream-reader';
import { serializeTranscript } from '@/lib/agent/transcript';
import { createProjectsSlice, isProjectOpened, type ProjectsSlice } from './projects-slice';
import { NEEDS_PROJECT, WELCOME } from '@/lib/persist/phrases';

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

async function resolveVersionState(
  threadId: string,
  version: ServerThreadVersion,
  isActiveThread: boolean,
  setCompileStatus?: (status: 'idle' | 'compiling' | 'success' | 'error') => void
): Promise<{
  code: string;
  draft: LocalDraft | null;
  geometry: THREE.BufferGeometry | null;
  stlContent: string | null;
  modelInfo: ModelInfo | null;
  step: null;
  parts: PartInfo[];
}> {
  const draft = await getDraft(threadId, version.version);
  const baseBody = draft?.editedBody ?? version.body;
  let shownCode = baseBody;
  if (draft?.pinnedParams) {
    for (const [name, val] of Object.entries(draft.pinnedParams)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        shownCode = setParamValue(shownCode, name, val);
      }
    }
  }
  const finalCode = toBody(shownCode);

  let newStl: string | null = null;
  let newGeometry: THREE.BufferGeometry | null = null;
  let newModelInfo: ModelInfo | null = null;
  let newParts: PartInfo[] = [];

  const hasEdits =
    draft &&
    (draft.editedBody !== undefined ||
      (draft.pinnedParams && Object.keys(draft.pinnedParams).length > 0));

  if (!hasEdits && version.stl) {
    try {
      const stlText = await fetchArtifactText(version.stl);
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
    if (isActiveThread && setCompileStatus) {
      setCompileStatus('compiling');
    }
    try {
      const res = await compileModel(finalCode, {
        preludeVersion: version.preludeVersion ?? PRELUDE_VERSION,
      });
      newStl = res.stlContent || null;
      newGeometry = res.geometry || null;
      newModelInfo = res.modelInfo || null;
      newParts = res.parts ?? [];
    } catch (err) {
      console.warn('Failed to compile version code:', err);
      newParts = [];
    }
  }

  return {
    code: finalCode,
    draft,
    geometry: newGeometry,
    stlContent: newStl,
    modelInfo: newModelInfo,
    step: null,
    parts: newParts,
  };
}

export interface PendingAttachment {
  localUrl: string;
  kind: 'markup' | 'reference';
  status: 'uploading' | 'failed' | 'ready';
  id?: string;
}

export interface AppState extends ProjectsSlice {
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
  /** Labelled parts from the geometry service (compile result or version facts). */
  parts: PartInfo[];
  viewingVersion: number | null;
  activeDraft: LocalDraft | null;

  // Design Parameters
  params: ScadParam[];
  editorView: 'code' | 'design';

  // Runtime State & Generation
  isGenerating: boolean;
  generatingThreadId: string | null;
  inFlightRunId: string | null;
  runsByThread: Record<string, string>;
  compileStatus: 'idle' | 'compiling' | 'success' | 'error';
  compileError: string | null;
  compileErrorLine: number | null;
  compileTimeMs: number;
  viewportSettings: ViewportSettings;

  // Workspace UI links (shared by the chat, inspector and code drawer lanes)
  /** The design version whose chat message is highlighted (set by the inspector's Versions). */
  highlightedVersion: number | null;
  setHighlightedVersion: (version: number | null) => void;
  /** The selected inspector layer (a part label in Phase 1, a tool op id in Phase 2). */
  selectedLayerId: string | null;
  setSelectedLayerId: (id: string | null) => void;
  /** Whether the bottom code drawer is open. */
  codeDrawerOpen: boolean;
  setCodeDrawerOpen: (open: boolean) => void;

  // Annotation & Input State
  isAnnotating: boolean;
  baseSnapshot: string | null;
  pendingAttachment: PendingAttachment | null;

  // Thread Actions
  createNewThread: (title?: string) => string;
  switchThread: (threadId: string) => void;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => void;
  selectVersion: (version: number) => Promise<void>;

  // Settings & State Actions
  setSelectedModel: (model: string) => void;
  addMessage: (message: ChatMessage, threadId?: string) => void;
  updateMessage: (id: string, partial: Partial<ChatMessage>, threadId?: string) => void;
  setIsGenerating: (isGenerating: boolean) => void;
  setGeneratingThreadId: (threadId: string | null) => void;
  setInFlightRunId: (runId: string | null) => void;
  stopCurrentRun: () => Promise<void>;
  loadServerThread: (threadId: string, targetVersion?: number) => Promise<ServerThreadDetail | null>;
  consumeRunStream: (opts: {
    response: Response;
    threadId: string;
    runId: string;
    reconnectCount?: number;
  }) => Promise<void>;
  sendMessage: (
    text: string,
    attachment?: { id: string; kind: 'markup' | 'reference'; localUrl: string } | string
  ) => Promise<void>;
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

  setIsAnnotating: (isAnnotating: boolean) => void;
  setBaseSnapshot: (snapshot: string | null) => void;
  attachImage: (dataUrl: string, kind: 'markup' | 'reference') => void;
  retryAttachment: () => void;
  removeAttachment: () => void;
  setPendingAttachment: (image: PendingAttachment | string | null) => void;

  resetProject: () => void;
  initializeFromStorage: () => Promise<void>;
}

let attachAbortController: AbortController | null = null;

export const useAppStore = create<AppState>((set, get, api) => ({
  ...createProjectsSlice(set, get, api),
  selectedModel: DEFAULT_MODEL,
  threads: [],
  activeThreadId: '',

  messages: [],
  code: '',
  geometry: null,
  parts: [],
  stlContent: null,
  modelInfo: null,
  step: null,
  viewingVersion: null,
  activeDraft: null,
  params: [],
  editorView: 'design',

  isGenerating: false,
  generatingThreadId: null,
  inFlightRunId: null,
  runsByThread: {},
  compileStatus: 'idle',
  compileError: null,
  compileErrorLine: null,
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
    const activeThreadId = get().activeThreadId;
    const runId = get().runsByThread[activeThreadId] ?? get().inFlightRunId;
    if (!runId) return;

    try {
      const res = await stopRun(runId);
      if (res.status === 202) {
        // 202 means "stopping": keep reading the stream; the end event (STOPPED) follows.
        return;
      }
      if (res.status === 200) {
        // 200 means it ended: reload the thread.
        const nextRuns = { ...get().runsByThread };
        delete nextRuns[activeThreadId];
        set({
          runsByThread: nextRuns,
          isGenerating: Object.keys(nextRuns).length > 0,
          inFlightRunId: nextRuns[activeThreadId] ?? null,
        });
        await get().loadServerThread(activeThreadId);
      }
    } catch (err) {
      console.warn('Failed to stop run:', err);
    }
  },

  selectVersion: async (versionNumber: number) => {
    const { threads, activeThreadId } = get();
    const currentThread = threads.find((t) => t.id === activeThreadId);
    if (!currentThread || !currentThread.versions) return;

    const targetVersion = currentThread.versions.find((v) => v.version === versionNumber);
    if (!targetVersion) return;

    const resolved = await resolveVersionState(
      activeThreadId,
      targetVersion,
      true,
      (status) => set({ compileStatus: status })
    );

    const updatedThread: ChatThread = {
      ...currentThread,
      viewingVersion: versionNumber,
      code: resolved.code,
      stlContent: resolved.stlContent,
      modelInfo: resolved.modelInfo,
      step: null,
      updatedAt: Date.now(),
    };

    const updatedThreads = threads.map((t) => (t.id === activeThreadId ? updatedThread : t));

    set({
      threads: updatedThreads,
      viewingVersion: versionNumber,
      activeDraft: resolved.draft,
      code: resolved.code,
      params: parseParams(toBody(resolved.code)),
      stlContent: resolved.stlContent,
      geometry: resolved.geometry,
      parts: resolved.parts,
      modelInfo: resolved.modelInfo,
      step: null,
      compileStatus: 'idle',
      compileError: null,
      compileErrorLine: null,
    });

    void upsertThread(updatedThread);
  },

  loadServerThread: async (threadId: string, targetVersion?: number) => {
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
          code: nextActive.code ? toBody(nextActive.code) : '',
          stlContent: nextActive.stlContent || null,
          geometry: null,
          parts: [],
          selectedLayerId: null,
          highlightedVersion: null,
          modelInfo: nextActive.modelInfo || null,
          step: nextActive.step || null,
          viewingVersion: nextActive.viewingVersion ?? null,
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
        get().newThread();
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
        ? serverThread.messages.map((m) => {
            const existing = currentThread?.messages.find((msg) => msg.id === m.id);
            const isStreaming = existing?.status === 'streaming';
            const transcript =
              isStreaming && existing.transcript !== undefined
                ? existing.transcript
                : m.steps && m.steps.length > 0
                ? serializeTranscript(m.steps)
                : existing?.transcript;

            const attachments =
              m.attachments && m.attachments.length > 0
                ? m.attachments
                : undefined;

            return {
              id: m.id,
              role: m.role,
              content: m.markdown,
              kind: m.kind === 'tool_edit' ? 'tool_edit' : undefined,
              status: isStreaming ? 'streaming' : 'complete',
              transcript,
              attachments,
              image: existing?.image,
              code: existing?.code,
              runId: existing?.runId,
              designVersion: m.designVersion,
              timestamp: existing?.timestamp ?? Date.now(),
            };
          })
        : currentThread?.messages || [];

    let viewingVersion: number | null = null;
    let newCode = currentThread?.code ? toBody(currentThread.code) : '';
    let newStl = currentThread?.stlContent || null;
    let newGeometry: THREE.BufferGeometry | null =
      threadId === activeThreadId ? get().geometry : null;
    let newModelInfo = currentThread?.modelInfo || null;
    let newStep = currentThread?.step || null;
    let activeDraft: LocalDraft | null = null;
    let newParts: PartInfo[] = threadId === activeThreadId ? get().parts : [];

    if (serverThread.versions && serverThread.versions.length > 0) {
      if (
        targetVersion !== undefined &&
        serverThread.versions.some((v) => v.version === targetVersion)
      ) {
        viewingVersion = targetVersion;
      } else if (
        currentThread?.viewingVersion != null &&
        serverThread.versions.some((v) => v.version === currentThread.viewingVersion)
      ) {
        viewingVersion = currentThread.viewingVersion;
      } else {
        viewingVersion = Math.max(...serverThread.versions.map((v) => v.version));
      }

      const versionObj = serverThread.versions.find((v) => v.version === viewingVersion)!;
      const resolved = await resolveVersionState(
        threadId,
        versionObj,
        threadId === activeThreadId,
        (status) => {
          if (threadId === activeThreadId) set({ compileStatus: status });
        }
      );

      newCode = resolved.code;
      newStl = resolved.stlContent;
      newGeometry = resolved.geometry;
      newModelInfo = resolved.modelInfo;
      newStep = null;
      activeDraft = resolved.draft;
      newParts = resolved.parts;
    } else {
      viewingVersion = null;
      const draft = await getDraft(threadId, null);
      if (draft?.editedBody) {
        newCode = toBody(draft.editedBody);
      }
      activeDraft = draft;
      newParts = [];
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
      viewingVersion,
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
        viewingVersion,
        activeDraft,
        params: parseParams(toBody(newCode)),
        stlContent: newStl,
        geometry: newGeometry,
        parts: newParts,
        modelInfo: newModelInfo,
        step: newStep,
        compileStatus: 'idle',
        compileError: null,
        compileErrorLine: null,
      });
    } else {
      set({ threads: updatedThreads });
    }

    void upsertThread(updatedThread);
    mappedMessages.forEach((m) => void upsertMessage(threadId, m));

    if (
      serverThread.activeRun &&
      serverThread.activeRun.status === 'running' &&
      !get().runsByThread[threadId]
    ) {
      const runId = serverThread.activeRun.id;
      set({
        runsByThread: { ...get().runsByThread, [threadId]: runId },
        isGenerating: true,
        generatingThreadId: threadId,
        inFlightRunId: get().activeThreadId === threadId ? runId : get().inFlightRunId,
      });

      void (async () => {
        try {
          const tailRes = await tailRun(runId, 0);
          await get().consumeRunStream({
            response: tailRes,
            threadId,
            runId,
          });
        } catch (err) {
          console.warn('Failed to tail active run:', err);
          const nextRuns = { ...get().runsByThread };
          delete nextRuns[threadId];
          set({
            runsByThread: nextRuns,
            isGenerating: Object.keys(nextRuns).length > 0,
            inFlightRunId: nextRuns[get().activeThreadId] ?? null,
          });
        }
      })();
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
    const currentRuns = { ...get().runsByThread, [threadId]: runId };
    set({
      runsByThread: currentRuns,
      isGenerating: true,
      generatingThreadId: threadId,
      inFlightRunId: get().activeThreadId === threadId ? runId : get().inFlightRunId,
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
    let endDesignVersion: number | undefined;
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
          if (state.endEvent?.designVersion !== undefined) {
            endDesignVersion = state.endEvent.designVersion;
          } else if (state.designVersion !== undefined) {
            endDesignVersion = state.designVersion;
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

    const nextRuns = { ...get().runsByThread };
    delete nextRuns[threadId];
    const activeRunId = nextRuns[get().activeThreadId] ?? null;
    set({
      runsByThread: nextRuns,
      isGenerating: Object.keys(nextRuns).length > 0,
      generatingThreadId: Object.keys(nextRuns)[0] ?? null,
      inFlightRunId: activeRunId,
    });

    if (seenEnd) {
      await get().loadServerThread(threadId, endDesignVersion);
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
        }
      }
    }
  },

  sendMessage: async (
    userText: string,
    attachment?: { id: string; kind: 'markup' | 'reference'; localUrl: string } | string
  ) => {
    const targetThreadId = get().activeThreadId;
    if (!targetThreadId) return;

    if (!isServerThreadId(targetThreadId)) return;
    if (get().runsByThread[targetThreadId]) return;

    const attObj =
      typeof attachment === 'object' && attachment !== null ? attachment : undefined;
    const localUrl = attObj ? attObj.localUrl : typeof attachment === 'string' ? attachment : undefined;

    if (!userText.trim() && !localUrl) return;

    const userMsgId = 'user-' + Date.now();
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: userText,
      image: localUrl,
      timestamp: Date.now(),
    };
    get().addMessage(userMsg, targetThreadId);

    const isNewThread = !get().threads.some((t) => t.id === targetThreadId);

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

    if (!get().activeProjectId && isNewThread) {
      get().updateMessage(
        assistantMsgId,
        { content: `**Error:** ${NEEDS_PROJECT}`, status: 'error' },
        targetThreadId
      );
      return;
    }

    const attachmentsToSend =
      attObj && attObj.id ? [{ id: attObj.id, kind: attObj.kind }] : undefined;

    const targetThread = get().threads.find((t) => t.id === targetThreadId);
    const viewingVersion =
      get().activeThreadId === targetThreadId
        ? get().viewingVersion
        : targetThread?.viewingVersion ?? null;

    const versionObj = targetThread?.versions?.find((v) => v.version === viewingVersion);
    const draft =
      get().activeThreadId === targetThreadId
        ? get().activeDraft
        : await getDraft(targetThreadId, viewingVersion);

    let editedBodyToSend: string | undefined;
    let pinnedParamsToSend: Record<string, number> | undefined;

    if (versionObj) {
      if (draft?.editedBody !== undefined && draft.editedBody !== versionObj.body) {
        editedBodyToSend = draft.editedBody;
      }

      if (draft?.pinnedParams && Object.keys(draft.pinnedParams).length > 0) {
        const parsed = parseParams(versionObj.body);
        const diffPins: Record<string, number> = {};
        for (const [name, val] of Object.entries(draft.pinnedParams)) {
          const origParam = parsed.find((p) => p.name === name);
          if (!origParam || origParam.value !== val) {
            diffPins[name] = val;
          }
        }
        if (Object.keys(diffPins).length > 0) {
          pinnedParamsToSend = diffPins;
        }
      }
    }

    const req = buildChatRequest({
      threadId: targetThreadId,
      text: userText,
      viewingVersion,
      attachments: attachmentsToSend,
      pinnedParams: pinnedParamsToSend,
      editedBody: editedBodyToSend,
      model: get().selectedModel,
    });
    if (get().activeProjectId) {
      req.projectId = get().activeProjectId!;
    }

    const sendRes = await sendChat(req);

    if (sendRes.kind === 'error') {
      get().updateMessage(
        assistantMsgId,
        { content: `**Error:** ${sendRes.message}`, status: 'error' },
        targetThreadId
      );
      return;
    }

    // Clear draft after stream or attach
    await clearDraft(targetThreadId, viewingVersion);
    if (get().activeThreadId === targetThreadId) {
      set({ activeDraft: null });
    }

    // If it was a draft thread, add to threads
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
        viewingVersion: null,
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

    await get().consumeRunStream({
      response: sendRes.response,
      threadId: targetThreadId,
      runId: sendRes.runId,
    });
  },

  initializeFromStorage: async () => {
    const activeProjectId = get().activeProjectId;
    if (!activeProjectId) {
      return;
    }
    if (isProjectOpened(activeProjectId)) {
      return;
    }
    await get().openProject(activeProjectId);
  },

  createNewThread: () => {
    return get().newThread();
  },

  switchThread: (threadId) => {
    const target = get().threads.find((t) => t.id === threadId);
    if (!target) return;

    const currentRuns = get().runsByThread;
    const targetRunId = currentRuns[threadId] ?? null;
    const initialCode = target.code ? toBody(target.code) : '';
    const viewingVer = target.viewingVersion ?? null;

    set({
      activeThreadId: target.id,
      messages: target.messages,
      code: initialCode,
      viewingVersion: viewingVer,
      activeDraft: null,
      params: parseParams(initialCode),
      geometry: null,
      parts: [],
      selectedLayerId: null,
      highlightedVersion: null,
      stlContent: target.stlContent || null,
      modelInfo: target.modelInfo || null,
      step: target.step || null,
      selectedModel: target.selectedModel || get().selectedModel,
      compileStatus: 'idle',
      compileError: null,
      compileErrorLine: null,
      inFlightRunId: targetRunId,
      isGenerating: !!targetRunId,
      generatingThreadId: targetRunId ? target.id : null,
    });

    void setActiveThreadId(target.id);
    void getDraft(target.id, viewingVer).then((draft) => {
      if (draft && get().activeThreadId === target.id) {
        set({ activeDraft: draft });
      }
    });

    if (isServerThreadId(target.id)) {
      if (!currentRuns[target.id]) {
        void get().loadServerThread(target.id);
      }
    }
  },

  deleteThread: (threadId) => {
    const { threads, activeThreadId } = get();
    void clearDraft(threadId, null);

    if (threads.length <= 1) {
      if (threads.some((t) => t.id === threadId)) {
        void deleteThreadCascade(threadId);
        if (isServerThreadId(threadId)) {
          void deleteServerThread(threadId).catch(() => {});
        }
      }
      set({ threads: [] });
      get().newThread();
      return;
    }

    const filtered = threads.filter((t) => t.id !== threadId);
    if (filtered.length === 0) {
      set({ threads: [] });
      get().newThread();
      return;
    }
    const newActiveId = activeThreadId === threadId ? filtered[0].id : activeThreadId;
    const newActive = filtered.find((t) => t.id === newActiveId)!;
    const initialCode = newActive.code ? toBody(newActive.code) : '';

    set({
      threads: filtered,
      activeThreadId: newActive.id,
      messages: newActive.messages,
      code: initialCode,
      viewingVersion: newActive.viewingVersion ?? null,
      activeDraft: null,
      params: parseParams(initialCode),
      geometry: null,
      parts: [],
      selectedLayerId: null,
      highlightedVersion: null,
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
  highlightedVersion: null,
  setHighlightedVersion: (version) => set({ highlightedVersion: version }),
  selectedLayerId: null,
  setSelectedLayerId: (id) => set({ selectedLayerId: id }),
  codeDrawerOpen: false,
  setCodeDrawerOpen: (open) => set({ codeDrawerOpen: open }),

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
    const { threads, activeThreadId, viewingVersion } = get();
    const finalCode = toBody(code);

    const currentParams = parseParams(finalCode);

    let newDraft = get().activeDraft;
    if (source === 'user' && targetId === activeThreadId) {
      const prevPins = get().activeDraft?.pinnedParams;
      let nextPins: Record<string, number> | undefined;
      if (prevPins && Object.keys(prevPins).length > 0) {
        nextPins = {};
        for (const [name] of Object.entries(prevPins)) {
          const parsed = currentParams.find((p) => p.name === name);
          if (parsed && typeof parsed.value === 'number' && Number.isFinite(parsed.value)) {
            nextPins[name] = parsed.value;
          }
        }
      }

      newDraft = {
        ...(get().activeDraft || {}),
        editedBody: finalCode,
        pinnedParams: nextPins,
      };
      set({ activeDraft: newDraft });
      void setDraft(targetId, viewingVersion, newDraft);
    }

    const updatedThreads = threads.map((t) =>
      t.id === targetId ? { ...t, code: finalCode, updatedAt: Date.now() } : t
    );

    if (targetId === activeThreadId) {
      set({
        code: finalCode,
        params: currentParams,
        threads: updatedThreads,
      });
    } else {
      set({ threads: updatedThreads });
    }

    setCodeDebounced(targetId, finalCode, Date.now());
  },

  setCompileResult: (result, threadId) => {
    if (result.aborted) return;

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
        compileErrorLine: result.errorLine ?? null,
        geometry: result.geometry || null,
        stlContent: result.stlContent || null,
        modelInfo: result.modelInfo || null,
        step: activeT?.step || null,
        compileTimeMs: result.compileTimeMs || 0,
        threads: updatedThreads,
        parts: result.success ? (result.parts ?? []) : get().parts,
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
    set({
      compileStatus: status,
      compileError: error,
      ...(error === null ? { compileErrorLine: null } : {}),
    }),

  updateViewportSettings: (settings) =>
    set((state) => ({
      viewportSettings: { ...state.viewportSettings, ...settings },
    })),

  setEditorView: (view) => set({ editorView: view }),

  pinParam: (name, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;

    const { activeThreadId, threads, viewingVersion, code } = get();
    const currentThread = threads.find((t) => t.id === activeThreadId);
    const currentDraft: LocalDraft = get().activeDraft ?? {};

    const updatedDraft: LocalDraft = {
      ...currentDraft,
      pinnedParams: {
        ...(currentDraft.pinnedParams || {}),
        [name]: value,
      },
    };

    const newCode = toBody(setParamValue(code, name, value));
    const updatedThreads = threads.map((t) =>
      t.id === activeThreadId ? { ...t, code: newCode, updatedAt: Date.now() } : t
    );

    set({
      threads: updatedThreads,
      code: newCode,
      activeDraft: updatedDraft,
      params: parseParams(newCode),
    });

    void setDraft(activeThreadId, viewingVersion, updatedDraft);
    setCodeDebounced(activeThreadId, newCode, Date.now());

    const versionObj = currentThread?.versions?.find((v) => v.version === viewingVersion);
    const preludeVersion = versionObj?.preludeVersion ?? PRELUDE_VERSION;

    set({ compileStatus: 'compiling' });
    compileModel(newCode, { preludeVersion }).then((result) => {
      get().setCompileResult(result);
    });
  },

  unpinParam: (name) => {
    const { activeThreadId, threads, viewingVersion, code } = get();
    const currentThread = threads.find((t) => t.id === activeThreadId);
    const currentDraft = get().activeDraft;
    if (!currentDraft?.pinnedParams || !(name in currentDraft.pinnedParams)) return;

    const nextPins = { ...currentDraft.pinnedParams };
    delete nextPins[name];

    const updatedDraft: LocalDraft = {
      ...currentDraft,
      pinnedParams: nextPins,
    };

    const versionObj = currentThread?.versions?.find((v) => v.version === viewingVersion);
    const parsed = parseParams(versionObj ? versionObj.body : '');
    const origParam = parsed.find((p) => p.name === name);
    const restoredValue = origParam?.value;

    let newCode = code;
    if (typeof restoredValue === 'number') {
      newCode = toBody(setParamValue(code, name, restoredValue));
    }

    const updatedThreads = threads.map((t) =>
      t.id === activeThreadId ? { ...t, code: newCode, updatedAt: Date.now() } : t
    );

    set({
      threads: updatedThreads,
      code: newCode,
      activeDraft: updatedDraft,
      params: parseParams(newCode),
    });

    void setDraft(activeThreadId, viewingVersion, updatedDraft);
    setCodeDebounced(activeThreadId, newCode, Date.now());

    const preludeVersion = versionObj?.preludeVersion ?? PRELUDE_VERSION;
    set({ compileStatus: 'compiling' });
    compileModel(newCode, { preludeVersion }).then((result) => {
      get().setCompileResult(result);
    });
  },

  unpinAll: () => {
    const { activeThreadId, threads, viewingVersion, code } = get();
    const currentThread = threads.find((t) => t.id === activeThreadId);
    const currentDraft = get().activeDraft;
    if (!currentDraft?.pinnedParams || Object.keys(currentDraft.pinnedParams).length === 0) return;

    const updatedDraft: LocalDraft = {
      ...currentDraft,
      pinnedParams: {},
    };

    const versionObj = currentThread?.versions?.find((v) => v.version === viewingVersion);
    const parsed = parseParams(versionObj ? versionObj.body : '');

    let newCode = code;
    for (const [name] of Object.entries(currentDraft.pinnedParams)) {
      const origParam = parsed.find((p) => p.name === name);
      if (typeof origParam?.value === 'number') {
        newCode = toBody(setParamValue(newCode, name, origParam.value));
      }
    }

    const updatedThreads = threads.map((t) =>
      t.id === activeThreadId ? { ...t, code: newCode, updatedAt: Date.now() } : t
    );

    set({
      threads: updatedThreads,
      code: newCode,
      activeDraft: updatedDraft,
      params: parseParams(newCode),
    });

    void setDraft(activeThreadId, viewingVersion, updatedDraft);
    setCodeDebounced(activeThreadId, newCode, Date.now());

    const preludeVersion = versionObj?.preludeVersion ?? PRELUDE_VERSION;
    set({ compileStatus: 'compiling' });
    compileModel(newCode, { preludeVersion }).then((result) => {
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

  setIsAnnotating: (isAnnotating) => set({ isAnnotating }),
  setBaseSnapshot: (snapshot) => set({ baseSnapshot: snapshot }),

  attachImage: (dataUrl: string, kind: 'markup' | 'reference') => {
    if (attachAbortController) {
      attachAbortController.abort();
    }
    const controller = new AbortController();
    attachAbortController = controller;

    set({
      pendingAttachment: {
        localUrl: dataUrl,
        kind,
        status: 'uploading',
      },
    });

    void (async () => {
      try {
        const blob = dataUrlToBlob(dataUrl);
        const artifactId = await uploadAttachment(blob, controller.signal);
        if (controller.signal.aborted || attachAbortController !== controller) {
          return;
        }
        set({
          pendingAttachment: {
            localUrl: dataUrl,
            kind,
            status: 'ready',
            id: artifactId,
          },
        });
      } catch {
        if (controller.signal.aborted || attachAbortController !== controller) {
          return;
        }
        set({
          pendingAttachment: {
            localUrl: dataUrl,
            kind,
            status: 'failed',
          },
        });
      }
    })();
  },

  retryAttachment: () => {
    const current = get().pendingAttachment;
    if (current && current.status === 'failed') {
      get().attachImage(current.localUrl, current.kind);
    }
  },

  removeAttachment: () => {
    if (attachAbortController) {
      attachAbortController.abort();
      attachAbortController = null;
    }
    set({ pendingAttachment: null });
  },

  setPendingAttachment: (image) => {
    if (!image) {
      get().removeAttachment();
    } else if (typeof image === 'string') {
      get().attachImage(image, 'markup');
    } else {
      set({ pendingAttachment: image });
    }
  },

  resetProject: () => {
    const { threads, activeThreadId } = get();
    const welcomeMsg: ChatMessage = {
      id: 'welcome-msg',
      role: 'assistant',
      content: WELCOME,
      timestamp: Date.now(),
    };
    const resetThreads = threads.map((t) =>
      t.id === activeThreadId
        ? {
            ...t,
            code: '',
            designContract: undefined,
            stlContent: null,
            modelInfo: null,
            step: null,
            messages: [welcomeMsg],
            viewingVersion: null,
            updatedAt: Date.now(),
          }
        : t
    );

    set({
      code: '',
      params: [],
      geometry: null,
      parts: [],
      selectedLayerId: null,
      highlightedVersion: null,
      stlContent: null,
      modelInfo: null,
      step: null,
      viewingVersion: null,
      activeDraft: null,
      compileStatus: 'idle',
      compileError: null,
      compileErrorLine: null,
      messages: [welcomeMsg],
      threads: resetThreads,
    });

    const resetThread = resetThreads.find((t) => t.id === activeThreadId);
    if (resetThread) {
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
