import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAppStore } from '@/store/app-store';
import { setNavigator, __resetProjectsSliceForTests } from '@/store/projects-slice';
import { WELCOME } from '@/lib/persist/phrases';
import { __resetDbForTests } from '@/lib/storage/thread-storage';
import { DB_NAME } from '@/lib/storage/db-schema';
import * as THREE from 'three';

describe('projects slice', () => {
  beforeEach(async () => {
    await __resetDbForTests();
    __resetProjectsSliceForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });

    useAppStore.setState({
      projects: [],
      activeProjectId: null,
      projectsStatus: 'idle',
      threads: [],
      activeThreadId: '',
      messages: [],
      code: '',
      params: [],
      geometry: null,
      stlContent: null,
      modelInfo: null,
      compileStatus: 'idle',
      compileError: null,
      isGenerating: false,
      generatingThreadId: null,
      editorView: 'design',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setNavigator(() => {});
  });

  it('startProject creates a project, routes to it and sends the first message with projectId', async () => {
    const pid = '11111111-1111-4111-8111-111111111111';
    let projectPostBody: Record<string, unknown> | null = null;
    let chatPostBody: Record<string, unknown> | null = null;
    const navigatedUrls: string[] = [];

    setNavigator((href: string) => {
      navigatedUrls.push(href);
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/projects' && init?.method === 'POST') {
        projectPostBody = JSON.parse(init.body as string);
        return new Response(
          JSON.stringify({
            project: {
              id: pid,
              name: projectPostBody?.name ?? '',
              createdAt: 1000,
              updatedAt: 1000,
            },
          }),
          { status: 201 }
        );
      }

      if (url === '/api/chat' && init?.method === 'POST') {
        chatPostBody = JSON.parse(init.body as string);
        return new Response('{}', {
          status: 200,
          headers: { 'X-Run-Id': 'run-test-1' },
        });
      }

      if (url.startsWith('/api/threads/')) {
        return new Response(
          JSON.stringify({
            id: chatPostBody?.threadId || pid,
            title: projectPostBody?.name || 'Design',
            activeRun: null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    // Prompt longer than 60 characters with a word boundary
    const longPrompt =
      'Design a high-strength parametric NEMA 17 motor mount with adjustable belt tensioner';
    // 60 chars cuts into "adjustable" ("Design a high-strength parametric NEMA 17 motor mount with a")
    // Word boundary trimmed back: "Design a high-strength parametric NEMA 17 motor mount with"

    await useAppStore.getState().startProject(longPrompt);

    expect(projectPostBody).toEqual({
      name: 'Design a high-strength parametric NEMA 17 motor mount with',
    });

    expect(navigatedUrls.length).toBeGreaterThanOrEqual(1);
    const navUrl = navigatedUrls[0];
    const match = navUrl.match(/^\/p\/([^?]+)\?t=(.+)$/);
    expect(match).not.toBeNull();
    const navigatedPid = match![1];
    const navigatedTid = match![2];
    expect(navigatedPid).toBe(pid);

    expect(chatPostBody).toBeDefined();
    expect(chatPostBody!.projectId).toBe(pid);
    expect(chatPostBody!.threadId).toBe(navigatedTid);
  });

  it('newThread shows only the welcome message and an empty viewport', () => {
    const threadId = crypto.randomUUID();
    useAppStore.setState({
      activeProjectId: 'proj-1',
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Existing Thread',
          createdAt: 1000,
          updatedAt: 1000,
          code: 'cube(10);',
          messages: [{ id: 'm1', role: 'user', content: 'make a cube', timestamp: 1000 }],
          versions: [
            {
              version: 1,
              parentVersion: null,
              origin: 'designer',
              summary: 'v1',
              flags: [],
              body: 'cube(10);',
              preludeVersion: '1',
              stl: null,
              step: null,
              createdAt: 1000,
            },
          ],
          viewingVersion: 1,
        },
      ],
      code: 'cube(10);',
      geometry: new THREE.BufferGeometry(),
      viewingVersion: 1,
      messages: [{ id: 'm1', role: 'user', content: 'make a cube', timestamp: 1000 }],
    });

    const newId = useAppStore.getState().newThread();

    const state = useAppStore.getState();
    expect(state.activeThreadId).toBe(newId);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: 'welcome-msg',
      role: 'assistant',
      content: WELCOME,
    });
    expect(state.code).toBe('');
    expect(state.geometry).toBeNull();
    expect(state.viewingVersion).toBeNull();

    // The active thread has no versions
    const activeThreadInList = state.threads.find((t) => t.id === newId);
    expect(activeThreadInList?.versions?.length ?? 0).toBe(0);
  });

  it('deleteProject of the open project routes to / and refreshes the list', async () => {
    const projP = '22222222-2222-4222-8222-222222222222';
    const projOther = '33333333-3333-4333-8333-333333333333';
    const navigatedUrls: string[] = [];

    setNavigator((href: string) => {
      navigatedUrls.push(href);
    });

    useAppStore.setState({
      activeProjectId: projP,
      activeThreadId: 'thread-in-p',
      threads: [
        {
          id: 'thread-in-p',
          title: 'Thread in P',
          createdAt: 1000,
          updatedAt: 1000,
          messages: [],
          code: '',
        },
      ],
      projects: [
        { id: projP, name: 'Project P', updatedAt: 2000, threadCount: 1, thumbnailArtifactId: null },
        { id: projOther, name: 'Other', updatedAt: 1000, threadCount: 0, thumbnailArtifactId: null },
      ],
    });

    let getProjectsCount = 0;
    let deleteProjectCalled = false;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === `/api/projects/${projP}` && init?.method === 'DELETE') {
        deleteProjectCalled = true;
        return new Response(null, { status: 204 });
      }

      if (url.startsWith('/api/projects') && (!init || !init.method || init.method === 'GET')) {
        getProjectsCount++;
        return new Response(
          JSON.stringify({
            projects: [
              { id: projOther, name: 'Other', updatedAt: 1000, threadCount: 0, thumbnailArtifactId: null },
            ],
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    await useAppStore.getState().deleteProject(projP);

    expect(deleteProjectCalled).toBe(true);
    expect(navigatedUrls).toContain('/');
    const state = useAppStore.getState();
    expect(state.activeProjectId).toBeNull();
    expect(getProjectsCount).toBeGreaterThanOrEqual(1);
    expect(state.projects.find((p) => p.id === projP)).toBeUndefined();
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].id).toBe(projOther);
  });

  it('opening the project page right after startProject keeps the new thread', async () => {
    const pid = '44444444-4444-4444-8444-444444444444';
    const navigatedUrls: string[] = [];

    setNavigator((href: string) => {
      navigatedUrls.push(href);
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/projects' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            project: { id: pid, name: 'Gear project', createdAt: 1000, updatedAt: 1000 },
          }),
          { status: 201 }
        );
      }

      if (url === '/api/chat' && init?.method === 'POST') {
        return new Response('{}', {
          status: 200,
          headers: { 'X-Run-Id': 'r-start' },
        });
      }

      if (url === '/api/projects' || url.startsWith('/api/projects?')) {
        return new Response(
          JSON.stringify({
            projects: [{ id: pid, name: 'Gear project', updatedAt: 1000, threadCount: 0, thumbnailArtifactId: null }],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/projects/${pid}/threads` || url.startsWith(`/api/projects/${pid}/threads?`)) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }

      if (url.startsWith('/api/threads/')) {
        const tid = url.replace('/api/threads/', '');
        return new Response(
          JSON.stringify({
            id: tid,
            title: 'Make a 20-tooth GT2 pulley',
            activeRun: null,
            messages: [],
            versions: [],
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    await useAppStore.getState().startProject('Make a 20-tooth GT2 pulley');

    const navUrl = navigatedUrls[0];
    const match = navUrl.match(/^\/p\/([^?]+)\?t=(.+)$/);
    expect(match).not.toBeNull();
    const navigatedTid = match![2];

    // Page mounts and calls openProject(pid, tid)
    await useAppStore.getState().openProject(pid, navigatedTid);

    const state = useAppStore.getState();
    expect(state.activeThreadId).toBe(navigatedTid);
    expect(state.messages.some((m) => m.role === 'user' && m.content.includes('Make a 20-tooth GT2 pulley'))).toBe(true);
    expect(state.threads.some((t) => t.id === navigatedTid)).toBe(true);
  });

  it('initializeFromStorage during an open keeps the thread from the URL', async () => {
    const pid = '55555555-5555-4555-8555-555555555555';
    const threadA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const threadB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    let threadsFetchCount = 0;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/projects' || url.startsWith('/api/projects?')) {
        return new Response(
          JSON.stringify({
            projects: [{ id: pid, name: 'Dual thread project', updatedAt: 2000, threadCount: 2, thumbnailArtifactId: null }],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/projects/${pid}/threads` || url.startsWith(`/api/projects/${pid}/threads?`)) {
        threadsFetchCount++;
        return new Response(
          JSON.stringify({
            threads: [
              { id: threadA, title: 'Thread A', updatedAt: 2000, activeRunId: null },
              { id: threadB, title: 'Thread B', updatedAt: 1000, activeRunId: null },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/threads/${threadB}`) {
        return new Response(
          JSON.stringify({
            id: threadB,
            title: 'Thread B',
            activeRun: null,
            messages: [{ id: 'mb', role: 'user', content: 'Message in B', timestamp: 1000 }],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/threads/${threadA}`) {
        return new Response(
          JSON.stringify({
            id: threadA,
            title: 'Thread A',
            activeRun: null,
            messages: [{ id: 'ma', role: 'user', content: 'Message in A', timestamp: 2000 }],
            versions: [],
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    useAppStore.setState({ activeProjectId: pid });

    const p1 = useAppStore.getState().openProject(pid, threadB);
    const p2 = useAppStore.getState().initializeFromStorage();
    await Promise.all([p1, p2]);

    expect(useAppStore.getState().activeThreadId).toBe(threadB);
    expect(threadsFetchCount).toBe(1);
  });

  it('opening another project does not carry over the active thread', async () => {
    const projA = '11111111-aaaa-4aaa-8aaa-111111111111';
    const projB = '22222222-bbbb-4bbb-8bbb-222222222222';
    const threadX = 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx';
    const threadY = 'yyyyyyyy-yyyy-4yyy-8yyy-yyyyyyyyyyyy';

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/projects' || url.startsWith('/api/projects?')) {
        return new Response(
          JSON.stringify({
            projects: [
              { id: projA, name: 'Project A', updatedAt: 1000, threadCount: 1, thumbnailArtifactId: null },
              { id: projB, name: 'Project B', updatedAt: 2000, threadCount: 1, thumbnailArtifactId: null },
            ],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/projects/${projA}/threads` || url.startsWith(`/api/projects/${projA}/threads?`)) {
        return new Response(
          JSON.stringify({
            threads: [{ id: threadX, title: 'Thread X', updatedAt: 1000, activeRunId: null }],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/projects/${projB}/threads` || url.startsWith(`/api/projects/${projB}/threads?`)) {
        return new Response(
          JSON.stringify({
            threads: [{ id: threadY, title: 'Thread Y', updatedAt: 2000, activeRunId: null }],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/threads/${threadX}`) {
        return new Response(
          JSON.stringify({
            id: threadX,
            title: 'Thread X',
            activeRun: null,
            messages: [{ id: 'mx', role: 'user', content: 'Message in X', timestamp: 1000 }],
            versions: [],
          }),
          { status: 200 }
        );
      }

      if (url === `/api/threads/${threadY}`) {
        return new Response(
          JSON.stringify({
            id: threadY,
            title: 'Thread Y',
            activeRun: null,
            messages: [{ id: 'my', role: 'user', content: 'Message in Y', timestamp: 2000 }],
            versions: [],
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    // Open project A with server thread X active
    await useAppStore.getState().openProject(projA, threadX);
    expect(useAppStore.getState().activeProjectId).toBe(projA);
    expect(useAppStore.getState().activeThreadId).toBe(threadX);

    // Open project B without threadId
    await useAppStore.getState().openProject(projB);

    const state = useAppStore.getState();
    expect(state.activeProjectId).toBe(projB);
    expect(state.activeThreadId).toBe(threadY);
    expect(state.threads.map((t) => t.id)).toEqual([threadY]);
  });
});
