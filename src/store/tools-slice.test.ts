import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAppStore } from '@/store/app-store';
import { __resetToolsSliceForTests, draftBody, replaceOpInBody } from './tools-slice';
import { TOOLS, type ToolDef, facePlane } from '@/components/tools/tool-registry';
import { isValidOpId, type ToolOp, applyOp, parseOpBlocks } from '@/lib/tools/ops';
import { RUN_ACTIVE } from '@/lib/persist/phrases';
import type { Topology, TopoFace } from '@/lib/geometry/topology';
import { Wrench } from 'lucide-react';

describe('tools-slice', () => {
  const fakeTool: ToolDef = {
    id: 'hole',
    icon: Wrench,
    label: 'Hole Tool',
    needsFace: true,
    modifies: true,
    opKinds: ['hole', 'cut-rect'],
    Settings: () => null,
    initialDraft: (face, plane) => ({
      kind: 'hole',
      id: '',
      part: '',
      plane,
      offset: [0, 0],
      rotationDeg: 0,
      size: 'custom',
      diameterMm: 5,
      head: 'none',
      depthMm: 10,
    }),
  };

  beforeEach(() => {
    __resetToolsSliceForTests();
    vi.restoreAllMocks();

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
          code: 'lid = Box(20, 20, 10)\n_cadai_parts = [lid]\n',
          versions: [
            {
              version: 4,
              parentVersion: 3,
              origin: 'user_edit',
              summary: 'v4',
              flags: [],
              body: 'lid = Box(20, 20, 10)\n_cadai_parts = [lid]\n',
              preludeVersion: '1.0',
              stl: 'stl-4',
              step: 'step-4',
              topo: 'topo-4',
              createdAt: 1000,
            },
          ],
        },
      ],
      activeThreadId: 'th-1',
      viewingVersion: 4,
      code: 'lid = Box(20, 20, 10)\n_cadai_parts = [lid]\n',
      activeToolId: null,
      pickedFace: null,
      draftOp: null,
      editingOpId: null,
      preview: { status: 'idle' },
      applyStatus: 'idle',
      applyError: null,
      toolTopology: null,
      topologyStatus: 'none',
    });
  });

  afterEach(() => {
    TOOLS.length = 0;
    __resetToolsSliceForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('picking a face creates a draft op on that face\'s plane', () => {
    // 1. Test facePlane directly for normal calculation, top/bottom face (|z| > 0.9) vs front face
    const topFace: TopoFace = {
      id: 1,
      part: 'lid',
      kind: 'plane',
      area: 400,
      center: [10, 10, 10],
      normal: [0, 0, 1],
    };
    const topPlane = facePlane(topFace);
    expect(topPlane).toEqual({
      origin: [10, 10, 10],
      normal: [0, 0, 1],
      xDir: [1, 0, 0],
    });

    const frontFace: TopoFace = {
      id: 2,
      part: 'lid',
      kind: 'plane',
      area: 200,
      center: [10, 0, 5],
      normal: [0, -1, 0],
    };
    const frontPlane = facePlane(frontFace);
    expect(frontPlane).toEqual({
      origin: [10, 0, 5],
      normal: [0, -1, 0],
      xDir: [1, 0, 0],
    });

    const cylinderFace: TopoFace = {
      id: 3,
      part: 'lid',
      kind: 'cylinder',
      area: 200,
      center: [0, 0, 5],
    };
    expect(facePlane(cylinderFace)).toBeNull();

    // 2. Set up store with topology having the top face
    const fakeTopology: Topology = {
      mesh: {
        positions: new Float32Array([0, 0, 10, 20, 0, 10, 20, 20, 10]),
        indices: new Uint32Array([0, 1, 2]),
        faceIds: new Uint32Array([1]),
      },
      faces: [topFace],
      edges: [],
      parts: [{ label: 'lid', min: [0, 0, 0], max: [20, 20, 10] }],
    };

    useAppStore.setState({
      activeToolId: 'hole',
      toolTopology: fakeTopology,
      topologyStatus: 'ready',
    });

    useAppStore.getState().pickFace(0);

    const state = useAppStore.getState();
    expect(state.draftOp).not.toBeNull();
    const draft = state.draftOp!;
    expect(draft.kind).toBe('hole');
    if (draft.kind !== 'hole') throw new Error('expected hole draft');
    expect(draft.plane).toEqual({
      origin: [10, 10, 10],
      normal: [0, 0, 1],
      xDir: [1, 0, 0],
    });
    expect(draft.part).toBe('lid');
    expect(isValidOpId(draft.id)).toBe(true);
  });

  it('updateDraft debounces one preview compile per 400 ms burst', () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        stl: 'solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 1 1 0\nendloop\nendfacet\nendsolid',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const initialDraft: ToolOp = {
      kind: 'hole',
      id: 'op_hole12345678',
      part: 'lid',
      plane: { origin: [10, 10, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      size: 'custom',
      diameterMm: 5,
      head: 'none',
      depthMm: 10,
    };

    useAppStore.setState({
      activeToolId: 'hole',
      draftOp: initialDraft,
    });

    // 3 updates within 400 ms
    useAppStore.getState().updateDraft({ offset: [1, 0] });
    vi.advanceTimersByTime(100);
    useAppStore.getState().updateDraft({ offset: [2, 0] });
    vi.advanceTimersByTime(100);
    useAppStore.getState().updateDraft({ offset: [3, 0] });

    expect(fetchMock).not.toHaveBeenCalled();

    // Advance 400 ms from last update
    vi.advanceTimersByTime(400);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/compile');
    const reqBody = JSON.parse(options.body);
    expect(reqBody.topology).toBe(true);
    expect(reqBody.code).toContain('op_hole12345678');
    expect(reqBody.code).toContain('lid = lid - op_hole12345678_cutter');

    // A second burst
    vi.advanceTimersByTime(500);
    useAppStore.getState().updateDraft({ offset: [4, 0] });
    vi.advanceTimersByTime(400);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('apply posts the op and loads the new version', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 201,
      ok: true,
      json: async () => ({ version: 5 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const loadServerThreadMock = vi.fn().mockResolvedValue(null);
    useAppStore.setState({ loadServerThread: loadServerThreadMock });

    const draft: ToolOp = {
      kind: 'hole',
      id: 'op_hole12345678',
      part: 'lid',
      plane: { origin: [10, 10, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      size: 'custom',
      diameterMm: 5,
      head: 'none',
      depthMm: 10,
    };

    useAppStore.setState({
      activeToolId: 'hole',
      draftOp: draft,
      viewingVersion: 4,
      activeThreadId: 'th-1',
    });

    const expectedBody = draftBody(useAppStore.getState());
    expect(expectedBody).not.toBeNull();
    expect(expectedBody).toContain('# cadai:op');

    await useAppStore.getState().apply();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/threads/th-1/versions');
    expect(options.method).toBe('POST');
    const reqBody = JSON.parse(options.body);
    expect(typeof reqBody.clientMessageId).toBe('string');
    expect(reqBody.baseVersion).toBe(4);
    expect(reqBody.body).toBe(expectedBody);
    expect(reqBody.body).toContain('# cadai:op');
    expect(reqBody.op).toEqual(draft);

    expect(loadServerThreadMock).toHaveBeenCalledWith('th-1', 5);

    const state = useAppStore.getState();
    expect(state.activeToolId).toBeNull();
    expect(state.draftOp).toBeNull();
  });

  it('apply shows the RUN_ACTIVE phrase on 409 and keeps the draft', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 409,
      ok: false,
      json: async () => ({
        error: { code: 'run_active', message: RUN_ACTIVE },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const loadServerThreadMock = vi.fn().mockResolvedValue(null);
    useAppStore.setState({ loadServerThread: loadServerThreadMock });

    const draft: ToolOp = {
      kind: 'hole',
      id: 'op_hole12345678',
      part: 'lid',
      plane: { origin: [10, 10, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      size: 'custom',
      diameterMm: 5,
      head: 'none',
      depthMm: 10,
    };

    useAppStore.setState({
      activeToolId: 'hole',
      draftOp: draft,
      viewingVersion: 4,
      activeThreadId: 'th-1',
    });

    await useAppStore.getState().apply();

    const state = useAppStore.getState();
    expect(state.applyError).toBe(RUN_ACTIVE);
    expect(state.draftOp).toEqual(draft);
    expect(state.activeToolId).toBe('hole');
    expect(loadServerThreadMock).not.toHaveBeenCalled();
  });

  it('cancel makes no request and leaves the design unchanged', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const initialCode = 'lid = Box(20, 20, 10)\n_cadai_parts = [lid]\n';
    const draft: ToolOp = {
      kind: 'hole',
      id: 'op_hole12345678',
      part: 'lid',
      plane: { origin: [10, 10, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      size: 'custom',
      diameterMm: 5,
      head: 'none',
      depthMm: 10,
    };

    useAppStore.setState({
      code: initialCode,
      activeToolId: 'hole',
      draftOp: draft,
      editingOpId: 'op_hole12345678',
      preview: { status: 'ready' },
      applyStatus: 'error',
      applyError: 'some error',
    });

    useAppStore.getState().cancel();

    expect(fetchMock).not.toHaveBeenCalled();

    const state = useAppStore.getState();
    expect(state.code).toBe(initialCode);
    expect(state.activeToolId).toBeNull();
    expect(state.draftOp).toBeNull();
    expect(state.editingOpId).toBeNull();
    expect(state.preview.status).toBe('idle');
    expect(state.applyStatus).toBe('idle');
    expect(state.applyError).toBeNull();
  });

  it('re-editing a text keeps a material changed by the Texture tool', () => {
    const initialCode =
      'plate = Box(60, 40, 5)\nplate.label = "plate"\n_cadai_parts = [plate]\nresult = plate\n';
    const textOpA: ToolOp = {
      kind: 'text',
      id: 'op_text123456',
      part: 'plate',
      plane: { origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      text: 'HELLO',
      font: 'inter-bold',
      sizeMm: 10,
      mode: 'emboss',
      depthMm: 2,
      color: '#112233',
    };

    // 1. apply a text op with color A
    const body1 = applyOp(initialCode, textOpA);
    const parsed1 = parseOpBlocks(body1);
    expect(parsed1).toHaveLength(2); // text op + nested material op
    const matOp1 = parsed1.find((p) => p.op.kind === 'material');
    expect(matOp1).toBeDefined();
    expect((matOp1!.op as Extract<ToolOp, { kind: 'material' }>).color).toBe('#112233');

    // 2. replace the <id>_color material with color B (via replaceOpInBody)
    const matOpB: ToolOp = {
      kind: 'material',
      id: 'op_text123456_color',
      target: 'plate',
      material: 'matte-plastic',
      color: '#445566',
    };
    const body2 = replaceOpInBody(body1, matOpB);
    const parsed2 = parseOpBlocks(body2);
    const matOp2 = parsed2.find((p) => p.op.kind === 'material');
    expect(matOp2).toBeDefined();
    expect((matOp2!.op as Extract<ToolOp, { kind: 'material' }>).color).toBe('#445566');

    // 3. re-edit the text (e.g. change size, same color A)
    const textOpAEdited: ToolOp = {
      ...textOpA,
      sizeMm: 14,
    };
    const body3 = replaceOpInBody(body2, textOpAEdited);
    const parsed3 = parseOpBlocks(body3);
    const textParsed3 = parsed3.find((p) => p.op.kind === 'text');
    const matParsed3 = parsed3.find((p) => p.op.kind === 'material');

    // assert parseOpBlocks gives the material color B and the new size
    expect((textParsed3!.op as Extract<ToolOp, { kind: 'text' }>).sizeMm).toBe(14);
    expect((matParsed3!.op as Extract<ToolOp, { kind: 'material' }>).color).toBe('#445566');

    // 4. second assertion/test that changing the text Color to C does write C
    const textOpC: ToolOp = {
      ...textOpAEdited,
      color: '#778899',
    };
    const body4 = replaceOpInBody(body3, textOpC);
    const parsed4 = parseOpBlocks(body4);
    const matParsed4 = parsed4.find((p) => p.op.kind === 'material');
    expect((matParsed4!.op as Extract<ToolOp, { kind: 'material' }>).color).toBe('#778899');
  });
});
