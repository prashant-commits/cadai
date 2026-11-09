import type { StateCreator } from 'zustand';
import type { AppState } from '@/store/app-store';
import {
  listProjects,
  createProject as createProjectApi,
  renameProject as renameProjectApi,
  deleteProject as deleteProjectApi,
  listProjectThreads,
  ServerError,
  type ProjectSummary,
} from '@/lib/client/server-projects';
import { DEFAULT_PROJECT_NAME, RUN_ACTIVE, WELCOME } from '@/lib/persist/phrases';
import { getDraft, loadAllThreads, setActiveThreadId, type LocalDraft } from '@/lib/storage/thread-storage';
import { parseParams } from '@/lib/design/parse-params';
import { setParamValue } from '@/lib/design/write-params';
import { toBody } from '@/lib/brep/prelude';
import { isServerThreadId } from '@/lib/client/server-thread';
import type { ChatThread } from '@/types';
import { toast } from 'sonner';

export type { ProjectSummary };

let navigatorFn: (href: string) => void = (href: string) => {
  if (typeof window !== 'undefined') {
    window.location.assign(href);
  }
};

export function setNavigator(fn: (href: string) => void): void {
  navigatorFn = fn;
}

export function promptToProjectName(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return DEFAULT_PROJECT_NAME;
  if (trimmed.length <= 60) return trimmed;
  const first60 = trimmed.slice(0, 60);
  if (/\s/.test(trimmed[60])) {
    return first60.trimEnd();
  }
  const lastSpace = first60.search(/\s+[^\s]*$/);
  if (lastSpace > 0) {
    return first60.slice(0, lastSpace).trimEnd();
  }
  return first60;
}

let ensureDefaultRan = false;
let openedProjectId: string | null = null;
let openProjectInFlight: { projectId: string; promise: Promise<void> } | null = null;

export function isProjectOpened(id: string): boolean {
  return openedProjectId === id;
}

export function __resetProjectsSliceForTests(): void {
  ensureDefaultRan = false;
  openedProjectId = null;
  openProjectInFlight = null;
}

export interface ProjectsSlice {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  projectsStatus: 'idle' | 'loading' | 'ready' | 'error';

  loadProjects: (search?: string) => Promise<void>;
  openProject: (id: string, threadId?: string) => Promise<void>;
  newThread: () => string;
  startProject: (
    prompt: string,
    options?: {
      attachments?: Array<{ id: string; kind: 'markup' | 'reference'; localUrl?: string }>;
      model?: string;
    }
  ) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
}

export const createProjectsSlice: StateCreator<
  AppState,
  [],
  [],
  ProjectsSlice
