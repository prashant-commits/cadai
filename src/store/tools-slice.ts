import type { StateCreator } from 'zustand';
import type * as THREE from 'three';
import type { AppState } from './app-store';
import type { ToolOp } from '@/lib/tools/ops';
import { applyOp, parseOpBlocks, renderOpBlock, OpTargetError } from '@/lib/tools/ops';
import { fetchTopology, faceAtTriangle, decodeTopology, type Topology, type TopoFace } from '@/lib/geometry/topology';
import {
  type ToolId,
  type ToolDef,
  getTool,
  toolForOpKind,
  facePlane,
  newOpId,
  partVariableForLabel,
  BUILD_FIRST,
  REBUILD_FOR_TOOLS,
  PART_NOT_EDITABLE,
  PREVIEW_FAILED,
  APPLIED,
} from '@/components/tools/tool-registry';
import { parseStlToGeometry } from '@/lib/engine/geometry-utils';
import { RUN_ACTIVE, SAVE_FAILED, COMPILE_FAILED } from '@/lib/persist/phrases';
import { toast } from 'sonner';

export type ToolPreview = {
  status: 'idle' | 'compiling' | 'ready' | 'error';
  geometry?: THREE.BufferGeometry;
  topology?: Topology;
  error?: string;
  errorLine?: number;
};

export type TopologyStatus = 'none' | 'loading' | 'ready' | 'missing';

export interface ToolsSlice {
  activeToolId: ToolId | null;
  pickedFace: TopoFace | null;
  draftOp: ToolOp | null;
  editingOpId: string | null;
  preview: ToolPreview;
  applyStatus: 'idle' | 'applying' | 'error';
  applyError: string | null;
  toolTopology: Topology | null;
  topologyStatus: TopologyStatus;
  selectTool(id: ToolId): void;
  pickFace(triIndex: number): void;
  updateDraft(patch: Partial<ToolOp>): void;
  editOp(opId: string): void;
  apply(): Promise<void>;
  cancel(): void;
  loadVersionTopology(artifactId: string): Promise<Topology | null>;
}

const topologyCache = new Map<string, Topology>();
let previewDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let previewAbortController: AbortController | null = null;

export function __resetToolsSliceForTests(): void {
  topologyCache.clear();
  if (previewDebounceTimer) {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = null;
  }
  if (previewAbortController) {
    previewAbortController.abort();
    previewAbortController = null;
  }
}

export function replaceOpInBody(body: string, op: ToolOp): string {
  const blocks = parseOpBlocks(body);
  const match = blocks.find((b) => b.op.id === op.id);
  if (!match) {
    throw new OpTargetError(`Op "${op.id}" not found in body`);
  }
  let rendered = renderOpBlock(op);

  if (op.kind === 'text' && match.op.kind === 'text') {
    const oldTextOp = match.op;
    const newTextOp = op;
    if (newTextOp.color === oldTextOp.color) {
      const oldBlockText = body.slice(match.start, match.end);
      const matStartMarker = `# cadai:op material id=${op.id}_color`;
      const matEndMarker = `# cadai:end ${op.id}_color`;
      const oldMatStart = oldBlockText.indexOf(matStartMarker);
      const oldMatEnd = oldMatStart !== -1 ? oldBlockText.indexOf(matEndMarker, oldMatStart) : -1;
      if (oldMatStart !== -1 && oldMatEnd !== -1) {
        const oldLineEnd = oldBlockText.indexOf('\n', oldMatEnd);
        const oldMatBlockText = oldBlockText.slice(
          oldMatStart,
          oldLineEnd === -1 ? oldBlockText.length : oldLineEnd + 1
        );

        const newMatStart = rendered.indexOf(matStartMarker);
        const newMatEnd = newMatStart !== -1 ? rendered.indexOf(matEndMarker, newMatStart) : -1;
        if (newMatStart !== -1 && newMatEnd !== -1) {
          const newLineEnd = rendered.indexOf('\n', newMatEnd);
          const newMatBlockEnd = newLineEnd === -1 ? rendered.length : newLineEnd + 1;
          rendered = rendered.slice(0, newMatStart) + oldMatBlockText + rendered.slice(newMatBlockEnd);
        }
      }
    }
  }

  const before = body.slice(0, match.start);
  const after = body.slice(match.end);
  const hasTrailingNewline = body.slice(match.start, match.end).endsWith('\n');
  const replacement = hasTrailingNewline && !rendered.endsWith('\n') ? `${rendered}\n` : rendered;
  return before + replacement + after;
}

export function draftBody(state: AppState): string | null {
  if (!state.draftOp) return null;
  if (state.editingOpId) {
    return replaceOpInBody(state.code, state.draftOp);
  }
  return applyOp(state.code, state.draftOp);
}

export function toolAvailability(state: AppState, tool: ToolDef): string | null {
  if (!tool.needsFace) return null;

  const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
  const currentVersion = activeThread?.versions?.find((v) => v.version === state.viewingVersion);

  if (!currentVersion) {
    return BUILD_FIRST;
  }

  if (!currentVersion.topo || state.topologyStatus === 'missing') {
    return REBUILD_FOR_TOOLS;
  }

  return null;
}

