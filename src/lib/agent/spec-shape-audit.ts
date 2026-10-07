import { AssemblySpec } from './assembly-spec';
import { SpecViolation } from './spec-audit';

export function isSimplePolygon(points: number[][]): boolean {
  if (points.length < 3) return false;
  
  // check for self intersections
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    
    for (let j = i + 2; j < points.length; j++) {
      // ignore adjacent edge (last edge connected to first)
      if (i === 0 && j === points.length - 1) continue;
      
      const p3 = points[j];
      const p4 = points[(j + 1) % points.length];
      
      if (segmentsIntersect(p1, p2, p3, p4)) {
        return false;
      }
    }
  }
  return true;
}

function segmentsIntersect(a: number[], b: number[], c: number[], d: number[]): boolean {
  const ccw = (A: number[], B: number[], C: number[]) => {
    return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]);
  };
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

export function pointInPolygon(point: number[], polygon: number[][]): boolean {
  let isInside = false;
  let j = polygon.length - 1;
  for (let i = 0; i < polygon.length; i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (
      (pi[1] > point[1]) !== (pj[1] > point[1]) &&
      point[0] < ((pj[0] - pi[0]) * (point[1] - pi[1])) / (pj[1] - pi[1]) + pi[0]
    ) {
      isInside = !isInside;
    }
    j = i;
  }
  return isInside;
}

export function auditSpecShapes(spec: AssemblySpec | null): SpecViolation[] {
  if (!spec) return [];
  const violations: SpecViolation[] = [];

  for (let i = 0; i < (spec.components?.length || 0); i++) {
    const comp = spec.components![i];
    if (!comp.shape) continue;

    const shape = comp.shape;
    const field = `components[${i}].shape`;
    
    if (!comp.localExtents) {
      violations.push({
        kind: 'shape',
        field,
        expected: 'localExtents',
        measured: 'missing',
        severity: 'error',
        message: 'Component has a shape but no localExtents.'
      });
      continue;
    }
    
    const [ex, ey, ez] = comp.localExtents;

    if (shape.kind === 'cylinder' || shape.kind === 'tube') {
      if (!shape.axis) {
        violations.push({ kind: 'shape', field, expected: 'axis', measured: 'missing', severity: 'error', message: `${shape.kind} missing axis.` });
      } else {
        let e1, e2;
        if (shape.axis === 'x') { e1 = ey; e2 = ez; }
        else if (shape.axis === 'y') { e1 = ex; e2 = ez; }
        else { e1 = ex; e2 = ey; }
        
        if (Math.abs(e1 - e2) > 0.5) {
          violations.push({ kind: 'shape', field, expected: 'cross extents equal', measured: `diff ${Math.abs(e1-e2)}`, severity: 'error', message: `${shape.kind} cross extents differ by > 0.5 mm.` });
        }
        
        if (shape.kind === 'tube') {
          if (shape.innerD === undefined || shape.innerD <= 0 || shape.innerD >= Math.min(e1, e2)) {
            violations.push({ kind: 'shape', field, expected: 'valid innerD', measured: shape.innerD ?? 'missing', severity: 'error', message: `tube missing or invalid innerD.` });
          }
        }
      }
    } else if (shape.kind === 'shell') {
      if (!shape.openFace || shape.wall === undefined) {
        violations.push({ kind: 'shape', field, expected: 'openFace and wall', measured: 'missing', severity: 'error', message: `shell missing openFace or wall.` });
      } else {
        const wall2 = 2 * shape.wall;
        if (wall2 >= ex || wall2 >= ey || wall2 >= ez) {
           violations.push({ kind: 'shape', field, expected: 'cavity exists', measured: `wall ${shape.wall}`, severity: 'error', message: `shell wall too thick, cavity would vanish.` });
        }
      }
    } else if (shape.kind === 'profile') {
      if (!shape.plane) {
        violations.push({ kind: 'shape', field, expected: 'plane', measured: 'missing', severity: 'error', message: `profile missing plane.` });
      } else if (!shape.points || shape.points.length < 3) {
        violations.push({ kind: 'shape', field, expected: '>= 3 points', measured: shape.points?.length ?? 0, severity: 'error', message: `profile has fewer than 3 points.` });
      } else {
        if (!isSimplePolygon(shape.points)) {
          violations.push({ kind: 'shape', field, expected: 'simple polygon', measured: 'self-intersecting', severity: 'error', message: `profile polygon is not simple.` });
        }
        
        let eu, ev;
        if (shape.plane === 'xy') { eu = ex; ev = ey; }
        else if (shape.plane === 'xz') { eu = ex; ev = ez; }
        else { eu = ey; ev = ez; }
        
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const [u, v] of shape.points) {
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        
        if (Math.abs(minU) > 0.5 || Math.abs(minV) > 0.5 || Math.abs(maxU - eu) > 0.5 || Math.abs(maxV - ev) > 0.5) {
          violations.push({ kind: 'shape', field, expected: `bbox [0..${eu}] x [0..${ev}]`, measured: `bbox [${minU}..${maxU}] x [${minV}..${maxV}]`, severity: 'error', message: `profile bbox of points not equal to extent within 0.5 mm.` });
        }
        
        if (shape.holes) {
          for (let hi = 0; hi < shape.holes.length; hi++) {
            const h = shape.holes[hi];
            if (h.length < 3) {
              violations.push({ kind: 'shape', field: `${field}.holes[${hi}]`, expected: '>= 3 points', measured: h.length, severity: 'error', message: `profile hole has fewer than 3 points.` });
            } else {
              for (const p of h) {
                if (!pointInPolygon(p, shape.points)) {
                  violations.push({ kind: 'shape', field: `${field}.holes[${hi}]`, expected: 'inside outline', measured: 'outside', severity: 'error', message: `profile hole point outside outline.` });
                  break;
                }
              }
            }
          }
        }
      }
    }
  }

  for (let i = 0; i < spec.guides.length; i++) {
    const guide = spec.guides[i];
    const field = `guides[${i}]`;
    if (guide.kind === 'envelope') {
      if (!guide.localExtents) {
        violations.push({ kind: 'shape', field, expected: 'localExtents', measured: 'missing', severity: 'error', message: `envelope guide without localExtents.` });
      }
    } else if (guide.kind === 'line') {
      if (!guide.points || guide.points.length < 2) {
        violations.push({ kind: 'shape', field, expected: '>= 2 points', measured: guide.points?.length ?? 0, severity: 'error', message: `line guide with < 2 points.` });
      }
    }
  }

  return violations;
}