> = (set, get) => ({
  projects: [],
  activeProjectId: null,
  projectsStatus: 'idle',

  loadProjects: async (search?: string) => {
    set({ projectsStatus: 'loading' });
    try {
      const projects = await listProjects(search ? { search } : undefined);
      ensureDefaultRan = true;
      set({ projects, projectsStatus: 'ready' });
    } catch {
      set({ projectsStatus: 'error' });
    }
  },

  openProject: async (id: string, threadId?: string) => {
    if (openProjectInFlight && openProjectInFlight.projectId === id) {
      await openProjectInFlight.promise;
      if (threadId && threadId !== get().activeThreadId) {
        const t = get().threads.find((th) => th.id === threadId);
        if (t) {
          get().switchThread(threadId);
        }
      }
      return;
    }

    const promise = (async () => {
      const prevProjectId = get().activeProjectId;
      set({ activeProjectId: id });

      if (!ensureDefaultRan) {
        try {
          const projs = await listProjects();
          ensureDefaultRan = true;
          set({ projects: projs, projectsStatus: 'ready' });
        } catch {
          // Continue if ensureDefault fails
        }
      }

      const serverSummaries = await listProjectThreads(id);
      const { threads: cachedThreads } = await loadAllThreads();

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
          code: '',
        };
      });

      const currentActiveId = get().activeThreadId;
      const currentThreads = get().threads;
      const isAlreadyActiveInProject =
        prevProjectId === id &&
        Boolean(currentActiveId) &&
        !serverThreadsList.some((st) => st.id === currentActiveId);

      const activeDraftThread = isAlreadyActiveInProject
        ? currentThreads.find((t) => t.id === currentActiveId)
        : undefined;

      const finalThreadsList = activeDraftThread
        ? [activeDraftThread, ...serverThreadsList]
        : serverThreadsList;

      set({ threads: finalThreadsList });

      if (
        threadId &&
        threadId === currentActiveId &&
        prevProjectId === id
      ) {
        return;
      }

      if (threadId && serverThreadsList.some((t) => t.id === threadId)) {
        const target = serverThreadsList.find((t) => t.id === threadId)!;
        const initialCode = target.code || '';
        const viewingVer = target.viewingVersion ?? null;
        let initialDraft: LocalDraft | null = null;
        let resolvedCode = initialCode;
        initialDraft = await getDraft(target.id, viewingVer);
        if (initialDraft?.editedBody) {
          resolvedCode = toBody(initialDraft.editedBody);
        }
        if (initialDraft?.pinnedParams) {
          for (const [name, val] of Object.entries(initialDraft.pinnedParams)) {
            if (typeof val === 'number' && Number.isFinite(val)) {
              resolvedCode = toBody(setParamValue(resolvedCode, name, val));
            }
          }
        }

        set({
          activeThreadId: target.id,
          messages: target.messages,
          code: resolvedCode,
          viewingVersion: viewingVer,
          activeDraft: initialDraft,
          params: parseParams(resolvedCode),
          geometry: null,
          stlContent: target.stlContent || null,
          modelInfo: target.modelInfo || null,
          step: target.step || null,
          selectedModel: target.selectedModel || get().selectedModel,
          compileStatus: 'idle',
          compileError: null,
        });
        void setActiveThreadId(target.id);
        if (isServerThreadId(target.id)) {
          await get().loadServerThread(target.id);
        }
      } else if (!threadId && serverThreadsList.length > 0) {
        const newest = [...serverThreadsList].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const initialCode = newest.code || '';
        const viewingVer = newest.viewingVersion ?? null;
        let initialDraft: LocalDraft | null = null;
        let resolvedCode = initialCode;
        initialDraft = await getDraft(newest.id, viewingVer);
        if (initialDraft?.editedBody) {
          resolvedCode = toBody(initialDraft.editedBody);
        }
        if (initialDraft?.pinnedParams) {
          for (const [name, val] of Object.entries(initialDraft.pinnedParams)) {
            if (typeof val === 'number' && Number.isFinite(val)) {
              resolvedCode = toBody(setParamValue(resolvedCode, name, val));
            }
          }
        }

        set({
          activeThreadId: newest.id,
          messages: newest.messages,
          code: resolvedCode,
          viewingVersion: viewingVer,
          activeDraft: initialDraft,
          params: parseParams(resolvedCode),
          geometry: null,
          parts: [],
          selectedLayerId: null,
          highlightedVersion: null,
          stlContent: newest.stlContent || null,
          modelInfo: newest.modelInfo || null,
          step: newest.step || null,
          selectedModel: newest.selectedModel || get().selectedModel,
          compileStatus: 'idle',
          compileError: null,
        });
        void setActiveThreadId(newest.id);
        if (isServerThreadId(newest.id)) {
          await get().loadServerThread(newest.id);
        }
      } else {
        get().newThread();
      }
    })();

    openProjectInFlight = { projectId: id, promise };
    try {
      await promise;
      openedProjectId = id;
    } finally {
      if (openProjectInFlight?.projectId === id) {
        openProjectInFlight = null;
      }
    }
  },

  newThread: () => {
    const id = crypto.randomUUID();
    set({
      activeThreadId: id,
      messages: [
        {
          id: 'welcome-msg',
          role: 'assistant',
          content: WELCOME,
          timestamp: Date.now(),
        },
      ],
      code: '',
      geometry: null,
      parts: [],
      selectedLayerId: null,
      highlightedVersion: null,
      stlContent: null,
      modelInfo: null,
      step: null,
      params: [],
      viewingVersion: null,
      activeDraft: null,
      compileStatus: 'idle',
      compileError: null,
      isGenerating: false,
      generatingThreadId: null,
      inFlightRunId: null,
    });
    const activePid = get().activeProjectId;
    if (activePid) {
      navigatorFn(`/p/${activePid}?t=${id}`);
    }
    return id;
  },

  startProject: async (prompt, options) => {
    const name = promptToProjectName(prompt);
    const project = await createProjectApi(name);

    set((s) => ({
      activeProjectId: project.id,
      projects: [project, ...s.projects.filter((p) => p.id !== project.id)],
    }));

    get().newThread();
    if (options?.model) {
      set({ selectedModel: options.model });
    }

    let attachmentToSend:
      | { id: string; kind: 'markup' | 'reference'; localUrl: string }
      | undefined;
    if (options?.attachments && options.attachments.length > 0) {
      const first = options.attachments[0];
      attachmentToSend = {
        id: first.id,
        kind: first.kind,
        localUrl: first.localUrl ?? '',
      };
    }

    await get().sendMessage(prompt, attachmentToSend);
  },

  deleteProject: async (id: string) => {
    try {
      await deleteProjectApi(id);
    } catch (err) {
      if (err instanceof ServerError && err.code === 'run_active') {
        try {
          toast?.error?.(RUN_ACTIVE);
        } catch {
          // safe in node tests
        }
        return;
      }
      throw err;
    }

    const isOpen = get().activeProjectId === id;
    if (isOpen) {
      openedProjectId = null;
    }
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      ...(isOpen
        ? {
            activeProjectId: null,
            threads: [],
            activeThreadId: '',
            messages: [],
            code: '',
            params: [],
            geometry: null,
            stlContent: null,
            modelInfo: null,
            step: null,
            viewingVersion: null,
            activeDraft: null,
            compileStatus: 'idle',
            compileError: null,
            isGenerating: false,
            generatingThreadId: null,
            inFlightRunId: null,
          }
        : {}),
    }));

    if (isOpen) {
      navigatorFn('/');
      await get().loadProjects();
    }
  },

  renameProject: async (id: string, name: string) => {
    const previous = get().projects;
    set({
      projects: previous.map((p) => (p.id === id ? { ...p, name } : p)),
    });
    try {
      await renameProjectApi(id, name);
    } catch (err) {
      set({ projects: previous });
      throw err;
    }
  },
});
