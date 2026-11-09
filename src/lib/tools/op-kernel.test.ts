import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runBrep } from '@/lib/engine/brep-runner';
import { withGeneratedPrelude } from '@/lib/brep/prelude';
import { applyOp, type ToolOp, type FacePlane } from './ops';

const py = '/home/claude/work/cadai/.cadai/scratch/venv-dz/bin/python';
const geoReady = existsSync(py) && existsSync('geo/cadai_geo/__main__.py');
const kernel = geoReady ? it : it.skip;

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const BASE_BODY = `base = Box(40, 30, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))
base.label = "base"
lid = Pos(0, 0, 10) * Box(40, 30, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
lid.label = "lid"
_cadai_parts = [base, lid]
result = Compound([base, lid])
`;

const LID_PLANE: FacePlane = {
  origin: [0, 0, 15],
  normal: [0, 0, 1],
  xDir: [1, 0, 0],
};

describe('op-kernel tests', () => {
  function prepareEnv() {
    process.env.CADAI_GEO_PYTHON = py;
    delete process.env.CADAI_GEO_URL;
  }

  async function getBaseLidVolumes(body: string) {
    const res = await runBrep(withGeneratedPrelude(body));
    expect(res.ok, res.error).toBe(true);
    const basePart = res.parts.find((p) => p.label === 'base');
    const lidPart = res.parts.find((p) => p.label === 'lid');
    expect(basePart).toBeDefined();
    expect(lidPart).toBeDefined();
    return { baseVol: basePart!.volume, lidVol: lidPart!.volume, res };
  }

  kernel('blind M5 counterbore hole drops target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_h00001',
      part: 'lid',
      plane: LID_PLANE,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M5',
      diameterMm: 5.5,
      head: 'counterbore',
      depthMm: 3.0,
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeLessThan(initialLidVol);
  }, 120_000);

  kernel('through M3 countersink hole drops target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_h00002',
      part: 'lid',
      plane: LID_PLANE,
      offset: [5, 5],
      rotationDeg: 0,
      kind: 'hole',
      size: 'M3',
      diameterMm: 3.4,
      head: 'countersink',
      depthMm: 'through',
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeLessThan(initialLidVol);
  }, 120_000);

  kernel('cut-rect drops target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_c00001',
      part: 'lid',
      plane: LID_PLANE,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'cut-rect',
      widthMm: 10,
      heightMm: 8,
      cornerRadiusMm: 1.5,
      depthMm: 2.0,
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeLessThan(initialLidVol);
  }, 120_000);

  kernel('engraved text drops target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_t00001',
      part: 'lid',
      plane: LID_PLANE,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'text',
      text: 'CADAI',
      font: 'inter-bold',
      sizeMm: 5,
      mode: 'engrave',
      depthMm: 1.0,
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeLessThan(initialLidVol);
  }, 120_000);

  kernel('embossed text grows target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_t00002',
      part: 'lid',
      plane: LID_PLANE,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'text',
      text: 'CADAI',
      font: 'inter-bold',
      sizeMm: 5,
      mode: 'emboss',
      depthMm: 1.0,
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeGreaterThan(initialLidVol);
  }, 120_000);

  kernel('texture knurl drops target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_x00001',
      part: 'lid',
      plane: LID_PLANE,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'knurl',
      pitchMm: 4.0,
      depthMm: 0.5,
      areaMm: [15, 15],
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeLessThan(initialLidVol);
  }, 120_000);

  kernel('texture hex drops target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_x00002',
      part: 'lid',
      plane: LID_PLANE,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'hex',
      pitchMm: 4.0,
      depthMm: 0.5,
      areaMm: [15, 15],
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeLessThan(initialLidVol);
  }, 120_000);

  kernel('texture ribs drops target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_x00003',
      part: 'lid',
      plane: LID_PLANE,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'ribs',
      pitchMm: 3.0,
      depthMm: 0.5,
      areaMm: [15, 15],
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeLessThan(initialLidVol);
  }, 120_000);

  kernel('texture dimples drops target volume and preserves labels', async () => {
    prepareEnv();
    const { lidVol: initialLidVol } = await getBaseLidVolumes(BASE_BODY);

    const op: ToolOp = {
      id: 'op_x00004',
      part: 'lid',
      plane: LID_PLANE,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'dimples',
      pitchMm: 4.0,
      depthMm: 0.5,
      areaMm: [15, 15],
    };

    const modified = applyOp(BASE_BODY, op);
    const { lidVol: newLidVol, res } = await getBaseLidVolumes(modified);
    expect(res.parts.map((p) => p.label).sort()).toEqual(['base', 'lid']);
    expect(newLidVol).toBeLessThan(initialLidVol);
  }, 120_000);
});
