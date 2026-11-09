import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '@/store/app-store';
import { Workspace } from '@/components/workspace/workspace';
import { ViewportToolbar } from '@/components/viewport/viewport-toolbar';
import { PropertiesSection } from '@/components/inspector/properties-section';
import { TOOLS, type ToolDef, REBUILD_FOR_TOOLS } from './tool-registry';
import { __resetToolsSliceForTests } from '@/store/tools-slice';
import { renderOpBlock, type ToolOp } from '@/lib/tools/ops';
import { Wrench } from 'lucide-react';

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
  Inspector: () => <div data-panel="inspector">Inspector Content</div>,
}));

const origUseSyncExternalStore = React.useSyncExternalStore;

describe('tool framework UI', () => {
  const fakeTool: ToolDef = {
    id: 'hole',
    icon: Wrench,
    label: 'Fake Hole',
    needsFace: true,
    modifies: true,
    opKinds: ['hole'],
    Settings: ({ draft }) => (
      <div data-testid="fake-settings">
        <span>Fake Settings Content</span>
        {draft && 'diameterMm' in draft && (
          <span data-testid="hole-dia">dia={draft.diameterMm}</span>
        )}
      </div>
    ),
    initialDraft: (face, plane) => ({
      kind: 'hole',
      id: '',
      part: '',
      plane,
      offset: [0, 0],
      rotationDeg: 0,
      size: 'custom',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 10,
    }),
  };

  beforeEach(() => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    __resetToolsSliceForTests();
    TOOLS.length = 0;
    TOOLS.push(fakeTool);

    useAppStore.setState({
      threads: [
        {
          id: 'th-1',
          title: 'Thread 1',
          createdAt: 1000,
          updatedAt: 1000,
          messages: [],
          code: 'plate = Box(10, 10, 10)\n_cadai_parts = [plate]\n',
          versions: [
            {
              version: 1,
              parentVersion: null,
              origin: 'designer',
              summary: 'v1',
              flags: [],
              body: 'plate = Box(10, 10, 10)\n_cadai_parts = [plate]\n',
              preludeVersion: '1.0',
              stl: 'stl-1',
              step: 'step-1',
              topo: 'topo-1',
              createdAt: 1000,
            },
          ],
        },
      ],
      activeThreadId: 'th-1',
      viewingVersion: 1,
      code: 'plate = Box(10, 10, 10)\n_cadai_parts = [plate]\n',
      activeToolId: null,
      pickedFace: null,
      draftOp: null,
      editingOpId: null,
      selectedLayerId: null,
      preview: { status: 'idle' },
      applyStatus: 'idle',
      applyError: null,
      toolTopology: null,
      topologyStatus: 'none',
      viewportSettings: {
        wireframe: false,
        showEdges: true,
        showAxes: true,
        showGrid: true,
        isOrthographic: false,
        autoRotate: false,
      },
      isAnnotating: false,
      codeDrawerOpen: false,
      params: [],
      parts: [],
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    TOOLS.length = 0;
    __resetToolsSliceForTests();
    vi.unstubAllGlobals();
  });

  it('selecting a tool collapses the chat and opens its settings on the right', () => {
    const storageSpy = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: storageSpy,
      removeItem: vi.fn(),
      clear: vi.fn(),
    });

    useAppStore.getState().selectTool('hole');

    const html = renderToStaticMarkup(<Workspace />);

    // Left floating panel is collapsed specifically
    const leftMatch = html.match(/<[^>]+data-side="left"[^>]*>/);
    expect(leftMatch).not.toBeNull();
    expect(leftMatch![0]).toContain('data-collapsed="true"');

    // Right floating panel is open and renders ToolSettingsPanel
    const rightMatch = html.match(/<[^>]+data-side="right"[^>]*>/);
    expect(rightMatch).not.toBeNull();
    expect(rightMatch![0]).toContain('data-collapsed="false"');
    expect(html).toContain('data-panel="tool-settings"');
    expect(html).toContain('Fake Settings Content');

    // Inspector is not in the DOM
    expect(html).not.toContain('data-panel="inspector"');

    // Preference was not written to storage
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it('face tools are disabled with the rebuild phrase when topology is missing', () => {
    // Version with topo: null
    useAppStore.setState({
      threads: [
        {
          id: 'th-legacy',
          title: 'Legacy',
          createdAt: 1000,
          updatedAt: 1000,
          messages: [],
          code: 'plate = Box(10, 10, 10)\n_cadai_parts = [plate]\n',
          versions: [
            {
              version: 1,
              parentVersion: null,
              origin: 'designer',
              summary: 'v1',
              flags: [],
              body: 'plate = Box(10, 10, 10)\n_cadai_parts = [plate]\n',
              preludeVersion: '1.0',
              stl: 'stl-1',
              step: 'step-1',
              topo: null,
              createdAt: 1000,
            },
          ],
        },
      ],
      activeThreadId: 'th-legacy',
      viewingVersion: 1,
      topologyStatus: 'none',
    });

    const html = renderToStaticMarkup(<ViewportToolbar />);

    // Assert on the fake tool's own button specifically
    const toolBtnMatch = html.match(/<button[^>]+aria-label="Fake Hole[^"]*"[^>]*>/);
    expect(toolBtnMatch).not.toBeNull();
    const btnHtml = toolBtnMatch![0];
    expect(btnHtml).toContain('disabled');
    expect(btnHtml).toContain(REBUILD_FOR_TOOLS);
    expect(btnHtml).toMatch(/title="[^"]*Rebuild this version to use modeling tools\.[^"]*"/);

    // Calling selectTool does nothing
    useAppStore.getState().selectTool('hole');
    expect(useAppStore.getState().activeToolId).toBeNull();
  });

  it('editing an op layer keeps the inspector open', () => {
    const holeOp: ToolOp = {
      kind: 'hole',
      id: 'op_hole12345678',
      part: 'plate',
      plane: { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [2, 3],
      rotationDeg: 30,
      size: 'custom',
      diameterMm: 8.5,
      head: 'none',
      depthMm: 10,
    };
    const block = renderOpBlock(holeOp);
    const codeWithOp = `plate = Box(10, 10, 10)\n${block}\n_cadai_parts = [plate]\n`;

    useAppStore.setState({
      code: codeWithOp,
    });

    useAppStore.getState().editOp('op_hole12345678');

    const html = renderToStaticMarkup(<Workspace />);

    // Inspector is present, tool-settings is absent
    expect(html).toContain('data-panel="inspector"');
    expect(html).not.toContain('data-panel="tool-settings"');

    // Chat is not force-collapsed
    const leftMatch = html.match(/<[^>]+data-side="left"[^>]*>/);
    expect(leftMatch).not.toBeNull();
    expect(leftMatch![0]).toContain('data-collapsed="false"');
  });

  it("an op layer's Properties show that op's parameters", () => {
    const holeOp: ToolOp = {
      kind: 'hole',
      id: 'op_hole12345678',
      part: 'plate',
      plane: { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [2, 3],
      rotationDeg: 30,
      size: 'custom',
      diameterMm: 8.5,
      head: 'none',
      depthMm: 10,
    };

    const block = renderOpBlock(holeOp);
    const codeWithOp = `plate = Box(10, 10, 10)\n${block}\n_cadai_parts = [plate]\n`;

    useAppStore.setState({
      code: codeWithOp,
      selectedLayerId: 'op_hole12345678',
    });

    const html = renderToStaticMarkup(<PropertiesSection />);

    expect(html).toContain('Fake Settings Content');
    expect(html).toContain('dia=8.5');
  });
});
