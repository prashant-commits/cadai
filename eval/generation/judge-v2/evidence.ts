import { runBrep, type BrepResult } from '@/lib/engine/brep-runner';
import {
  parseStlTriangles,
  renderTriangleViews,
  renderStlViews,
  type ColoredTriangle,
  type RenderedView,
  type RGB,
  type ViewName,
} from '@/lib/engine/stl-renderer';
import { parseParams } from '@/lib/design/parse-params';
import { applyParameterOverrides } from '@/lib/agent/nodes/brep-agent-build';

export interface LegendItem {
  label: string;
  color: RGB;
  hex: string;
}

export const PART_PALETTE: Array<{ rgb: RGB; hex: string }> = [
  { rgb: [65, 117, 164], hex: '#4175A4' },  // Steel Blue
  { rgb: [218, 124, 48], hex: '#DA7C30' },  // Terracotta
  { rgb: [67, 160, 71], hex: '#43A047' },   // Green
  { rgb: [142, 68, 173], hex: '#8E44AD' },  // Purple
  { rgb: [230, 81, 0], hex: '#E65100' },    // Deep Orange
  { rgb: [0, 150, 136], hex: '#009688' },   // Teal
  { rgb: [233, 30, 99], hex: '#E91E63' },   // Pink
  { rgb: [121, 85, 72], hex: '#795548' },   // Brown
  { rgb: [96, 125, 139], hex: '#607D8B' },  // Slate
  { rgb: [244, 81, 30], hex: '#F4511E' },   // Flame
  { rgb: [30, 136, 229], hex: '#1E88E5' },  // Bright Blue
  { rgb: [124, 179, 66], hex: '#7CB342' },  // Light Green
];

export interface Point2D {
  x: number;
  y: number;
}

export interface StabilityReport {
  com: [number, number, number];
  footprintPointsCount: number;
  marginMm: number;
  isStable: boolean;
}

export interface PartFact {
  label: string;
  size: [number, number, number];
  volume: number;
  valid: boolean;
  centroid: [number, number, number];
}

export interface ParameterFact {
  name: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
}

export interface FloorViolation {
  part?: string;
  minZ: number;
  deltaMm: number;
}

export interface FactsTable {
  parts: PartFact[];
  solids: number;
  bbox: {
    min: [number, number, number];
    max: [number, number, number];
    span: [number, number, number];
  };
  floorViolations: FloorViolation[];
  interferences: {
    closed: Array<{ a: string; b: string; volume: number }>;
    poses: Record<string, Array<{ a: string; b: string; volume: number }>>;
  };
  stability: StabilityReport;
  parameters: ParameterFact[];
  disconnected?: string[];
  notes?: string[];
}

export interface PoseRender {
  name: string;
  paramName: string;
  value: number;
  views: RenderedView[];
}

export interface EvidencePack {
  closedViews: RenderedView[];
  lidHiddenViews: RenderedView[];
  poseRenders: PoseRender[];
  legend: LegendItem[];
  facts: FactsTable;
  factsMarkdown: string;
  notes?: string;
}

export interface BuildEvidenceOptions {
  script?: string;
  stl?: string;
  poses?: Record<string, number>;
  notes?: string;
  runBrepFn?: typeof runBrep;
}

export function computeConvexHull2D(points: Point2D[]): Point2D[] {
  if (points.length <= 2) return points;
  const sorted = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o: Point2D, a: Point2D, b: Point2D) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function distToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

export function pointPolygonDistance2D(p: Point2D, polygon: Point2D[]): { inside: boolean; marginMm: number } {
  if (polygon.length === 0) return { inside: false, marginMm: 0 };
  if (polygon.length === 1) {
    const d = Math.hypot(p.x - polygon[0].x, p.y - polygon[0].y);
    return { inside: false, marginMm: -d };
  }
  if (polygon.length === 2) {
    const d = distToSegment(p, polygon[0], polygon[1]);
    return { inside: false, marginMm: -d };
  }

  let inside = true;
  let minDistance = Infinity;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cp = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cp < -1e-5) {
      inside = false;
    }
    const d = distToSegment(p, a, b);
    if (d < minDistance) {
      minDistance = d;
    }
  }

  const marginMm = inside ? minDistance : -minDistance;
  return { inside, marginMm: Math.round(marginMm * 100) / 100 };
}

