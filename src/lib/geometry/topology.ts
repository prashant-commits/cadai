/**
 * B-Rep topology data structures and decoder (Task 10).
 * Pure module, no React.
 */

export interface TopoFace {
  id: number;
  part: string;
  kind: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';
  area: number;
  center: [number, number, number];
  normal?: [number, number, number];
  axis?: [number, number, number];
  radius?: number;
}

export interface TopoEdge {
  id: number;
  kind: 'line' | 'circle' | 'other';
  length: number;
  radius?: number;
  center?: [number, number, number];
  faces: [number, number];
}

export interface TopoPart {
  label: string;
  min: [number, number, number];
  max: [number, number, number];
}

export type Topology = {
  mesh: {
    positions: Float32Array;
    indices: Uint32Array;
    faceIds: Uint32Array;
  };
  faces: TopoFace[];
  edges: TopoEdge[];
  parts: TopoPart[];
};

function isNumber3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function decodeTopology(json: unknown): Topology {
  if (!json || typeof json !== 'object') {
    throw new Error('decodeTopology: input must be a non-null object');
  }

  const raw = json as Record<string, unknown>;
  const meshRaw = raw.mesh as Record<string, unknown> | undefined;
  if (!meshRaw || typeof meshRaw !== 'object') {
    throw new Error('decodeTopology: missing or invalid mesh object');
  }

  const positionsRaw = meshRaw.positions;
  const indicesRaw = meshRaw.indices;
  const faceIdsRaw = meshRaw.faceIds;

  if (
    (!Array.isArray(positionsRaw) && !(positionsRaw instanceof Float32Array)) ||
    (!Array.isArray(indicesRaw) && !(indicesRaw instanceof Uint32Array)) ||
    (!Array.isArray(faceIdsRaw) && !(faceIdsRaw instanceof Uint32Array))
  ) {
    throw new Error('decodeTopology: mesh positions, indices, and faceIds must be arrays');
  }

  const positions = positionsRaw instanceof Float32Array ? positionsRaw : new Float32Array(positionsRaw);
  const indices = indicesRaw instanceof Uint32Array ? indicesRaw : new Uint32Array(indicesRaw);
  const faceIds = faceIdsRaw instanceof Uint32Array ? faceIdsRaw : new Uint32Array(faceIdsRaw);

  if (positions.length % 3 !== 0) {
    throw new Error('decodeTopology: mesh positions length must be a multiple of 3');
  }
  if (indices.length % 3 !== 0) {
    throw new Error('decodeTopology: mesh indices length must be a multiple of 3');
  }
  if (faceIds.length !== indices.length / 3) {
    throw new Error('decodeTopology: mesh faceIds length must match triangle count');
  }

  if (!Array.isArray(raw.faces)) {
    throw new Error('decodeTopology: faces must be an array');
  }
  const faces: TopoFace[] = raw.faces.map((f, i) => {
    if (!f || typeof f !== 'object') {
      throw new Error(`decodeTopology: face at index ${i} is not an object`);
    }
    const face = f as Record<string, unknown>;
    if (
      typeof face.id !== 'number' ||
      typeof face.part !== 'string' ||
      typeof face.kind !== 'string' ||
      typeof face.area !== 'number' ||
      !isNumber3(face.center)
    ) {
      throw new Error(`decodeTopology: face at index ${i} has invalid required fields`);
    }

    const res: TopoFace = {
      id: face.id,
      part: face.part,
      kind: face.kind as TopoFace['kind'],
      area: face.area,
      center: face.center,
    };
    if (isNumber3(face.normal)) res.normal = face.normal;
    if (isNumber3(face.axis)) res.axis = face.axis;
    if (typeof face.radius === 'number' && Number.isFinite(face.radius)) res.radius = face.radius;
    return res;
  });

  if (!Array.isArray(raw.edges)) {
    throw new Error('decodeTopology: edges must be an array');
  }
  const edges: TopoEdge[] = raw.edges.map((e, i) => {
    if (!e || typeof e !== 'object') {
      throw new Error(`decodeTopology: edge at index ${i} is not an object`);
    }
    const edge = e as Record<string, unknown>;
    if (
      typeof edge.id !== 'number' ||
      typeof edge.kind !== 'string' ||
      typeof edge.length !== 'number' ||
      !Array.isArray(edge.faces)
    ) {
      throw new Error(`decodeTopology: edge at index ${i} has invalid required fields`);
    }

    const edgeFaces = edge.faces as [number, number];
    const res: TopoEdge = {
      id: edge.id,
      kind: edge.kind as TopoEdge['kind'],
      length: edge.length,
      faces: edgeFaces,
    };
    if (typeof edge.radius === 'number' && Number.isFinite(edge.radius)) res.radius = edge.radius;
    if (isNumber3(edge.center)) res.center = edge.center;
    return res;
  });

  if (!Array.isArray(raw.parts)) {
    throw new Error('decodeTopology: parts must be an array');
  }
  const parts: TopoPart[] = raw.parts.map((p, i) => {
    if (!p || typeof p !== 'object') {
      throw new Error(`decodeTopology: part at index ${i} is not an object`);
    }
    const part = p as Record<string, unknown>;
    if (
      typeof part.label !== 'string' ||
      !isNumber3(part.min) ||
      !isNumber3(part.max)
    ) {
      throw new Error(`decodeTopology: part at index ${i} has invalid fields`);
    }
    return {
      label: part.label,
      min: part.min,
      max: part.max,
    };
  });

  return {
    mesh: { positions, indices, faceIds },
    faces,
    edges,
    parts,
  };
}

export function faceAtTriangle(topo: Topology, triIndex: number): TopoFace | null {
  if (triIndex < 0 || triIndex >= topo.mesh.faceIds.length) {
    return null;
  }
  const faceId = topo.mesh.faceIds[triIndex];
  for (const face of topo.faces) {
    if (face.id === faceId) {
      return face;
    }
  }
  return null;
}

export async function fetchTopology(artifactId: string): Promise<Topology | null> {
  try {
    const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`);
    if (!res.ok) {
      return null;
    }
    const json = await res.json();
    return decodeTopology(json);
  } catch {
    return null;
  }
}
