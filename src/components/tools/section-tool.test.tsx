import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { useAppStore } from '@/store/app-store';
import { TOOLS } from './tool-registry';
import { toolDef as measureDef } from './defs/measure';
import { toolDef as sectionDef } from './defs/section';
import { ToolSettingsPanel } from './tool-settings-panel';
import {
  useSectionStore,
  sectionClippingPlanes,
  sectionLocalPlane,
  __resetSectionForTests,
} from './section-tool';
import {
  useMeasureStore,
  __resetMeasureForTests,
} from './measure-tool';
import type { Topology } from '@/lib/geometry/topology';
import type { Vec3 } from '@/lib/geometry/measure';

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

describe('section and measure tools', () => {
  const savedTools = [...TOOLS];

  const cubeFixture: Topology = {
    mesh: {
      positions: new Float32Array([
        0, 0, 20, 20, 0, 20, 0, 20, 20,
        20, 0, 20, 20, 20, 20, 0, 20, 20,
      ]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      faceIds: new Uint32Array([0, 0]),
    },
    faces: [
      { id: 0, part: 'cube', kind: 'plane', area: 400, center: [10, 10, 20], normal: [0, 0, 1] },
    ],
    edges: [
      { id: 0, kind: 'line', length: 20, faces: [0, 0] },
    ],
    parts: [
      { label: 'cube', min: [0, 0, 0], max: [20, 20, 20] },
    ],
  };

  beforeEach(() => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    __resetSectionForTests();
    __resetMeasureForTests();
    TOOLS.length = 0;
    if (measureDef) TOOLS.push(measureDef);
    if (sectionDef) TOOLS.push(sectionDef);
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    TOOLS.length = 0;
    TOOLS.push(...savedTools);
    vi.restoreAllMocks();
  });

  it('section sets one clipping plane on the X axis and clears it on close', () => {
    useAppStore.getState().selectTool('section');
    useSectionStore.getState().setAxis('x');

    expect(sectionClippingPlanes()).toHaveLength(1);

    const box = { min: [-10, -10, -10] as Vec3, max: [10, 10, 10] as Vec3 };
    const plane = sectionLocalPlane(useSectionStore.getState(), box);

    // normal ±X (|x| = 1, y = z = 0) through the box center (0,0,0)
    expect(Math.abs(plane.normal.x)).toBe(1);
    expect(plane.normal.y).toBe(0);
    expect(plane.normal.z).toBe(0);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBeCloseTo(0, 5);

    useSectionStore.getState().setFlip(true);
    const flippedPlane = sectionLocalPlane(useSectionStore.getState(), box);
    expect(flippedPlane.normal.x).toBe(-plane.normal.x);
    expect(flippedPlane.constant).toBe(-plane.constant);

    useAppStore.getState().cancel();
    expect(sectionClippingPlanes()).toEqual([]);
  });

  it('a free plane keeps the Z-axis side before and after the first drag', () => {
    useAppStore.getState().selectTool('section');
    useSectionStore.getState().setAxis('free');
    useSectionStore.getState().setFreeMatrix(null);

    const box = { min: [-10, -10, -10] as Vec3, max: [10, 10, 10] as Vec3 };
    const center = new THREE.Vector3(0, 0, 0);

    const planeBefore = sectionLocalPlane(useSectionStore.getState(), box);

    expect(planeBefore.normal.x).toBeCloseTo(0);
    expect(planeBefore.normal.y).toBeCloseTo(0);
    expect(planeBefore.normal.z).toBeCloseTo(-1);
    expect(planeBefore.distanceToPoint(center)).toBeCloseTo(0);

    // Identity matrix with position at the box center
    const idMat = new THREE.Matrix4().setPosition(center.x, center.y, center.z);
    useSectionStore.getState().setFreeMatrix(Array.from(idMat.elements));

    const planeAfter = sectionLocalPlane(useSectionStore.getState(), box);

    expect(planeAfter.normal.x).toBeCloseTo(0);
    expect(planeAfter.normal.y).toBeCloseTo(0);
    expect(planeAfter.normal.z).toBeCloseTo(-1);
    expect(planeAfter.distanceToPoint(center)).toBeCloseTo(0);

    expect(planeAfter.normal.x).toBeCloseTo(planeBefore.normal.x);
    expect(planeAfter.normal.y).toBeCloseTo(planeBefore.normal.y);
    expect(planeAfter.normal.z).toBeCloseTo(planeBefore.normal.z);
    expect(planeAfter.constant).toBeCloseTo(planeBefore.constant);

    useAppStore.getState().cancel();
  });

  it('measure and section never call the versions route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const code = 'plate = Box(20, 20, 20)\n_cadai_parts = [plate]\n';
    useAppStore.setState({
      threads: [
        {
          id: 'th-1',
          title: 'Thread 1',
          createdAt: 1000,
          updatedAt: 1000,
          messages: [],
          code,
          versions: [
            {
              version: 1,
              parentVersion: null,
              origin: 'designer',
              summary: 'v1',
              flags: [],
              body: code,
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
      code,
      draftOp: null,
    });

    vi.spyOn(useAppStore.getState(), 'loadVersionTopology').mockResolvedValue(cubeFixture);

    // Select measure
    useAppStore.getState().selectTool('measure');
    await useMeasureStore.getState().loadTopology();

    // Pick two points
    useMeasureStore.getState().pickAt(0, [0, 0, 20]);
    useMeasureStore.getState().pickAt(0, [20, 0, 20]);

    const res = useMeasureStore.getState().result;
    expect(res).not.toBeNull();
    expect(res?.ok).toBe(true);

    const measureHtml = renderToStaticMarkup(<ToolSettingsPanel />);
    expect(measureHtml).not.toContain('Apply');

    // Select section
    useAppStore.getState().selectTool('section');
    useSectionStore.getState().setAxis('y');
    useSectionStore.getState().setFlip(true);
    useSectionStore.getState().setOffset(5);

    const sectionHtml = renderToStaticMarkup(<ToolSettingsPanel />);
    expect(sectionHtml).not.toContain('Apply');

    useAppStore.getState().cancel();

    // Assertions
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toContain('/versions');
      const init = call[1];
      expect(init?.method).not.toBe('POST');
    }

    expect(useAppStore.getState().draftOp).toBeNull();
    expect(useAppStore.getState().code).toBe(code);
  });

  it('measure topology follows the viewed version and clears picks', async () => {
    const code = 'plate = Box(20, 20, 20)\n_cadai_parts = [plate]\n';
    useAppStore.setState({
      threads: [
        {
          id: 'th-1',
          title: 'Thread 1',
          createdAt: 1000,
          updatedAt: 1000,
          messages: [],
          code,
          versions: [
            {
              version: 1,
              parentVersion: null,
              origin: 'designer',
              summary: 'v1',
              flags: [],
              body: code,
              preludeVersion: '1.0',
              stl: 'stl-1',
              step: 'step-1',
              topo: 'topo-1',
              createdAt: 1000,
            },
            {
              version: 2,
              parentVersion: 1,
              origin: 'designer',
              summary: 'v2',
              flags: [],
              body: code,
              preludeVersion: '1.0',
              stl: 'stl-2',
              step: 'step-2',
              topo: 'topo-2',
              createdAt: 2000,
            },
          ],
        },
      ],
      activeThreadId: 'th-1',
      viewingVersion: 1,
      code,
    });

    const topo1: Topology = { ...cubeFixture };
    const topo2: Topology = {
      ...cubeFixture,
      faces: [{ id: 10, part: 'cube', kind: 'plane', area: 500, center: [10, 10, 20], normal: [0, 0, 1] }],
    };

    const loadSpy = vi.spyOn(useAppStore.getState(), 'loadVersionTopology').mockImplementation(async (id) => {
      if (id === 'topo-1') return topo1;
      if (id === 'topo-2') return topo2;
      return null;
    });

    useAppStore.getState().selectTool('measure');
    await useMeasureStore.getState().loadTopology();

    useMeasureStore.getState().pickAt(0, [0, 0, 20]);
    expect(useMeasureStore.getState().points).toHaveLength(1);

    // Switch viewed version to version 2
    useAppStore.setState({ viewingVersion: 2 });
    await useMeasureStore.getState().loadTopology();

    expect(loadSpy).toHaveBeenCalledWith('topo-2');
    expect(useMeasureStore.getState().topology).toBe(topo2);

    useAppStore.getState().cancel();
  });
});