export function computeStability(
  com: [number, number, number],
  triangles: Array<{ a: [number, number, number]; b: [number, number, number]; c: [number, number, number] }>
): StabilityReport {
  // Collect vertices with z <= 0.5 mm
  const points: Point2D[] = [];
  for (const t of triangles) {
    if (t.a[2] <= 0.5) points.push({ x: t.a[0], y: t.a[1] });
    if (t.b[2] <= 0.5) points.push({ x: t.b[0], y: t.b[1] });
    if (t.c[2] <= 0.5) points.push({ x: t.c[0], y: t.c[1] });
  }

  if (points.length === 0) {
    return { com, footprintPointsCount: 0, marginMm: -100, isStable: false };
  }

  const hull = computeConvexHull2D(points);
  const pCom: Point2D = { x: com[0], y: com[1] };
  const { inside, marginMm } = pointPolygonDistance2D(pCom, hull);

  return {
    com,
    footprintPointsCount: points.length,
    marginMm,
    isStable: inside && marginMm > 0,
  };
}

function parseAsciiOrBase64Stl(stlData: string): string {
  const trimmed = stlData.trim();
  if (trimmed.startsWith('solid') || trimmed.startsWith('facet')) {
    return trimmed;
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.includes('solid') || decoded.includes('facet')) {
      return decoded;
    }
  } catch {
    // not base64
  }
  return stlData;
}

export function formatFactsTable(facts: FactsTable): string {
  const lines: string[] = ['### Deterministic Geometry Facts'];

  if (facts.notes && facts.notes.length > 0) {
    lines.push(`**Notes**: ${facts.notes.join('; ')}`);
  }

  // Parts table
  if (facts.parts.length > 0) {
    lines.push('\n#### Labelled Parts');
    lines.push('| Part Label | Size (X x Y x Z mm) | Volume (mm³) | Valid | Centroid (X, Y, Z mm) |');
    lines.push('| :--- | :--- | :--- | :--- | :--- |');
    for (const p of facts.parts) {
      const sizeStr = `${p.size[0].toFixed(1)} x ${p.size[1].toFixed(1)} x ${p.size[2].toFixed(1)}`;
      const centroidStr = `(${p.centroid[0].toFixed(1)}, ${p.centroid[1].toFixed(1)}, ${p.centroid[2].toFixed(1)})`;
      lines.push(`| ${p.label || '(unnamed)'} | ${sizeStr} | ${Math.round(p.volume)} | ${p.valid ? 'yes' : 'NO'} | ${centroidStr} |`);
    }
  }

  // BBox & Solids
  const b = facts.bbox;
  lines.push('\n#### Bounding Box & Assembly');
  lines.push(`- **Solids count**: ${facts.solids}`);
  lines.push(`- **Bounds Min**: (${b.min[0].toFixed(1)}, ${b.min[1].toFixed(1)}, ${b.min[2].toFixed(1)}) mm`);
  lines.push(`- **Bounds Max**: (${b.max[0].toFixed(1)}, ${b.max[1].toFixed(1)}, ${b.max[2].toFixed(1)}) mm`);
  lines.push(`- **Total Span**: ${b.span[0].toFixed(1)} (W) x ${b.span[1].toFixed(1)} (D) x ${b.span[2].toFixed(1)} (H) mm`);

  // Floor violations
  lines.push('\n#### Floor Violations (z < 0)');
  if (facts.floorViolations.length === 0) {
    lines.push('- **None**: Entire geometry rests on or above the ground plane (z >= 0).');
  } else {
    for (const fv of facts.floorViolations) {
      lines.push(`- **VIOLATION**: ${fv.part ? `'${fv.part}'` : 'Geometry'} extends ${fv.deltaMm.toFixed(2)} mm below the build plate (min z = ${fv.minZ.toFixed(2)} mm).`);
    }
  }

  // Disconnected parts
  lines.push('\n#### Disconnected Parts');
  const disconnected = facts.disconnected ?? [];
  if (disconnected.length === 0) {
    lines.push('- **None**: All parts touch or are within 1 mm of another part.');
  } else {
    for (const p of disconnected) {
      lines.push(`- **DISCONNECTED**: Part '${p}' does not touch and is not within 1 mm of any other part in the closed state.`);
    }
  }

  // Interferences
  lines.push('\n#### Part Interferences');
  const closedClashes = facts.interferences.closed;
  if (closedClashes.length === 0) {
    lines.push('- **Closed state**: None (clean clearances between all parts).');
  } else {
    for (const cl of closedClashes) {
      lines.push(`- **Closed state collision**: '${cl.a}' collides with '${cl.b}' (interference volume: ${cl.volume.toFixed(2)} mm³).`);
    }
  }

  for (const [poseName, clashes] of Object.entries(facts.interferences.poses)) {
    if (clashes.length === 0) {
      lines.push(`- **Pose ${poseName}**: None.`);
    } else {
      for (const cl of clashes) {
        lines.push(`- **Pose ${poseName} collision**: '${cl.a}' collides with '${cl.b}' (volume: ${cl.volume.toFixed(2)} mm³).`);
      }
    }
  }

  // Stability
  lines.push('\n#### Stability');
  const s = facts.stability;
  const status = s.isStable ? 'STABLE' : 'UNSTABLE';
  lines.push(`- **Assembly Center of Mass**: (${s.com[0].toFixed(1)}, ${s.com[1].toFixed(1)}, ${s.com[2].toFixed(1)}) mm`);
  lines.push(`- **Stability Margin**: ${s.marginMm > 0 ? '+' : ''}${s.marginMm.toFixed(1)} mm (${status})`);
  lines.push(`  *(Center of mass is ${s.isStable ? 'inside' : 'outside'} the footprint convex hull by ${Math.abs(s.marginMm).toFixed(1)} mm)*`);

  // Parameters
  if (facts.parameters.length > 0) {
    lines.push('\n#### Adjustable Parameters');
    lines.push('| Parameter | Value | Range [min:max] | Description |');
    lines.push('| :--- | :--- | :--- | :--- |');
    for (const p of facts.parameters) {
      const range = p.min !== undefined && p.max !== undefined ? `[${p.min}:${p.max}]` : '-';
      lines.push(`| \`${p.name}\` | ${p.value} | ${range} | ${p.description || '-'} |`);
    }
  }

  return lines.join('\n');
}

