import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '@/store/app-store';
import { MODELS } from '@/lib/agent/models';
import { AppHeader } from './app-header';
import { FloatingPanel } from './floating-panel';
import {
  Workspace,
  CHAT_COLLAPSED_KEY,
  readCollapsed,
  writeCollapsed,
} from './workspace';
import {
  createProjectMenuActions,
  DELETE_PROJECT_FAILED,
} from './project-menu';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: 'p1' }),
  useSearchParams: () => new URLSearchParams(),
}));

// Mock heavy children with small stubs
vi.mock('@/components/viewport/viewport-panel', () => ({
  ViewportPanel: () => <div data-stub="viewport" />,
}));
vi.mock('@/components/editor/code-editor-panel', () => ({
  CodeEditorPanel: () => <div data-stub="code-editor" />,
}));
vi.mock('@/components/chat/chat-panel', () => ({
  ChatPanel: () => <div data-stub="chat" />,
}));
vi.mock('@/components/inspector/inspector', () => ({
  Inspector: () => <div data-stub="inspector" />,
}));

const origUseSyncExternalStore = React.useSyncExternalStore;

describe('workspace shell', () => {
  beforeEach(() => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    useAppStore.setState({
      projects: [
        {
          id: 'p1',
          name: 'Bracket set',
          updatedAt: Date.now(),
          threadCount: 1,
          thumbnailArtifactId: null,
        },
      ],
      activeProjectId: 'p1',
      editorView: 'design',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the header shows only the logo, "cadai" and the project menu', () => {
    const html = renderToStaticMarkup(<AppHeader />);
    expect(html).toContain('cadai');
    expect(html).toContain('Bracket set');
    expect(html).not.toContain('Engine');
    expect(html).not.toContain('Units');
    expect(html).not.toMatch(/agentic/i);
    expect(html).not.toContain('build123d');
    expect(html).not.toContain('mm');
    expect(html).not.toContain('Reset');
    for (const m of MODELS) {
      expect(html).not.toContain(m.label);
    }
    expect(html).not.toContain('<select');
  });

  it('the chat panel is on the left and collapses to the left edge', () => {
    const wsHtml = renderToStaticMarkup(<Workspace />);
    // the element holding the chat stub has data-side="left"
    expect(wsHtml).toMatch(
      /<[^>]+data-side="left"[^>]*>[\s\S]*?<div data-stub="chat">/
    );

    const onToggle = vi.fn();
    const panelHtml = renderToStaticMarkup(
      <FloatingPanel side="left" collapsed widthPx={380} onToggle={onToggle}>
        <div data-stub="chat" />
      </FloatingPanel>
    );

    expect(panelHtml).toContain('data-collapsed="true"');
    expect(panelHtml).toContain('-translate-x');
    expect(panelHtml).toContain('left-0');
    expect(panelHtml).not.toContain('right-0');
    // Ensure the right-edge positive translation variant is not used
    expect(panelHtml).not.toMatch(/(?:^|\s)translate-x-\[calc\(100%/);
  });

  it('the inspector is on the right', () => {
    const wsHtml = renderToStaticMarkup(<Workspace />);
    expect(wsHtml).toMatch(
      /<[^>]+data-side="right"[^>]*>[\s\S]*?<div data-stub="inspector">/
    );
  });

  it('deleting a project from the menu asks for confirmation first', async () => {
    const deleteProject = vi.fn().mockResolvedValue(undefined);
    const setConfirmOpen = vi.fn();
    const toastError = vi.fn();

    const actions = createProjectMenuActions({
      deleteProject,
      setConfirmOpen,
      toastError,
    });

    actions.requestDelete();
    expect(setConfirmOpen).toHaveBeenCalledWith(true);
    expect(deleteProject).not.toHaveBeenCalled();

    await actions.confirmDelete('p1');
    expect(deleteProject).toHaveBeenCalledTimes(1);
    expect(deleteProject).toHaveBeenCalledWith('p1');

    // When deleteProject rejects with an Error, confirmDelete resolves and toastError gets DELETE_PROJECT_FAILED
    const failingDelete = vi.fn().mockRejectedValue(new Error('Network error'));
    const failingActions = createProjectMenuActions({
      deleteProject: failingDelete,
      setConfirmOpen,
      toastError,
    });

    await expect(failingActions.confirmDelete('p1')).resolves.toBeUndefined();
    expect(toastError).toHaveBeenCalledWith(DELETE_PROJECT_FAILED);
  });

  it('the collapsed state survives a remount when localStorage works and defaults to open when it throws', () => {
    const map = new Map<string, string>();
    const storageMock = {
      getItem: vi.fn((k: string) => map.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => {
        map.set(k, v);
      }),
      removeItem: vi.fn((k: string) => {
        map.delete(k);
      }),
      clear: vi.fn(() => {
        map.clear();
      }),
    };

    vi.stubGlobal('localStorage', storageMock);
    writeCollapsed(CHAT_COLLAPSED_KEY, true);

    const render1 = renderToStaticMarkup(<Workspace />);
    const render2 = renderToStaticMarkup(<Workspace />);

    for (const html of [render1, render2]) {
      expect(html).toMatch(
        /data-side="left"[^>]*data-collapsed="true"|data-collapsed="true"[^>]*data-side="left"/
      );
      expect(html).toMatch(
        /data-side="right"[^>]*data-collapsed="false"|data-collapsed="false"[^>]*data-side="right"/
      );
    }

    // Now stub localStorage whose getItem/setItem throw
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('Access denied');
      }),
      setItem: vi.fn(() => {
        throw new Error('Access denied');
      }),
    });

    expect(readCollapsed(CHAT_COLLAPSED_KEY)).toBe(false);
    expect(() => writeCollapsed(CHAT_COLLAPSED_KEY, true)).not.toThrow();

    const renderThrow = renderToStaticMarkup(<Workspace />);
    expect(renderThrow).toMatch(
      /data-side="left"[^>]*data-collapsed="false"|data-collapsed="false"[^>]*data-side="left"/
    );
    expect(renderThrow).toMatch(
      /data-side="right"[^>]*data-collapsed="false"|data-collapsed="false"[^>]*data-side="right"/
    );

    vi.unstubAllGlobals();
  });
});