function triggerPreview(get: () => AppState, set: (fn: (prev: AppState) => Partial<AppState>) => void): void {
  if (previewDebounceTimer) {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = null;
  }

  // Pre-validate body generation
  try {
    const body = draftBody(get());
    if (body === null) return;
  } catch (err) {
    if (err instanceof OpTargetError) {
      set(() => ({
        preview: { status: 'error', error: PART_NOT_EDITABLE },
      }));
      return;
    }
  }

  previewDebounceTimer = setTimeout(async () => {
    previewDebounceTimer = null;

    const state = get();
    if (!state.draftOp || (state.activeToolId === null && state.editingOpId === null)) {
      return;
    }

    let body: string | null = null;
    try {
      body = draftBody(state);
    } catch (err) {
      if (err instanceof OpTargetError) {
        set(() => ({
          preview: { status: 'error', error: PART_NOT_EDITABLE },
        }));
      }
      return;
    }

    if (!body) return;

    if (previewAbortController) {
      previewAbortController.abort();
      previewAbortController = null;
    }

    const abortController = new AbortController();
    previewAbortController = abortController;
    const signal = abortController.signal;

    set((s) => ({
      preview: { ...s.preview, status: 'compiling' },
    }));

    const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
    const version = activeThread?.versions?.find((v) => v.version === state.viewingVersion);
    const preludeVersion = version?.preludeVersion;

    try {
      const res = await fetch('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: body,
          language: 'build123d',
          preludeVersion,
          topology: true,
        }),
        signal,
      });

      if (signal.aborted) return;

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        if (signal.aborted) return;
        set(() => ({
          preview: {
            status: 'error',
            error: PREVIEW_FAILED,
            errorLine: typeof json?.line === 'number' ? json.line : undefined,
          },
        }));
        return;
      }

      const data = await res.json();
      if (signal.aborted) return;

      if (!data.success) {
        set(() => ({
          preview: {
            status: 'error',
            error: PREVIEW_FAILED,
            errorLine: typeof data?.line === 'number' ? data.line : undefined,
          },
        }));
        return;
      }

      let geometry: THREE.BufferGeometry | undefined;
      if (data.stl) {
        const parsed = parseStlToGeometry(data.stl);
        geometry = parsed.geometry;
      }

      let topology: Topology | undefined;
      if (data.topology) {
        try {
          topology = decodeTopology(data.topology);
        } catch {
          // ignore topology decode errors
        }
      }

      if (get().preview.geometry) {
        get().preview.geometry?.dispose();
      }

      set(() => ({
        preview: {
          status: 'ready',
          geometry,
          topology,
        },
      }));
    } catch (err: unknown) {
      if (signal.aborted) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      set(() => ({
        preview: {
          status: 'error',
          error: PREVIEW_FAILED,
        },
      }));
    }
  }, 400);
}

export const createToolsSlice: StateCreator<
  AppState,
  [],
  [],
  ToolsSlice
