import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useAppStore } from '@/store/app-store';
import { __resetToolsSliceForTests, replaceOpInBody } from '@/store/tools-slice';
import { ToolSettingsPanel } from './tool-settings-panel';
import {
  TextToolSettings,
  TEXT_EMPTY,
  TEXT_NOT_ALLOWED,
  textApplyBlocker,
} from './text-tool';
import {
  applyOp,
  parseOpBlocks,
  type ToolOp,
  type FacePlane,
} from '@/lib/tools/ops';
import { FONT_IDS } from '@/lib/tools/op-text';
import { checkPythonScript } from '@/lib/brep/body-check';
import { withGeneratedPrelude } from '@/lib/brep/prelude';

const origUseSyncExternalStore = React.useSyncExternalStore;

const SAMPLE_PLANE: FacePlane = {
  origin: [0, 0, 5],
  normal: [0, 0, 1],
  xDir: [1, 0, 0],
};

const SAMPLE_DRAFT: Extract<ToolOp, { kind: 'text' }> = {
  id: 'op_text01',
  kind: 'text',
  part: 'plate',
  plane: SAMPLE_PLANE,
  offset: [0, 0],
  rotationDeg: 0,
  text: 'CADAI',
  font: 'inter-bold',
  sizeMm: 6,
  mode: 'engrave',
  depthMm: 0.8,
  align: 'center',
};

const BASE_PLATE_BODY = `plate = Box(40, 20, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
_cadai_parts = [plate]
result = plate
`;

