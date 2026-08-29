import * as THREE from 'three';
import { downloadFile } from './stl-exporter';

/**
 * Builds standard 3MF model XML from Three.js BufferGeometry.
 */
export function build3mfXml(geometry: THREE.BufferGeometry): string {
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

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">CAD AI Model</metadata>
  <metadata name="Designer">CAD AI Agent</metadata>
  <metadata name="Application">CAD AI Web</metadata>
  <resources>
    <object id="1" type="model">
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
export function export3mf(geometry: THREE.BufferGeometry, filename = 'cadai_model.3mf') {
  const xml = build3mfXml(geometry);
  downloadFile(filename, xml, 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
}