export async function buildEvidence(opts: BuildEvidenceOptions): Promise<EvidencePack> {
  const runner = opts.runBrepFn ?? runBrep;

  // Case 1: Bare STL (no script)
  if (!opts.script && opts.stl) {
    const rawStl = parseAsciiOrBase64Stl(opts.stl);
    const tris = parseStlTriangles(rawStl);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const t of tris) {
      for (const v of [t.a, t.b, t.c]) {
        if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
        if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
        if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
      }
    }
    const bbox = {
      min: [minX, minY, minZ] as [number, number, number],
      max: [maxX, maxY, maxZ] as [number, number, number],
      span: [maxX - minX, maxY - minY, maxZ - minZ] as [number, number, number],
    };

    const views = renderStlViews(rawStl, {
      views: ['front', 'right', 'top', 'iso', 'back_iso', 'left'],
      size: 768,
    });

    const com: [number, number, number] = [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    ];
    const stability = computeStability(com, tris);
    const floorViolations: FloorViolation[] = [];
    if (minZ < -0.01) {
      floorViolations.push({ minZ, deltaMm: Math.abs(minZ) });
    }

    const facts: FactsTable = {
      parts: [],
      solids: 1,
      bbox,
      floorViolations,
      interferences: { closed: [], poses: {} },
      stability,
      parameters: [],
      disconnected: [],
      notes: ['no script: facts limited'],
    };

    return {
      closedViews: views,
      lidHiddenViews: [],
      poseRenders: [],
      legend: [],
      facts,
      factsMarkdown: formatFactsTable(facts),
      notes: opts.notes,
    };
  }

  if (!opts.script) {
    throw new Error('buildEvidence requires either script or stl');
  }

  // Case 2: Full script execution
  const script = opts.script;
  const mainRes: BrepResult = await runner(script, {
    interferences: true,
    partMeshes: true,
  });

  if (!mainRes.ok) {
    throw new Error(`buildEvidence failed to compile script: ${mainRes.error ?? 'unknown error'}`);
  }

  // Build part facts and triangles
  const partFacts: PartFact[] = [];
  const legend: LegendItem[] = [];
  const coloredTriangles: Array<ColoredTriangle & { label?: string }> = [];

  const parts = mainRes.parts ?? [];
  const partMeshes = mainRes.partMeshes ?? {};

  for (let idx = 0; idx < parts.length; idx++) {
    const p = parts[idx];
    const span: [number, number, number] = [
      p.max[0] - p.min[0],
      p.max[1] - p.min[1],
      p.max[2] - p.min[2],
    ];
    const centroid: [number, number, number] = p.centroid ?? [
      (p.min[0] + p.max[0]) / 2,
      (p.min[1] + p.max[1]) / 2,
      (p.min[2] + p.max[2]) / 2,
    ];

    partFacts.push({
      label: p.label,
      size: span,
      volume: p.volume,
      valid: p.valid,
      centroid,
    });

    const pal = PART_PALETTE[idx % PART_PALETTE.length];
    const partLabel = p.label || `part_${idx + 1}`;
    legend.push({
      label: partLabel,
      color: pal.rgb,
      hex: pal.hex,
    });

    const meshData = (p.label && partMeshes[p.label]) || partMeshes[partLabel];
    if (meshData) {
      const ascii = parseAsciiOrBase64Stl(meshData);
      const tris = parseStlTriangles(ascii);
      for (const t of tris) {
        coloredTriangles.push({
          a: t.a,
          b: t.b,
          c: t.c,
          color: pal.rgb,
          label: partLabel,
        });
      }
    }
  }

  // If partMeshes was empty, fallback to main STL
  if (coloredTriangles.length === 0 && mainRes.stl) {
    const ascii = parseAsciiOrBase64Stl(mainRes.stl);
    const tris = parseStlTriangles(ascii);
    const defaultColor: RGB = [180, 185, 195];
    for (const t of tris) {
      coloredTriangles.push({ a: t.a, b: t.b, c: t.c, color: defaultColor });
    }
  }

  // Render 6 standard views at 768 px
  const viewNames: ViewName[] = ['front', 'right', 'top', 'iso', 'back_iso', 'left'];
  const { views: closedViews } = renderTriangleViews(coloredTriangles, {
    views: viewNames,
    size: 768,
  });

  // Render "lid hidden" set: iso and top without lid/cover/door
  const nonLidTriangles = coloredTriangles.filter(
    (t) => !t.label || !/lid|cover|door/i.test(t.label)
  );
  let lidHiddenViews: RenderedView[] = [];
  const hasLidPart = parts.some((p) => /lid|cover|door/i.test(p.label));
  if (hasLidPart && nonLidTriangles.length > 0) {
    const res = renderTriangleViews(nonLidTriangles, {
      views: ['iso', 'top'],
      size: 768,
    });
    lidHiddenViews = res.views;
  }

  // Parse parameters
  const parsedParams = parseParams(script);
  const parameters: ParameterFact[] = [];
  for (const p of parsedParams) {
    if (typeof p.value === 'number') {
      parameters.push({
        name: p.name,
        value: p.value,
        min: p.min,
        max: p.max,
        step: p.step,
        description: p.label,
      });
    }
  }

  // Poses: detect from parameters or explicit opts.poses
  const poseRenders: PoseRender[] = [];
  const poseInterferences: Record<string, Array<{ a: string; b: string; volume: number }>> = {};

  const posesToTest: Array<{ paramName: string; value: number }> = [];

  if (opts.poses && Object.keys(opts.poses).length > 0) {
    for (const [k, v] of Object.entries(opts.poses)) {
      posesToTest.push({ paramName: k, value: v });
    }
  } else {
    for (const p of parameters) {
      const match = /open|angle|pose|swing|lid|door/i.test(p.name) || (p.description && /open|angle|pose|swing|lid|door/i.test(p.description));
      if (match && p.min !== undefined && p.max !== undefined && p.max > p.min) {
        posesToTest.push({ paramName: p.name, value: p.max });
        if (p.min !== p.value) {
          posesToTest.push({ paramName: p.name, value: p.min });
        }
      }
    }
  }

  for (const pose of posesToTest) {
    const poseKey = `${pose.paramName}=${pose.value}`;
    const overridden = applyParameterOverrides(script, { [pose.paramName]: pose.value });
    try {
      const poseRes = await runner(overridden, {
        interferences: true,
        partMeshes: true,
      });
      if (poseRes.ok) {
        poseInterferences[poseKey] = poseRes.interferences ?? [];
        const poseTriangles: ColoredTriangle[] = [];
        const pMeshes = poseRes.partMeshes ?? {};
        const pParts = poseRes.parts ?? [];

        for (let idx = 0; idx < pParts.length; idx++) {
          const pt = pParts[idx];
          const pal = PART_PALETTE[idx % PART_PALETTE.length];
          const ptLabel = pt.label || `part_${idx + 1}`;
          const pData = (pt.label && pMeshes[pt.label]) || pMeshes[ptLabel];
          if (pData) {
            const trs = parseStlTriangles(parseAsciiOrBase64Stl(pData));
            for (const t of trs) {
              poseTriangles.push({ a: t.a, b: t.b, c: t.c, color: pal.rgb });
            }
          }
        }
        if (poseTriangles.length === 0 && poseRes.stl) {
          const trs = parseStlTriangles(parseAsciiOrBase64Stl(poseRes.stl));
          for (const t of trs) {
            poseTriangles.push({ a: t.a, b: t.b, c: t.c, color: [180, 185, 195] });
          }
        }
        const { views: pViews } = renderTriangleViews(poseTriangles, {
          views: ['iso', 'right'],
          size: 768,
        });
        poseRenders.push({
          name: poseKey,
          paramName: pose.paramName,
          value: pose.value,
          views: pViews,
        });
      }
    } catch (err) {
      console.warn(`Pose ${poseKey} render failed:`, err);
    }
  }

  // Calculate stability and floor violations
  const totalVolume = partFacts.reduce((sum, p) => sum + p.volume, 0);
  let com: [number, number, number] = [0, 0, 0];
  if (totalVolume > 0) {
    com = [
      partFacts.reduce((sum, p) => sum + p.volume * p.centroid[0], 0) / totalVolume,
      partFacts.reduce((sum, p) => sum + p.volume * p.centroid[1], 0) / totalVolume,
      partFacts.reduce((sum, p) => sum + p.volume * p.centroid[2], 0) / totalVolume,
    ];
  } else if (mainRes.bbox) {
    com = [
      (mainRes.bbox.min[0] + mainRes.bbox.max[0]) / 2,
      (mainRes.bbox.min[1] + mainRes.bbox.max[1]) / 2,
      (mainRes.bbox.min[2] + mainRes.bbox.max[2]) / 2,
    ];
  }

  const stability = computeStability(com, coloredTriangles);

  const floorViolations: FloorViolation[] = [];
  for (const p of parts) {
    if (p.min[2] < -0.01) {
      floorViolations.push({
        part: p.label,
        minZ: p.min[2],
        deltaMm: Math.abs(p.min[2]),
      });
    }
  }
  if (floorViolations.length === 0 && mainRes.bbox && mainRes.bbox.min[2] < -0.01) {
    floorViolations.push({
      minZ: mainRes.bbox.min[2],
      deltaMm: Math.abs(mainRes.bbox.min[2]),
    });
  }

  const minB = mainRes.bbox?.min ?? [0, 0, 0];
  const maxB = mainRes.bbox?.max ?? [0, 0, 0];
  const bbox = {
    min: minB,
    max: maxB,
    span: [maxB[0] - minB[0], maxB[1] - minB[1], maxB[2] - minB[2]] as [number, number, number],
  };

  let disconnected: string[] = Array.isArray(mainRes.disconnected) ? mainRes.disconnected : [];
  if (!mainRes.disconnected && parts.length > 1) {
    const disc: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const pi = parts[i];
      let connected = false;
      for (let j = 0; j < parts.length; j++) {
        if (i === j) continue;
        const pj = parts[j];
        const dx = Math.max(0, Math.max(pi.min[0] - pj.max[0], pj.min[0] - pi.max[0]));
        const dy = Math.max(0, Math.max(pi.min[1] - pj.max[1], pj.min[1] - pi.max[1]));
        const dz = Math.max(0, Math.max(pi.min[2] - pj.max[2], pj.min[2] - pi.max[2]));
        if (Math.hypot(dx, dy, dz) <= 1.0) {
          connected = true;
          break;
        }
      }
      if (!connected) {
        disc.push(pi.label || `part_${i + 1}`);
      }
    }
    disconnected = disc;
  }

  const facts: FactsTable = {
    parts: partFacts,
    solids: mainRes.solids,
    bbox,
    floorViolations,
    interferences: {
      closed: mainRes.interferences ?? [],
      poses: poseInterferences,
    },
    stability,
    parameters,
    disconnected,
    notes: opts.notes ? [opts.notes] : undefined,
  };

  return {
    closedViews,
    lidHiddenViews,
    poseRenders,
    legend,
    facts,
    factsMarkdown: formatFactsTable(facts),
    notes: opts.notes,
  };
}