describe('text tool settings & blocker UI', () => {
  beforeEach(() => {
    React.useSyncExternalStore = (subscribe, getSnapshot) => {
      return origUseSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    };

    __resetToolsSliceForTests();

    useAppStore.setState({
      threads: [
        {
          id: 'th-1',
          title: 'Thread 1',
          createdAt: 1000,
          updatedAt: 1000,
          messages: [],
          code: BASE_PLATE_BODY,
          versions: [
            {
              version: 1,
              parentVersion: null,
              origin: 'designer',
              summary: 'v1',
              flags: [],
              body: BASE_PLATE_BODY,
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
      code: BASE_PLATE_BODY,
      activeToolId: 'text',
      pickedFace: {
        id: 0,
        part: 'plate',
        kind: 'plane',
        area: 800,
        center: [0, 0, 5],
        normal: [0, 0, 1],
      },
      draftOp: { ...SAMPLE_DRAFT },
      editingOpId: null,
      selectedLayerId: null,
      preview: { status: 'idle' },
      applyStatus: 'idle',
      applyError: null,
      toolTopology: null,
      topologyStatus: 'ready',
    });
  });

  afterEach(() => {
    React.useSyncExternalStore = origUseSyncExternalStore;
    __resetToolsSliceForTests();
  });

  it('the text tool shows Text, Font, Size, Mode, Depth, Color, Align and Rotation', () => {
    const html = renderToStaticMarkup(
      <TextToolSettings draft={SAMPLE_DRAFT} onChange={() => {}} />
    );

    const labels = [
      'Text',
      'Font',
      'Size',
      'Mode',
      'Depth',
      'Color',
      'Align',
      'Rotation',
    ];

    let lastIdx = -1;
    for (const label of labels) {
      // Find the label in markup
      const idx = html.indexOf(label, lastIdx + 1);
      expect(
        idx,
        `Expected label "${label}" to appear in order after position ${lastIdx}`
      ).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  const isButtonDisabled = (btnHtml: string) => /\sdisabled(?=[\s=>])/.test(btnHtml);

  it('an empty text disables Apply', () => {
    expect(textApplyBlocker(null)).toBeNull();
    expect(textApplyBlocker({ kind: 'fillet', id: 'f1', target: 'plate', edges: [0], radiusMm: 1 } as unknown as ToolOp)).toBeNull();
    expect(textApplyBlocker({ ...SAMPLE_DRAFT, text: '' })).toBe(TEXT_EMPTY);
    expect(textApplyBlocker({ ...SAMPLE_DRAFT, text: '   ' })).toBe(TEXT_EMPTY);
    expect(textApplyBlocker({ ...SAMPLE_DRAFT, text: 'AB' })).toBeNull();

    // 1. Text is ''
    useAppStore.setState({
      draftOp: { ...SAMPLE_DRAFT, text: '' },
    });
    let html = renderToStaticMarkup(<ToolSettingsPanel />);
    expect(html).toContain(TEXT_EMPTY);
    const applyMatchEmpty = html.match(/<button[^>]*>Applying\.\.\.<\/button>|<button[^>]*>Apply<\/button>/);
    expect(applyMatchEmpty).not.toBeNull();
    expect(isButtonDisabled(applyMatchEmpty![0])).toBe(true);

    // 2. Text is '   '
    useAppStore.setState({
      draftOp: { ...SAMPLE_DRAFT, text: '   ' },
    });
    html = renderToStaticMarkup(<ToolSettingsPanel />);
    expect(html).toContain(TEXT_EMPTY);
    const applyMatchSpaces = html.match(/<button[^>]*>Applying\.\.\.<\/button>|<button[^>]*>Apply<\/button>/);
    expect(applyMatchSpaces).not.toBeNull();
    expect(isButtonDisabled(applyMatchSpaces![0])).toBe(true);

    // 3. Text is 'AB'
    useAppStore.setState({
      draftOp: { ...SAMPLE_DRAFT, text: 'AB' },
    });
    html = renderToStaticMarkup(<ToolSettingsPanel />);
    expect(html).not.toContain(TEXT_EMPTY);
    const applyMatchAB = html.match(/<button[^>]*>Applying\.\.\.<\/button>|<button[^>]*>Apply<\/button>/);
    expect(applyMatchAB).not.toBeNull();
    expect(isButtonDisabled(applyMatchAB![0])).toBe(false);
  });

  it('a text validateToolOp rejects is blocked', () => {
    expect(textApplyBlocker({ ...SAMPLE_DRAFT, text: 'A'.repeat(65) })).toBe(TEXT_NOT_ALLOWED);
    expect(textApplyBlocker({ ...SAMPLE_DRAFT, text: 'A\tB' })).toBe(TEXT_NOT_ALLOWED);
    expect(textApplyBlocker({ ...SAMPLE_DRAFT, text: 'A'.repeat(64) })).toBeNull();
  });

  it('a text the body check rejects disables Apply', () => {
    useAppStore.setState({
      draftOp: { ...SAMPLE_DRAFT, text: 'font' },
    });
    const html = renderToStaticMarkup(<ToolSettingsPanel />);
    expect(html).toContain(TEXT_NOT_ALLOWED);
    const applyMatch = html.match(/<button[^>]*>Applying\.\.\.<\/button>|<button[^>]*>Apply<\/button>/);
    expect(applyMatch).not.toBeNull();
    expect(isButtonDisabled(applyMatch![0])).toBe(true);
  });

  it('the text block uses CADAI_FONTS and passes checkPythonScript for every font and align', () => {
    const aligns: Array<'left' | 'center' | 'right' | undefined> = [
      'left',
      'center',
      'right',
      undefined,
    ];

    for (const font of FONT_IDS) {
      for (const align of aligns) {
        const op: ToolOp = {
          ...SAMPLE_DRAFT,
          id: 'op_text01',
          font,
          align,
        };
        const rendered = applyOp(BASE_PLATE_BODY, op);
        expect(rendered).toContain(`font_path=CADAI_FONTS + "/${font}.ttf"`);
        const script = withGeneratedPrelude(rendered);
        const check = checkPythonScript(script);
        expect(check).toEqual({ ok: true });
      }
    }
  });

  it('a color adds a paired material op nested in the text block', () => {
    // 1. With color: finds text op and material op <id>_color
    const opWithColor: ToolOp = {
      ...SAMPLE_DRAFT,
      id: 'op_text01',
      color: '#ff2200',
    };
    const bodyWithColor = applyOp(BASE_PLATE_BODY, opWithColor);
    const parsedWithColor = parseOpBlocks(bodyWithColor);
    expect(parsedWithColor.length).toBe(2);
    expect(parsedWithColor[0].op.id).toBe('op_text01');
    expect(parsedWithColor[0].op.kind).toBe('text');
    expect(parsedWithColor[1].op.id).toBe('op_text01_color');
    expect(parsedWithColor[1].op.kind).toBe('material');
    if (parsedWithColor[1].op.kind === 'material') {
      expect(parsedWithColor[1].op.target).toBe('plate');
      expect(parsedWithColor[1].op.color).toBe('#ff2200');
    }

    // 2. Without color: only text op
    const opNoColor: ToolOp = {
      ...SAMPLE_DRAFT,
      id: 'op_text01',
      color: undefined,
    };
    const bodyNoColor = applyOp(BASE_PLATE_BODY, opNoColor);
    const parsedNoColor = parseOpBlocks(bodyNoColor);
    expect(parsedNoColor.length).toBe(1);
    expect(parsedNoColor[0].op.id).toBe('op_text01');

    // 3. replaceOpInBody-style re-render leaves exactly one material block
    const updatedOpWithColor: ToolOp = {
      ...opWithColor,
      color: '#00aa33',
      text: 'NEWTEXT',
    };
    const reRendered = replaceOpInBody(bodyWithColor, updatedOpWithColor);
    const parsedReRendered = parseOpBlocks(reRendered);
    expect(parsedReRendered.length).toBe(2);
    expect(parsedReRendered[0].op.id).toBe('op_text01');
    expect((parsedReRendered[0].op as Extract<ToolOp, { kind: 'text' }>).text).toBe('NEWTEXT');
    expect(parsedReRendered[1].op.id).toBe('op_text01_color');
    if (parsedReRendered[1].op.kind === 'material') {
      expect(parsedReRendered[1].op.color).toBe('#00aa33');
    }
  });

  it('align round-trips through parseOpBlocks, and an edited halign line wins', () => {
    const opLeft: ToolOp = {
      ...SAMPLE_DRAFT,
      id: 'op_text01',
      align: 'left',
    };
    const bodyLeft = applyOp(BASE_PLATE_BODY, opLeft);
    const parsedLeft = parseOpBlocks(bodyLeft);
    expect(parsedLeft[0].op.kind).toBe('text');
    expect((parsedLeft[0].op as Extract<ToolOp, { kind: 'text' }>).align).toBe('left');

    // Edit the line in the body: change TextAlign.LEFT to TextAlign.RIGHT
    const editedBody = bodyLeft.replace(
      'op_text01_halign = TextAlign.LEFT',
      'op_text01_halign = TextAlign.RIGHT'
    );
    const parsedEdited = parseOpBlocks(editedBody);
    expect((parsedEdited[0].op as Extract<ToolOp, { kind: 'text' }>).align).toBe('right');
  });

  it('the rendered blocks match the geo fixtures', () => {
    const fixtureDir = resolve(process.cwd(), 'geo/tests/fixtures');
    const engraveFixture = readFileSync(
      resolve(fixtureDir, 'text_op_engrave.py'),
      'utf-8'
    );
    const embossFixture = readFileSync(
      resolve(fixtureDir, 'text_op_emboss.py'),
      'utf-8'
    );

    const engraveOp: ToolOp = {
      kind: 'text',
      id: 'op_text01',
      part: 'plate',
      plane: { origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      text: 'AB',
      font: 'inter-bold',
      sizeMm: 8,
      mode: 'engrave',
      depthMm: 1.0,
    };

    const embossOp: ToolOp = {
      kind: 'text',
      id: 'op_text01',
      part: 'plate',
      plane: { origin: [0, 0, 5], normal: [0, 0, 1], xDir: [1, 0, 0] },
      offset: [0, 0],
      rotationDeg: 0,
      text: 'AB',
      font: 'inter-bold',
      sizeMm: 8,
      mode: 'emboss',
      depthMm: 1.0,
    };

    const renderedEngrave = applyOp(BASE_PLATE_BODY, engraveOp);
    expect(renderedEngrave).toBe(engraveFixture);

    const renderedEmboss = applyOp(BASE_PLATE_BODY, embossOp);
    expect(renderedEmboss).toBe(embossFixture);
  });
});
