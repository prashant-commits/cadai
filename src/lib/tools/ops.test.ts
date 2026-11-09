import { describe, it, expect } from 'vitest';
import { checkPythonScript } from '@/lib/brep/body-check';
import { withGeneratedPrelude } from '@/lib/brep/prelude';
import {
  renderOpBlock,
  applyOp,
  parseOpBlocks,
  OpTargetError,
  type ToolOp,
  type FacePlane,
} from './ops';
import { toolEditPhrase } from './phrases';
import { listLayers } from './layers';

const defaultPlane: FacePlane = {
  origin: [0, 0, 10],
  normal: [0, 0, 1],
  xDir: [1, 0, 0],
};

describe('ops core', () => {
  it('renderOpBlock output passes checkPythonScript for every op kind', () => {
    const ops: ToolOp[] = [
      // hole: blind none
      {
        id: 'op_h00001',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 0,
        kind: 'hole',
        size: 'M5',
        diameterMm: 5.5,
        head: 'none',
        depthMm: 5.0,
      },
      // hole: through counterbore
      {
        id: 'op_h00002',
        part: 'lid',
        plane: defaultPlane,
        offset: [5, 5],
        rotationDeg: 0,
        kind: 'hole',
        size: 'M5',
        diameterMm: 5.5,
        head: 'counterbore',
        depthMm: 'through',
      },
      // hole: through countersink
      {
        id: 'op_h00003',
        part: 'lid',
        plane: defaultPlane,
        offset: [-5, -5],
        rotationDeg: 0,
        kind: 'hole',
        size: 'M4',
        diameterMm: 4.5,
        head: 'countersink',
        depthMm: 'through',
      },
      // cut-rect: blind
      {
        id: 'op_c00001',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 45,
        kind: 'cut-rect',
        widthMm: 20,
        heightMm: 10,
        cornerRadiusMm: 2,
        depthMm: 3.0,
      },
      // cut-rect: through
      {
        id: 'op_c00002',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 0,
        kind: 'cut-rect',
        widthMm: 15,
        heightMm: 8,
        cornerRadiusMm: 0,
        depthMm: 'through',
      },
      // text: engrave
      {
        id: 'op_t00001',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 0,
        kind: 'text',
        text: 'CADAI',
        font: 'inter-bold',
        sizeMm: 5,
        mode: 'engrave',
        depthMm: 1.0,
      },
      // text: emboss
      {
        id: 'op_t00002',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 0,
        kind: 'text',
        text: 'LOGO',
        font: 'oswald-semibold',
        sizeMm: 6,
        mode: 'emboss',
        depthMm: 1.5,
      },
      // texture: knurl
      {
        id: 'op_x00001',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 0,
        kind: 'texture',
        pattern: 'knurl',
        pitchMm: 2.0,
        depthMm: 0.5,
        areaMm: [20, 20],
      },
      // texture: hex
      {
        id: 'op_x00002',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 0,
        kind: 'texture',
        pattern: 'hex',
        pitchMm: 3.0,
        depthMm: 0.5,
        areaMm: [20, 20],
      },
      // texture: ribs
      {
        id: 'op_x00003',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 0,
        kind: 'texture',
        pattern: 'ribs',
        pitchMm: 2.5,
        depthMm: 0.8,
        areaMm: [20, 20],
      },
      // texture: dimples
      {
        id: 'op_x00004',
        part: 'lid',
        plane: defaultPlane,
        offset: [0, 0],
        rotationDeg: 0,
        kind: 'texture',
        pattern: 'dimples',
        pitchMm: 3.0,
        depthMm: 0.5,
        areaMm: [20, 20],
      },
      // material on part
      {
        id: 'op_m00001',
        kind: 'material',
        target: 'lid',
        material: 'brushed-metal',
        color: '#aaaaaa',
      },
      // material on model
      {
        id: 'op_m00002',
        kind: 'material',
        target: 'model',
        material: 'wood',
        color: '#8b5a2b',
      },
    ];

    for (const op of ops) {
      const block = renderOpBlock(op);
      const script = withGeneratedPrelude(`
lid = Box(40, 30, 10)
${block}
_cadai_parts = [lid]
result = lid
`);
      const check = checkPythonScript(script);
      expect(check.ok, `Op ${op.id} (${op.kind}) failed check: ${check.ok ? '' : check.reason}`).toBe(true);
    }
  });

  it('applyOp rebinds the target part before _cadai_parts', () => {
    const body = `base = Box(20, 20, 10)
lid = Box(20, 20, 5)
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;
    const op: ToolOp = {
      id: 'op_h00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 3.0,
    };
    const modified = applyOp(body, op);
    expect(modified).toContain('# cadai:op hole id=op_h00001');
    expect(modified).toContain('lid = lid - op_h00001_cutter');
    const opIndex = modified.indexOf('# cadai:op hole id=op_h00001');
    const partsIndex = modified.indexOf('_cadai_parts = [base, lid]');
    expect(opIndex).toBeGreaterThan(-1);
    expect(partsIndex).toBeGreaterThan(opIndex);
  });

  it('applyOp throws OpTargetError for an unknown part', () => {
    const body = `base = Box(20, 20, 10)
_cadai_parts = [base]
result = base
`;
    const op: ToolOp = {
      id: 'op_h00001',
      part: 'nonexistent',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 3.0,
    };
    expect(() => applyOp(body, op)).toThrow(OpTargetError);
  });

  it('applyOp inserts after a multi-line assignment of the target part', () => {
    const body = `base = Box(20, 20, 10)
lid = (
    Box(20, 20, 5)
    - Pos(0, 0, 1) * Cylinder(radius=2, height=4)
)
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;
    const op: ToolOp = {
      id: 'op_h00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 3.0,
    };
    const modified = applyOp(body, op);
    const check = checkPythonScript(withGeneratedPrelude(modified));
    expect(check.ok).toBe(true);

    const closingParenLineIdx = modified.indexOf(')\n# cadai:op hole id=op_h00001');
    expect(closingParenLineIdx).toBeGreaterThan(-1);
    const partsIndex = modified.indexOf('_cadai_parts = [base, lid]');
    expect(partsIndex).toBeGreaterThan(closingParenLineIdx);
  });

  it("two parts, an existing block on base after lid's last assignment; a new op on lid goes right after lid's assignment, before the base block", () => {
    const body = `lid = Box(20, 20, 5)
base = Box(20, 20, 10)
# cadai:op hole id=op_h00001 {"id":"op_h00001","part":"base","kind":"hole","size":"M5","diameterMm":5.5,"head":"none","depthMm":3,"offset":[0,0],"rotationDeg":0,"plane":{"origin":[0,0,10],"normal":[0,0,1],"xDir":[1,0,0]}}
op_h00001_diameter = 5.5
base = base - op_h00001_cutter
# cadai:end op_h00001
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;
    const newLidOp: ToolOp = {
      id: 'op_h00002',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 2.0,
    };
    const modified = applyOp(body, newLidOp);
    const check = checkPythonScript(withGeneratedPrelude(modified));
    expect(check.ok).toBe(true);

    const lidAssignIdx = modified.indexOf('lid = Box(20, 20, 5)');
    const opLidIdx = modified.indexOf('# cadai:op hole id=op_h00002');
    const baseAssignIdx = modified.indexOf('base = Box(20, 20, 10)');
    const baseOpIdx = modified.indexOf('# cadai:op hole id=op_h00001');

    expect(opLidIdx).toBeGreaterThan(lidAssignIdx);
    expect(opLidIdx).toBeLessThan(baseAssignIdx);
    expect(baseAssignIdx).toBeLessThan(baseOpIdx);
  });

  it('parseOpBlocks round-trips renderOpBlock', () => {
    const op: ToolOp = {
      id: 'op_h00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [2, 3],
      rotationDeg: 15,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'counterbore',
      depthMm: 10,
    };
    const rendered = renderOpBlock(op);
    const parsed = parseOpBlocks(rendered);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].op).toEqual(op);
  });

  it('a parameter line edited after rendering wins over the marker json', () => {
    const op: ToolOp = {
      id: 'op_h00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 10,
    };
    let rendered = renderOpBlock(op);
    // User edits diameter parameter line to 6.2
    rendered = rendered.replace('op_h00001_diameter = 5.5', 'op_h00001_diameter = 6.2');
    const parsed = parseOpBlocks(rendered);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].op.kind).toBe('hole');
    if (parsed[0].op.kind === 'hole') {
      expect(parsed[0].op.diameterMm).toBe(6.2);
    }
  });

  it('a body rewritten around an intact block still parses the op', () => {
    const op: ToolOp = {
      id: 'op_h00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 10,
    };
    const block = renderOpBlock(op);
    const body = `# Completely new header
x = 100
lid = Box(x, x, 20)
${block}
# Something after
_cadai_parts = [lid]
result = lid
`;
    const parsed = parseOpBlocks(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].op.id).toBe('op_h00001');
    expect(parsed[0].op).toEqual(op);
  });

  it('toolEditPhrase("hole M5", 4) is "You added Hole M5 · v4"', () => {
    expect(toolEditPhrase('hole M5', 4)).toBe('You added Hole M5 · v4');
  });

  it('listLayers returns part layers followed by op layers with fixed phrases', () => {
    const holeOp: ToolOp = {
      id: 'op_h00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'none',
      depthMm: 5,
    };
    const textOp: ToolOp = {
      id: 'op_t00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'text',
      text: 'CADAI',
      font: 'inter-bold',
      sizeMm: 5,
      mode: 'engrave',
      depthMm: 1,
    };
    const textureOp: ToolOp = {
      id: 'op_x00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'knurl',
      pitchMm: 2,
      depthMm: 0.5,
      areaMm: [20, 20],
    };
    const cutRectOp: ToolOp = {
      id: 'op_c00001',
      part: 'lid',
      plane: defaultPlane,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'cut-rect',
      widthMm: 20,
      heightMm: 10,
      cornerRadiusMm: 1,
      depthMm: 2,
    };
    const matOp: ToolOp = {
      id: 'op_m00001',
      kind: 'material',
      target: 'lid',
      material: 'brushed-metal',
      color: '#ffffff',
    };

    const body = `base = Box(10, 10, 10)
lid = Box(10, 10, 10)
${renderOpBlock(holeOp)}
${renderOpBlock(textOp)}
${renderOpBlock(textureOp)}
${renderOpBlock(cutRectOp)}
${renderOpBlock(matOp)}
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;
    const layers = listLayers(body, ['base', 'lid']);
    expect(layers).toEqual([
      { id: 'base', name: 'base', kind: 'part' },
      { id: 'lid', name: 'lid', kind: 'part' },
      { id: 'op_h00001', name: 'Hole M5', kind: 'hole' },
      { id: 'op_t00001', name: 'Text "CADAI"', kind: 'text' },
      { id: 'op_x00001', name: 'Knurl texture', kind: 'texture' },
      { id: 'op_c00001', name: 'Cut-out 20 × 10', kind: 'cut-rect' },
      { id: 'op_m00001', name: 'Brushed metal', kind: 'material' },
    ]);
  });
});