> = (set, get) => ({
  activeToolId: null,
  pickedFace: null,
  draftOp: null,
  editingOpId: null,
  preview: { status: 'idle' },
  applyStatus: 'idle',
  applyError: null,
  toolTopology: null,
  topologyStatus: 'none',

  loadVersionTopology: async (artifactId: string) => {
    if (!artifactId) return null;
    if (topologyCache.has(artifactId)) {
      return topologyCache.get(artifactId)!;
    }
    const topo = await fetchTopology(artifactId);
    if (topo) {
      topologyCache.set(artifactId, topo);
    }
    return topo;
  },

  selectTool: (id: ToolId) => {
    if (get().activeToolId === id) {
      get().cancel();
      return;
    }

    const tool = getTool(id);
    if (!tool) return;

    const disabledReason = toolAvailability(get(), tool);
    if (disabledReason !== null) {
      return;
    }

    if (previewDebounceTimer) {
      clearTimeout(previewDebounceTimer);
      previewDebounceTimer = null;
    }
    if (previewAbortController) {
      previewAbortController.abort();
      previewAbortController = null;
    }

    if (get().preview.geometry) {
      get().preview.geometry?.dispose();
    }

    set(() => ({
      activeToolId: id,
      pickedFace: null,
      draftOp: null,
      editingOpId: null,
      preview: { status: 'idle' },
      applyStatus: 'idle',
      applyError: null,
      toolTopology: null,
      topologyStatus: tool.needsFace ? 'loading' : 'none',
    }));

    if (tool.needsFace) {
      const activeThread = get().threads.find((t) => t.id === get().activeThreadId);
      const currentVersion = activeThread?.versions?.find((v) => v.version === get().viewingVersion);
      if (!currentVersion?.topo) {
        set(() => ({ topologyStatus: 'missing', toolTopology: null }));
        return;
      }

      void get()
        .loadVersionTopology(currentVersion.topo)
        .then((topo) => {
          if (get().activeToolId !== id) return;
          if (!topo) {
            set(() => ({ topologyStatus: 'missing', toolTopology: null }));
          } else {
            set(() => ({ topologyStatus: 'ready', toolTopology: topo }));
          }
        });
    }
  },

  pickFace: (triIndex: number) => {
    const topo = get().toolTopology;
    if (!topo) return;

    const face = faceAtTriangle(topo, triIndex);
    if (!face) return;

    set(() => ({ pickedFace: face }));

    const plane = facePlane(face);
    if (!plane) {
      set(() => ({ draftOp: null }));
      return;
    }

    const partVar = partVariableForLabel(get().code, face.part);
    if (!partVar) {
      set(() => ({
        draftOp: null,
        preview: { status: 'error', error: PART_NOT_EDITABLE },
      }));
      return;
    }

    const activeTool = getTool(get().activeToolId);
    if (!activeTool) return;

    const initial = activeTool.initialDraft(face, plane);
    if (!initial) {
      set(() => ({ draftOp: null }));
      return;
    }

    const draft = {
      ...initial,
      id: get().editingOpId ?? newOpId(initial.kind),
      part: partVar,
      plane,
    } as ToolOp;

    set(() => ({ draftOp: draft }));
    triggerPreview(get, set);
  },

  updateDraft: (patch: Partial<ToolOp>) => {
    const current = get().draftOp;
    if (!current) return;

    const next = { ...current, ...patch } as ToolOp;
    set(() => ({ draftOp: next }));
    triggerPreview(get, set);
  },

  editOp: (opId: string) => {
    const parsed = parseOpBlocks(get().code);
    const found = parsed.find((p) => p.op.id === opId);
    if (!found) return;

    const tool = toolForOpKind(found.op.kind);

    if (previewDebounceTimer) {
      clearTimeout(previewDebounceTimer);
      previewDebounceTimer = null;
    }
    if (previewAbortController) {
      previewAbortController.abort();
      previewAbortController = null;
    }

    if (get().preview.geometry) {
      get().preview.geometry?.dispose();
    }

    set(() => ({
      editingOpId: opId,
      activeToolId: null,
      draftOp: found.op,
      pickedFace: null,
      applyStatus: 'idle',
      applyError: null,
      preview: { status: 'idle' },
      topologyStatus: tool?.needsFace ? 'loading' : 'none',
    }));

    if (tool?.needsFace) {
      const activeThread = get().threads.find((t) => t.id === get().activeThreadId);
      const currentVersion = activeThread?.versions?.find((v) => v.version === get().viewingVersion);
      if (currentVersion?.topo) {
        void get()
          .loadVersionTopology(currentVersion.topo)
          .then((topo) => {
            if (get().editingOpId !== opId) return;
            if (!topo) {
              set(() => ({ topologyStatus: 'missing', toolTopology: null }));
            } else {
              set(() => ({ topologyStatus: 'ready', toolTopology: topo }));
            }
          });
      } else {
        set(() => ({ topologyStatus: 'missing', toolTopology: null }));
      }
    }
  },

  apply: async () => {
    const draft = get().draftOp;
    if (!draft) return;

    const activeTool = getTool(get().activeToolId) ?? (get().editingOpId ? toolForOpKind(draft.kind) : undefined);
    if (activeTool && !activeTool.modifies) return;

    const threadId = get().activeThreadId;
    const baseVersion = get().viewingVersion;
    if (!threadId || baseVersion === null) return;

    let body: string | null = null;
    try {
      body = draftBody(get());
    } catch {
      set(() => ({ applyStatus: 'error', applyError: SAVE_FAILED }));
      return;
    }

    if (!body) return;

    set(() => ({ applyStatus: 'applying', applyError: null }));

    try {
      const res = await fetch(`/api/threads/${threadId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientMessageId: crypto.randomUUID(),
          baseVersion,
          body,
          op: draft,
        }),
      });

      if (res.status === 201) {
        const json = await res.json();
        const newVersion = json.version;
        await get().loadServerThread(threadId, newVersion);
        toast.success(APPLIED);
        get().cancel();
        return;
      }

      const json = await res.json().catch(() => ({}));
      if (res.status === 409 && json?.error?.code === 'run_active') {
        set(() => ({
          applyStatus: 'error',
          applyError: RUN_ACTIVE,
        }));
        return;
      }

      if (res.status === 422) {
        set(() => ({
          applyStatus: 'error',
          applyError: json?.error?.message || COMPILE_FAILED,
        }));
        return;
      }

      set(() => ({
        applyStatus: 'error',
        applyError: json?.error?.message || SAVE_FAILED,
      }));
    } catch {
      set(() => ({
        applyStatus: 'error',
        applyError: SAVE_FAILED,
      }));
    }
  },

  cancel: () => {
    if (previewDebounceTimer) {
      clearTimeout(previewDebounceTimer);
      previewDebounceTimer = null;
    }
    if (previewAbortController) {
      previewAbortController.abort();
      previewAbortController = null;
    }

    if (get().preview.geometry) {
      get().preview.geometry?.dispose();
    }

    set(() => ({
      activeToolId: null,
      pickedFace: null,
      draftOp: null,
      editingOpId: null,
      preview: { status: 'idle' },
      applyStatus: 'idle',
      applyError: null,
    }));
  },
});
