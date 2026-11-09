import { describe, it, expect } from 'vitest';
import {
  TOO_DENSE,
  textureFeatureCount,
  textureDensityError,
  faceExtentMm,
  clampAreaToFace,
} from './op-texture';
import {
  validateToolOp,
  renderOpBlock,
  applyOp,
  type ToolOp,
  type FacePlane,
} from './ops';
import { checkPythonScript } from '@/lib/brep/body-check';
import { viewerMaterial, MATERIAL_PRESETS } from '@/components/viewport/material-presets';
import { toolDef } from '@/components/tools/defs/texture';
import type { Topology } from '@/lib/geometry/topology';

const PLANE_Z5: FacePlane = {
  origin: [0, 0, 5],
  normal: [0, 0, 1],
  xDir: [1, 0, 0],
};

const BASE_BODY = `plate = Box(40, 20, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate.label = "plate"
_cadai_parts = [plate]
result = Compound([plate])
`;

describe('op-texture and materials', () => {
  it('a knurl op over 400 features is rejected with the density phrase', () => {
    // pitch 0.5 over 80 x 80 area:
    // hypot(80, 80) = 113.137...
    // n = floor(113.137 / 0.5) = 226
    // count = 2 * 226 = 452 > 400
    const overDenseOp: ToolOp = {
      id: 'op_knrl_over',
      part: 'plate',
      plane: PLANE_Z5,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'knurl',
      pitchMm: 0.5,
      depthMm: 0.4,
      areaMm: [80, 80],
    };

    const count = textureFeatureCount(overDenseOp);
    expect(count).toBeGreaterThan(400);

    const err = textureDensityError(overDenseOp);
    expect(err).toBe(TOO_DENSE);
    expect(err).toBe('Too dense: raise the pitch or shrink the area.');

    expect(validateToolOp(overDenseOp)).toBe(false);
    expect(() => renderOpBlock(overDenseOp)).toThrow();

    // Exactly 400 features:
    // area: [40, 40], hypot = 56.5685..., pitch = 2.8284 -> n = 20 -> n * n = 400
    const exact400Op: ToolOp = {
      id: 'op_knrl000400',
      part: 'plate',
      plane: PLANE_Z5,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'knurl',
      pitchMm: 2.8284,
      depthMm: 0.4,
      areaMm: [40, 40],
    };
    expect(textureFeatureCount(exact400Op)).toBe(400);
    expect(textureDensityError(exact400Op)).toBeNull();
    expect(validateToolOp(exact400Op)).toBe(true);

    // One step over the cap: n = 21 -> 441 features is rejected.
    const over441Op: ToolOp = { ...exact400Op, pitchMm: 2.69 };
    expect(textureFeatureCount(over441Op)).toBe(441);
    expect(textureDensityError(over441Op)).toBe(TOO_DENSE);
    expect(validateToolOp(over441Op)).toBe(false);
  });

  it('matches the fixture file for rendered texture ops so TS and python runner cannot drift', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const ribOp: ToolOp = {
      id: 'op_rib0001',
      part: 'plate',
      plane: PLANE_Z5,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'ribs',
      pitchMm: 2.0,
      depthMm: 0.4,
      areaMm: [30, 15],
    };

    const knurlOp400: ToolOp = {
      id: 'op_knrl000400',
      part: 'plate',
      plane: PLANE_Z5,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'knurl',
      pitchMm: 2.8284,
      depthMm: 0.4,
      areaMm: [40, 40],
    };
    expect(textureFeatureCount(knurlOp400)).toBe(400);

    const hexOp400: ToolOp = {
      id: 'op_hex0000400',
      part: 'plate',
      plane: PLANE_Z5,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'hex',
      pitchMm: 2.0,
      depthMm: 0.4,
      areaMm: [40, 40],
    };
    expect(textureFeatureCount(hexOp400)).toBe(400);

    const fixturePath = path.resolve('geo/tests/fixtures/texture_blocks.json');
    const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    expect(fixtureData.op_rib0001).toBe(renderOpBlock(ribOp));
    expect(fixtureData.op_knrl000400).toBe(renderOpBlock(knurlOp400));
    expect(fixtureData.op_hex0000400).toBe(renderOpBlock(hexOp400));
  });

  it('clampAreaToFace clamps the default area to a thin face', () => {
    // A thin face of 5 x 100 has area 500
    // initialDraft side = round(min(20, 0.8 * sqrt(500)) * 10) / 10 = 17.9 mm
    const defaultArea: [number, number] = [17.9, 17.9];
    const thinExtent: [number, number] = [5.0, 100.0];

    const clamped = clampAreaToFace(defaultArea, thinExtent);
    expect(clamped).toEqual([5.0, 17.9]);
  });

  it('a hex op renders a block that passes checkPythonScript', () => {
    const op: ToolOp = {
      id: 'op_hex0001',
      part: 'plate',
      plane: PLANE_Z5,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'hex',
      pitchMm: 4.0,
      depthMm: 0.4,
      areaMm: [20, 10],
    };

    expect(validateToolOp(op)).toBe(true);
    const bodyWithOp = applyOp(BASE_BODY, op);
    const check = checkPythonScript(bodyWithOp);
    expect(check.ok).toBe(true);
  });

  it('the material op adds no geometry', () => {
    // Include stale framework keys to assert they are not leaked
    const staleOp = {
      kind: 'material' as const,
      id: 'op_mat0001',
      target: 'plate',
      material: 'brushed-metal' as const,
      color: '#a0a4ab',
      part: 'stale_part',
      plane: PLANE_Z5,
      offset: [5, 5],
    };

    const rendered = renderOpBlock(staleOp as unknown as ToolOp);
    const lines = rendered.trim().split('\n');

    // Every line of the rendered material block starts with #
    for (const line of lines) {
      expect(line.trim().startsWith('#')).toBe(true);
    }

    // applyOp changes only comment lines
    const modified = applyOp(BASE_BODY, staleOp as unknown as ToolOp);
    const originalNonComments = BASE_BODY.split('\n').filter((l) => !l.trim().startsWith('#') && l.trim() !== '');
    const modifiedNonComments = modified.split('\n').filter((l) => !l.trim().startsWith('#') && l.trim() !== '');
    expect(modifiedNonComments).toEqual(originalNonComments);

    // Marker JSON has only kind, id, target, material, color
    const markerLine = lines.find((l) => l.startsWith('# cadai:op material'));
    expect(markerLine).toBeDefined();
    const jsonStr = markerLine!.replace(/^# cadai:op material id=\S+\s+/, '');
    const parsed = JSON.parse(jsonStr);
    expect(Object.keys(parsed).sort()).toEqual(['color', 'id', 'kind', 'material', 'target'].sort());
    expect(parsed).toEqual({
      kind: 'material',
      id: 'op_mat0001',
      target: 'plate',
      material: 'brushed-metal',
      color: '#a0a4ab',
    });
  });

  it('textureFeatureCount matches the rendered Python grid for each pattern', () => {
    // dimples: nx * ny
    const dimplesOp = {
      pattern: 'dimples' as const,
      pitchMm: 3.0,
      areaMm: [10, 8] as [number, number],
    };
    // nx = floor(10 / 3) = 3, ny = floor(8 / 3) = 2 -> 6
    expect(textureFeatureCount(dimplesOp)).toBe(6);

    // hex: nx * ny
    const hexOp = {
      pattern: 'hex' as const,
      pitchMm: 4.0,
      areaMm: [12, 10] as [number, number],
    };
    // nx = floor(12 / 4) = 3, ny = floor(10 / 4) = 2 -> 6
    expect(textureFeatureCount(hexOp)).toBe(6);

    // ribs: ny
    const ribsOp = {
      pattern: 'ribs' as const,
      pitchMm: 2.0,
      areaMm: [20, 15] as [number, number],
    };
    // ny = floor(15 / 2) = 7
    expect(textureFeatureCount(ribsOp)).toBe(7);

    // knurl: n * n, where n = max(1, floor(hypot(w, h) / pitch))
    const knurlOp = {
      pattern: 'knurl' as const,
      pitchMm: 5.0,
      areaMm: [12, 9] as [number, number],
    };
    // hypot(12, 9) = 15. n = floor(15 / 5) = 3 -> 3 * 3 = 9
    expect(textureFeatureCount(knurlOp)).toBe(9);
  });

  it('faceExtentMm measures a 40 x 20 face', () => {
    // A 40 x 20 face on z=5 plane:
    // x in [-20, 20], y in [-10, 10]
    // 2 triangles:
    // tri 0: (-20, -10, 5), (20, -10, 5), (20, 10, 5)
    // tri 1: (-20, -10, 5), (20, 10, 5), (-20, 10, 5)
    const positions = new Float32Array([
      -20, -10, 5,
      20, -10, 5,
      20, 10, 5,
      -20, 10, 5,
      // Another face vertices
      0, 0, 0,
      10, 0, 0,
      0, 10, 0,
    ]);
    const indices = new Uint32Array([
      0, 1, 2,
      0, 2, 3,
      4, 5, 6,
    ]);
    const faceIds = new Uint32Array([
      101, // tri 0 -> face 101
      101, // tri 1 -> face 101
      102, // tri 2 -> face 102
    ]);

    const topo: Topology = {
      mesh: { positions, indices, faceIds },
      faces: [
        { id: 101, part: 'plate', kind: 'plane', area: 800, center: [0, 0, 5], normal: [0, 0, 1] },
        { id: 102, part: 'plate', kind: 'plane', area: 50, center: [3.33, 3.33, 0], normal: [0, 0, -1] },
      ],
      edges: [],
      parts: [{ label: 'plate', min: [-20, -10, 0], max: [20, 10, 5] }],
    };

    const extent = faceExtentMm(topo, 101, PLANE_Z5);
    expect(extent[0]).toBeCloseTo(40, 3);
    expect(extent[1]).toBeCloseTo(20, 3);
  });

  it('viewerMaterial uses the model material, then a single part\'s material, else the default', () => {
    const matModel: ToolOp = {
      kind: 'material',
      id: 'm1',
      target: 'model',
      material: 'brushed-metal',
      color: '#112233',
    };
    const matPartLid: ToolOp = {
      kind: 'material',
      id: 'm2',
      target: 'lid',
      material: 'wood',
      color: '#445566',
    };
    const matPartBase: ToolOp = {
      kind: 'material',
      id: 'm3',
      target: 'base',
      material: 'matte-plastic',
      color: '#778899',
    };

    // 1. Model material wins
    const vm1 = viewerMaterial([matPartLid, matModel], ['lid', 'base']);
    expect(vm1.color).toBe('#112233');
    expect(vm1.metalness).toBe(MATERIAL_PRESETS['brushed-metal'].metalness);
    expect(vm1.roughness).toBe(MATERIAL_PRESETS['brushed-metal'].roughness);

    // 2. Single part model uses that part's material
    const vm2 = viewerMaterial([matPartLid], ['lid']);
    expect(vm2.color).toBe('#445566');
    expect(vm2.metalness).toBe(MATERIAL_PRESETS['wood'].metalness);
    expect(vm2.roughness).toBe(MATERIAL_PRESETS['wood'].roughness);

    // 3. Multi-part model with only per-part materials falls back to default
    const vm3 = viewerMaterial([matPartLid, matPartBase], ['lid', 'base']);
    expect(vm3.color).toBe('#94a3b8');
    expect(vm3.metalness).toBe(0.08);
    expect(vm3.roughness).toBe(0.3);

    // 4. No materials -> default
    const vm4 = viewerMaterial([], ['lid']);
    expect(vm4.color).toBe('#94a3b8');
    expect(vm4.metalness).toBe(0.08);
    expect(vm4.roughness).toBe(0.3);
  });

  it("the texture tool's applyBlocker returns the density phrase over 400 features and null otherwise", () => {
    expect(toolDef.applyBlocker).toBeDefined();

    // null draft -> null
    expect(toolDef.applyBlocker!(null)).toBeNull();

    // Material op -> null
    const matOp: ToolOp = {
      kind: 'material',
      id: 'op_mat0001',
      target: 'model',
      material: 'matte-plastic',
      color: '#94a3b8',
    };
    expect(toolDef.applyBlocker!(matOp)).toBeNull();

    // Texture op under 400 features -> null
    const validTextureOp: ToolOp = {
      id: 'op_knrl000400',
      part: 'plate',
      plane: PLANE_Z5,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'knurl',
      pitchMm: 2.8284,
      depthMm: 0.4,
      areaMm: [40, 40],
    };
    expect(toolDef.applyBlocker!(validTextureOp)).toBeNull();

    // Texture op over 400 features -> TOO_DENSE
    const overDenseTextureOp: ToolOp = {
      id: 'op_knrl_over',
      part: 'plate',
      plane: PLANE_Z5,
      offset: [0, 0],
      rotationDeg: 0,
      kind: 'texture',
      pattern: 'knurl',
      pitchMm: 0.5,
      depthMm: 0.4,
      areaMm: [80, 80],
    };
    expect(toolDef.applyBlocker!(overDenseTextureOp)).toBe(TOO_DENSE);
  });
});
