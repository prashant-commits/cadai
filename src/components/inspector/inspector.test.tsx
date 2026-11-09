import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '@/store/app-store';
import { parseParams } from '@/lib/design/parse-params';
import type { PartInfo } from '@/lib/contract/run-contract';
import type { ServerThreadVersion } from '@/lib/client/server-thread';
import type { ChatMessage, ScadParam } from '@/types';
import { Inspector } from './inspector';
import { LayersSection, layerRows, NO_LAYERS } from './layers-section';
import { PropertiesSection, NO_PARAMS } from './properties-section';
import {
  VersionsSection,
  selectVersionRow,
  relativeTime,
  USER_EDIT_LABEL,
  DESIGNER_LABEL,
  FAILED_CHECKS_LABEL,
  NO_VERSIONS,
} from './versions-section';
import { ModelInfo, NO_MODEL_INFO } from './model-info';
import { ParamControl } from '@/components/design/param-control';

const origUseSyncExternalStore = React.useSyncExternalStore;
const origSelectVersion = useAppStore.getState().selectVersion;

describe('inspector (Layers, Properties, Versions, Model info)', () => {
  beforeEach(() => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    useAppStore.setState({
      threads: [],
      activeThreadId: '',
      messages: [],
      code: '',
      params: [],
      parts: [],
      selectedLayerId: null,
      highlightedVersion: null,
      codeDrawerOpen: false,
      geometry: null,
      stlContent: null,
      modelInfo: null,
      viewingVersion: null,
      activeDraft: null,
      selectVersion: origSelectVersion,
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    vi.unstubAllGlobals();
  });

  it('layers list the model\'s part labels', () => {
    const parts: PartInfo[] = [
      { label: 'base', valid: true, volume: 100, min: [0, 0, 0], max: [10, 10, 10] },
      { label: 'arm', valid: true, volume: 50, min: [0, 0, 10], max: [5, 5, 20] },
      { label: 'pin', valid: true, volume: 20, min: [2, 2, 20], max: [3, 3, 25] },
    ];
    useAppStore.setState({ parts });

    const html = renderToStaticMarkup(<LayersSection />);
    expect(html).toContain('base');
    expect(html).toContain('arm');
    expect(html).toContain('pin');
    expect(html).toContain('data-layer-id="base"');
    expect(html).toContain('data-layer-id="arm"');
    expect(html).toContain('data-layer-id="pin"');

    const sampleVersion: ServerThreadVersion = {
      version: 1,
      parentVersion: null,
      origin: 'designer',
      summary: 'v1',
      flags: [],
      body: 'lid = Box(10, 10, 2)',
      preludeVersion: 'v1',
      stl: null,
      step: null,
      createdAt: 1000,
      partLabels: ['lid'],
    };

    expect(layerRows([], sampleVersion)).toEqual([
      { id: 'lid', label: 'lid', box: null },
    ]);
    expect(layerRows([], undefined)).toEqual([]);

    useAppStore.setState({ parts: [] });
    const emptyHtml = renderToStaticMarkup(<LayersSection />);
    expect(emptyHtml).toContain(NO_LAYERS);
  });

  it('selecting a part layer keeps Properties showing all parameters', () => {
    const code = 'width = 40\ndepth = 30\nheight = 12\nbox = Box(width, depth, height)';
    const parts: PartInfo[] = [
      { label: 'arm', valid: true, volume: 50, min: [0, 0, 0], max: [40, 30, 12] },
    ];

    useAppStore.setState({
      code,
      params: parseParams(code),
      parts,
      selectedLayerId: 'arm',
    });

    const propHtml = renderToStaticMarkup(<PropertiesSection />);
    expect(propHtml).toContain('width');
    expect(propHtml).toContain('depth');
    expect(propHtml).toContain('height');

    const inspectorHtml = renderToStaticMarkup(<Inspector />);
    expect(inspectorHtml).toContain('width');
    expect(inspectorHtml).toContain('depth');
    expect(inspectorHtml).toContain('height');
    expect(inspectorHtml).toMatch(/data-layer-id="arm"[^>]*aria-pressed="true"/);

    useAppStore.setState({ params: [] });
    const emptyPropHtml = renderToStaticMarkup(<PropertiesSection />);
    expect(emptyPropHtml).toContain(NO_PARAMS);
  });

  it('the pin indicator is visible without hover', () => {
    const unpinnedParam: ScadParam = {
      name: 'width',
      value: 40,
      authoredValue: 40,
      kind: 'range',
      min: 10,
      max: 100,
      step: 1,
      line: 1,
      group: 'General',
    };

    const unpinnedHtml = renderToStaticMarkup(
      <ParamControl
        param={unpinnedParam}
        pinned={false}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onChange={vi.fn()}
      />
    );
    expect(unpinnedHtml).toContain('data-pinned="false"');
    expect(unpinnedHtml).toMatch(/aria-label="[^"]*pin[^"]*"/i);
    expect(unpinnedHtml).not.toContain('opacity-0');
    expect(unpinnedHtml).not.toContain('group-hover:');

    const pinnedParam: ScadParam = {
      ...unpinnedParam,
      value: 50,
    };

    const pinnedHtml = renderToStaticMarkup(
      <ParamControl
        param={pinnedParam}
        pinned={true}
        onPin={vi.fn()}
        onUnpin={vi.fn()}
        onChange={vi.fn()}
      />
    );
    expect(pinnedHtml).toContain('data-pinned="true"');
    expect(pinnedHtml).toMatch(/aria-label="[^"]*pin[^"]*"/i);
    expect(pinnedHtml).not.toContain('opacity-0');
    expect(pinnedHtml).not.toContain('group-hover:');
    expect(pinnedHtml).toMatch(/<button[^>]*aria-label="[^"]*reset[^"]*"[^>]*>/i);
  });

  it('selecting a version highlights the message that made it', () => {
    const threadId = 't-ver-1';
    const v1Msg: ChatMessage = {
      id: 'm-v1',
      role: 'assistant',
      content: 'Initial model',
      timestamp: 1000,
      designVersion: 1,
    };
    const v2Msg: ChatMessage = {
      id: 'm-v2',
      role: 'user',
      content: 'Changed width',
      timestamp: 2000,
      designVersion: 2,
    };
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'Initial design',
        flags: [],
        body: 'width = 10',
        preludeVersion: 'v1',
        stl: null,
        step: null,
        createdAt: 1000,
      },
      {
        version: 2,
        parentVersion: 1,
        origin: 'user_edit',
        summary: 'User edit',
        flags: [],
        body: 'width = 20',
        preludeVersion: 'v1',
        stl: null,
        step: null,
        createdAt: 2000,
      },
    ];

    useAppStore.setState({
      activeThreadId: threadId,
      threads: [
        {
          id: threadId,
          title: 'Test Thread',
          createdAt: 1000,
          updatedAt: 2000,
          code: 'width = 20',
          messages: [v1Msg, v2Msg],
          versions,
          viewingVersion: 2,
        },
      ],
      messages: [v1Msg, v2Msg],
    });

    const vHtml = renderToStaticMarkup(<VersionsSection />);
    expect(vHtml.indexOf('v2')).toBeLessThan(vHtml.indexOf('v1'));
    expect(vHtml).toContain(USER_EDIT_LABEL);
    expect(vHtml).toContain(DESIGNER_LABEL);

    const selectVersionSpy = vi.fn(async () => {});
    useAppStore.setState({ selectVersion: selectVersionSpy });

    selectVersionRow(1);
    expect(useAppStore.getState().highlightedVersion).toBe(1);
    expect(selectVersionSpy).toHaveBeenCalledWith(1);

    const activeThread = useAppStore.getState().threads.find((t) => t.id === threadId);
    const matchedMessage = activeThread?.messages.find(
      (m) => m.designVersion === useAppStore.getState().highlightedVersion
    );
    expect(matchedMessage?.id).toBe(v1Msg.id);

    expect(relativeTime(1000, 1000)).toBe('now');
    expect(relativeTime(1000, 70_000)).toBe('1 min');
    expect(relativeTime(1000, 3_700_000)).toBe('1 h');
    expect(relativeTime(1000, 86_500_000)).toBe('1 d');

    const failedVer: ServerThreadVersion = {
      ...versions[0],
      flags: ['failed_checks'],
    };
    useAppStore.setState({
      threads: [
        {
          id: threadId,
          title: 'Test Thread',
          createdAt: 1000,
          updatedAt: 2000,
          code: 'width = 20',
          messages: [v1Msg, v2Msg],
          versions: [failedVer],
          viewingVersion: 1,
        },
      ],
    });
    const failedHtml = renderToStaticMarkup(<VersionsSection />);
    expect(failedHtml).toContain(FAILED_CHECKS_LABEL);

    useAppStore.setState({ threads: [] });
    const emptyVHtml = renderToStaticMarkup(<VersionsSection />);
    expect(emptyVHtml).toContain(NO_VERSIONS);
  });

  it('model info is collapsed by default', () => {
    expect(NO_MODEL_INFO).toBe('No model yet.');
    useAppStore.setState({
      modelInfo: {
        boundingBox: {
          min: [0, 0, 0],
          max: [100, 50, 25],
        },
        volumeMm3: 125000,
        triangleCount: 500,
        vertexCount: 1500,
        isWatertight: true,
        isFlatPackable: false,
        dimensions: { x: 100, y: 50, z: 25 },
      },
    });

    const html = renderToStaticMarkup(<ModelInfo />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('125.0');
    expect(html).not.toContain('100.0');
  });

  it('switching threads clears the selected layer and the highlighted version', () => {
    useAppStore.setState({
      selectedLayerId: 'arm',
      highlightedVersion: 2,
      parts: [{ label: 'arm', valid: true, volume: 50, min: [0, 0, 0], max: [10, 10, 10] }],
      threads: [
        { id: 't1', title: 'T1', createdAt: 1, updatedAt: 1, code: '', messages: [] },
        { id: 't2', title: 'T2', createdAt: 2, updatedAt: 2, code: '', messages: [] },
      ],
      activeThreadId: 't1',
    });

    useAppStore.getState().switchThread('t2');
    expect(useAppStore.getState().selectedLayerId).toBeNull();
    expect(useAppStore.getState().highlightedVersion).toBeNull();
    expect(useAppStore.getState().parts).toEqual([]);
  });

  it('selecting a version replaces the parts of the previous version', async () => {
    const VALID_ASCII_STL = `solid box
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 40 0 0
      vertex 40 60 0
    endloop
  endfacet
endsolid box`;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/artifacts/')) {
        return new Response(VALID_ASCII_STL, { status: 200 });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    const threadId = 't-replace-parts';
    const v1: ServerThreadVersion = {
      version: 1,
      parentVersion: null,
      origin: 'designer',
      summary: 'v1 with lid',
      flags: [],
      body: 'lid = Box(10, 10, 2)',
      preludeVersion: 'v1',
      stl: 'art-stl-1',
      step: null,
      createdAt: 1000,
      partLabels: ['lid'],
    };

    useAppStore.setState({
      activeThreadId: threadId,
      parts: [
        { label: 'base', valid: true, volume: 100, min: [0, 0, 0], max: [10, 10, 10] },
      ],
      threads: [
        {
          id: threadId,
          title: 'Test Thread',
          createdAt: 1000,
          updatedAt: 1000,
          code: 'base = Box(10, 10, 10)',
          messages: [],
          versions: [v1],
          viewingVersion: null,
        },
      ],
    });

    await useAppStore.getState().selectVersion(1);

    expect(useAppStore.getState().parts).toEqual([]);
    const rows = layerRows(
      useAppStore.getState().parts,
      useAppStore.getState().threads.find((t) => t.id === threadId)?.versions?.find((v) => v.version === 1)
    );
    expect(rows).toEqual([{ id: 'lid', label: 'lid', box: null }]);
  });

  it('a failed_checks version is labeled', () => {
    const threadId = 't-failed-checks';
    const versions: ServerThreadVersion[] = [
      {
        version: 1,
        parentVersion: null,
        origin: 'designer',
        summary: 'First clean version',
        flags: [],
        body: 'box = Box(10, 10, 10)',
        preludeVersion: '1',
        stl: 'stl-1',
        step: 'step-1',
        createdAt: 1000,
      },
      {
        version: 2,
        parentVersion: 1,
        origin: 'designer',
        summary: 'Second broken version',
        flags: ['failed_checks'],
        body: 'box = Box(20, 20, 20)',
        preludeVersion: '1',
        stl: 'stl-2',
        step: 'step-2',
        createdAt: 2000,
      },
    ];
    const thread = (vs: ServerThreadVersion[]) => ({
      id: threadId,
      title: 'Check Thread',
      createdAt: 1000,
      updatedAt: 2000,
      code: vs[vs.length - 1].body,
      messages: [],
      versions: vs,
    });

    useAppStore.setState({ activeThreadId: threadId, threads: [thread(versions)], viewingVersion: 2 });
    const markup = renderToStaticMarkup(<VersionsSection />);
    expect(markup).toContain(FAILED_CHECKS_LABEL);
    expect(markup).toContain(DESIGNER_LABEL);
    // Summary is dropped from the row
    expect(markup).not.toContain('First clean version');
    expect(markup).not.toContain('Second broken version');
    // The label sits in v2's row, not v1's
    const rows = markup.split('<button').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('>v2<');
    expect(rows[0]).toContain(FAILED_CHECKS_LABEL);
    expect(rows[1]).toContain('>v1<');
    expect(rows[1]).not.toContain(FAILED_CHECKS_LABEL);

    // Only v2 has the label, not v1
    useAppStore.setState({ threads: [thread([versions[0]])], viewingVersion: 1 });
    const v1OnlyMarkup = renderToStaticMarkup(<VersionsSection />);
    expect(v1OnlyMarkup).not.toContain(FAILED_CHECKS_LABEL);
    expect(v1OnlyMarkup).toContain(DESIGNER_LABEL);
    expect(v1OnlyMarkup).not.toContain('First clean version');
  });
});
