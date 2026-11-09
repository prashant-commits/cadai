import * as THREE from 'three';
import { downloadFile } from './stl-exporter';
import type { ToolOp } from '@/lib/tools/ops';
import type { Topology } from '@/lib/geometry/topology';
import { MATERIAL_NAMES } from '@/lib/tools/phrases';

export const MATERIAL_DISPLAY_NAMES = MATERIAL_NAMES;

export interface Build3mfXmlPart {
  name: string;
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
}

export interface Build3mfXmlOpts {
  parts?: Build3mfXmlPart[];
  materials?: Array<Extract<ToolOp, { kind: 'material' }>>;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDisplayColor(hex: string): string {
  const clean = hex.replace(/^#/, '');
  return `#${clean.toUpperCase()}FF`;
}

/**
 * Splits the topology mesh by faces[faceIds[tri]].part into { name, positions, indices } per part label.
 */
export function partsFromTopology(topology: Topology): Array<{
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
}> {
  const { positions, indices, faceIds } = topology.mesh;
  const facePartMap = new Map<number, string>();
  for (const f of topology.faces) {
    facePartMap.set(f.id, f.part);
  }

  interface PartAccumulator {
    name: string;
    oldToNewIndex: Map<number, number>;
    positionsList: number[];
    indicesList: number[];
  }

  const partsMap = new Map<string, PartAccumulator>();

  const numTriangles = faceIds.length;
  for (let tri = 0; tri < numTriangles; tri++) {
    const faceId = faceIds[tri];
    const partName = facePartMap.get(faceId) ?? 'unknown';

    let partAcc = partsMap.get(partName);
    if (!partAcc) {
      partAcc = {
        name: partName,
        oldToNewIndex: new Map(),
        positionsList: [],
        indicesList: [],
      };
      partsMap.set(partName, partAcc);
    }

    for (let j = 0; j < 3; j++) {
      const oldV = indices[tri * 3 + j];
      let newV = partAcc.oldToNewIndex.get(oldV);
      if (newV === undefined) {
        newV = partAcc.positionsList.length / 3;
        partAcc.oldToNewIndex.set(oldV, newV);
        partAcc.positionsList.push(
          positions[oldV * 3],
          positions[oldV * 3 + 1],
          positions[oldV * 3 + 2]
        );
      }
      partAcc.indicesList.push(newV);
    }
  }

  return Array.from(partsMap.values()).map((p) => ({
    name: p.name,
    positions: new Float32Array(p.positionsList),
    indices: new Uint32Array(p.indicesList),
  }));
}

/**
 * Builds standard 3MF model XML from Three.js BufferGeometry or per-part meshes with materials.
 */
export function build3mfXml(
  geometry: THREE.BufferGeometry,
  opts?: Build3mfXmlOpts
): string {
  const hasParts = opts?.parts && opts.parts.length > 0;
  const hasMaterials = opts?.materials && opts.materials.length > 0;

  if (hasParts && hasMaterials) {
    const parts = opts.parts!;
    const materials = opts.materials!;

    const modelMat = [...materials].reverse().find((m) => m.target === 'model');

    const baseMaterials: Array<{ displayName: string; displayColor: string; key: string }> = [];
    const matKeyToIndex = new Map<string, number>();

    // Collect distinct materials used
    for (const part of parts) {
      const partMat = [...materials].reverse().find((m) => m.target === part.name);
      const effectiveMat = partMat ?? modelMat ?? null;
      if (effectiveMat) {
        const key = `${effectiveMat.material}_${effectiveMat.color.toUpperCase()}`;
        if (!matKeyToIndex.has(key)) {
          const idx = baseMaterials.length;
          matKeyToIndex.set(key, idx);
          const displayName =
            MATERIAL_DISPLAY_NAMES[effectiveMat.material] ?? effectiveMat.material;
          const displayColor = formatDisplayColor(effectiveMat.color);
          baseMaterials.push({ displayName, displayColor, key });
        }
      }
    }

    const objectsXml: string[] = [];
    const buildItemsXml: string[] = [];
    let nextObjectId = 2;

    for (const part of parts) {
      const objId = nextObjectId++;
      const partMat = [...materials].reverse().find((m) => m.target === part.name);
      const effectiveMat = partMat ?? modelMat ?? null;

      let matAttr = '';
      if (effectiveMat) {
        const key = `${effectiveMat.material}_${effectiveMat.color.toUpperCase()}`;
        const pindex = matKeyToIndex.get(key);
        if (pindex !== undefined) {
          matAttr = ` pid="1" pindex="${pindex}"`;
        }
      }

      const verticesXml: string[] = [];
      const numVertices = part.positions.length / 3;
      for (let i = 0; i < numVertices; i++) {
        const x = Number(part.positions[3 * i]).toFixed(4);
        const y = Number(part.positions[3 * i + 1]).toFixed(4);
        const z = Number(part.positions[3 * i + 2]).toFixed(4);
        verticesXml.push(`        <vertex x="${x}" y="${y}" z="${z}" />`);
      }

      const trianglesXml: string[] = [];
      const numTriangles = part.indices.length / 3;
      for (let i = 0; i < numTriangles; i++) {
        const v1 = part.indices[3 * i];
        const v2 = part.indices[3 * i + 1];
        const v3 = part.indices[3 * i + 2];
        trianglesXml.push(`        <triangle v1="${v1}" v2="${v2}" v3="${v3}" />`);
      }

      objectsXml.push(`    <object id="${objId}" name="${escapeXml(part.name)}" type="model"${matAttr}>
      <mesh>
        <vertices>
${verticesXml.join('\n')}
        </vertices>
        <triangles>
${trianglesXml.join('\n')}
        </triangles>
      </mesh>
    </object>`);

      buildItemsXml.push(`    <item objectid="${objId}" />`);
    }

    const baseMaterialsXml =
      baseMaterials.length > 0
        ? `    <basematerials id="1">
${baseMaterials.map((bm) => `      <base name="${escapeXml(bm.displayName)}" displaycolor="${bm.displayColor}" />`).join('\n')}
    </basematerials>\n`
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">CAD AI Model</metadata>
  <metadata name="Designer">CAD AI Agent</metadata>
  <metadata name="Application">CAD AI Web</metadata>
  <resources>
${baseMaterialsXml}${objectsXml.join('\n')}
  </resources>
  <build>
${buildItemsXml.join('\n')}
  </build>
</model>`;
  }

  // Fused geometry fallback (default behavior)
  const positionAttr = geometry.getAttribute('position');
  if (!positionAttr) {
    throw new Error('Geometry has no position attribute.');
  }

  const vertexCount = positionAttr.count;
  const verticesXml: string[] = [];
  const trianglesXml: string[] = [];

  const vertexMap = new Map<string, number>();
  let uniqueIndex = 0;

  for (let i = 0; i < vertexCount; i += 3) {
    const triIndices: number[] = [];

    for (let j = 0; j < 3; j++) {
      const idx = i + j;
      const x = positionAttr.getX(idx).toFixed(4);
      const y = positionAttr.getY(idx).toFixed(4);
      const z = positionAttr.getZ(idx).toFixed(4);
      const key = `${x},${y},${z}`;

      let vId = vertexMap.get(key);
      if (vId === undefined) {
        vId = uniqueIndex++;
        vertexMap.set(key, vId);
        verticesXml.push(`        <vertex x="${x}" y="${y}" z="${z}" />`);
      }
      triIndices.push(vId);
    }

    trianglesXml.push(`        <triangle v1="${triIndices[0]}" v2="${triIndices[1]}" v3="${triIndices[2]}" />`);
  }

  const effectiveMat =
    opts?.materials && opts.materials.length > 0
      ? [...opts.materials].reverse().find((m) => m.target === 'model') ??
        opts.materials[opts.materials.length - 1]
      : null;

  let baseMaterialsXml = '';
  let objMatAttr = '';

  if (effectiveMat) {
    const displayName =
      MATERIAL_NAMES[effectiveMat.material] ?? effectiveMat.material;
    const displayColor = formatDisplayColor(effectiveMat.color);
    baseMaterialsXml = `    <basematerials id="1">\n      <base name="${escapeXml(displayName)}" displaycolor="${displayColor}" />\n    </basematerials>\n`;
    objMatAttr = ' pid="1" pindex="0"';
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">CAD AI Model</metadata>
  <metadata name="Designer">CAD AI Agent</metadata>
  <metadata name="Application">CAD AI Web</metadata>
  <resources>
${baseMaterialsXml}    <object id="1" type="model"${objMatAttr}>
      <mesh>
        <vertices>
${verticesXml.join('\n')}
        </vertices>
        <triangles>
${trianglesXml.join('\n')}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`;
}

/**
 * Exports current geometry as 3MF package or XML file.
 */
export function export3mf(
  geometry: THREE.BufferGeometry,
  filename = 'cadai_model.3mf',
  opts?: Build3mfXmlOpts
) {
  const xml = build3mfXml(geometry, opts);
  downloadFile(filename, xml, 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
}
