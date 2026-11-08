import type { DesignerFacts } from '../../../src/lib/agent/designer/types';
import type { StatedDim } from '../types';
import { parseDimensions } from '../../../src/lib/agent/designer/tools';

interface Span {
  start: number;
  end: number;
}

function overlaps(span: Span, spans: Span[]): boolean {
  return spans.some((s) => Math.max(span.start, s.start) < Math.min(span.end, s.end));
}

function findNoun(text: string, index: number): string | undefined {
  const before = text.slice(Math.max(0, index - 120), index);
  // Match common nouns like "box", "two-part enclosure", "drawer organizer tray", "mounting plate", "outer shell", "stackable crate", "pin", "pins", "desk edge", "saddle"
  const m = /(?:(?:a|an|the|of|for)\s+)?((?:[a-zA-Z-]+\s+){0,3}(?:box|enclosure|tray|plate|shell|crate|fitting|tube|bracket|arm|stand|organizer|holder|dish|cradle|lid|base|pin|pins|shaft|desk edge|saddle|gear))\s*(?:(?:are|is)\s+)?(?:(?:at\s+the\s+top\s+)?(?:shaped\s+as\s+)?(?:a\s+)?(?:\d+\s+degree\s+)?(?:quarter-circle|arc)\s+of\s+)?$/i.exec(before);
  if (m && m[1]) {
    let noun = m[1].trim().toLowerCase();
    if (noun === 'pins') noun = 'pin';
    return noun;
  }
  return undefined;
}

/**
 * Parses millimetre sizes from a user request string into StatedDim objects.
 * Handles W x D x H triples with axes, diameter, radius, wall thickness, clearance,
 * lengths, and explicit dimensional callouts.
 */
export function parseStatedDims(request: string): StatedDim[] {
  const dims: StatedDim[] = [];
  const spans: Span[] = [];

  // Helper to add a stated dim if not overlapping
  const addDim = (span: Span, dim: StatedDim) => {
    spans.push(span);
    dims.push(dim);
  };

  // 1. Triples: e.g. "100 x 70 x 50 mm" or "80 x 50 x 30 mm"
  const tripleRe = /(\b\d+(?:\.\d+)?)\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*mm\b/gi;
  let match: RegExpExecArray | null;
  while ((match = tripleRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;
    spans.push(span);

    const noun = findNoun(request, match.index);
    const prefix = noun ? `${noun} ` : '';
    dims.push({ what: `${prefix}width`, mm: parseFloat(match[1]), axis: 'x' });
    dims.push({ what: `${prefix}depth`, mm: parseFloat(match[2]), axis: 'y' });
    dims.push({ what: `${prefix}height`, mm: parseFloat(match[3]), axis: 'z' });
  }

  // 2. Doubles: e.g. "20 x 10 mm cross-section"
  const doubleRe = /(\b\d+(?:\.\d+)?)\s*(?:x|×)\s*(\d+(?:\.\d+)?)\s*mm\s+([a-zA-Z-]+)/gi;
  while ((match = doubleRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;
    spans.push(span);

    const desc = match[3].toLowerCase();
    dims.push({ what: `${desc} width`, mm: parseFloat(match[1]) });
    dims.push({ what: `${desc} height`, mm: parseFloat(match[2]) });
  }

  // 3. Paired diameters: e.g. "two gear blanks of 40 mm and 60 mm outer diameter"
  const pairedDiaRe = /(\b\d+(?:\.\d+)?)\s*mm\s+and\s+(\d+(?:\.\d+)?)\s*mm\s+(outer|inner)?\s*diameter/gi;
  while ((match = pairedDiaRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;
    spans.push(span);

    const kind = match[3] ? `${match[3].toLowerCase()} ` : '';
    const noun = findNoun(request, match.index) || 'gear';
    dims.push({ what: `${noun} ${kind}diameter 1`, mm: parseFloat(match[1]) });
    dims.push({ what: `${noun} ${kind}diameter 2`, mm: parseFloat(match[2]) });
  }

  // 4. Single diameter: e.g. "25 mm outer diameter", "4 mm in diameter", "100 mm in diameter", "50 mm inner diameter"
  const diaRe = /(?:(pins?)\s+are\s+|(base|ring)\s+)?(\b\d+(?:\.\d+)?)\s*mm\s+(?:(outer|inner)\s+diameter|in\s+diameter|diameter\b)/gi;
  while ((match = diaRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    const matchedNoun = match[1] ? (match[1].toLowerCase().startsWith('pin') ? 'pin' : match[1].toLowerCase()) : match[2]?.toLowerCase();
    const kind = match[4] ? `${match[4].toLowerCase()} ` : '';
    const noun = matchedNoun || findNoun(request, match.index);
    let label = `${kind}diameter`.trim();
    if (noun && !label.includes(noun)) {
      label = `${noun} ${label}`;
    }
    addDim(span, { what: label, mm: parseFloat(match[3]) });
  }

  // 5. Walls: e.g. "2.5 mm walls", "3 mm walls", "2 mm internal walls" (not followed by plate/bracket/shelf/mount)
  const wallRe = /(\b\d+(?:\.\d+)?)\s*mm\s+(?:(internal)\s+)?walls?\b(?!\s+(?:plate|mount|bracket|shelf))/gi;
  while ((match = wallRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    const label = match[2] ? 'internal wall thickness' : 'wall thickness';
    addDim(span, { what: label, mm: parseFloat(match[1]) });
  }

  // 6. Clearance: e.g. "0.3 mm clearance", "0.5 mm clearance", "1 mm clearance"
  const clrRe = /(\b\d+(?:\.\d+)?)\s*mm\s+clearance\b/gi;
  while ((match = clrRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    addDim(span, { what: 'clearance', mm: parseFloat(match[1]) });
  }

  // 7. Radius: e.g. "120 mm radius", "50 mm radius"
  const radRe = /(\b\d+(?:\.\d+)?)\s*mm\s+radius\b/gi;
  while ((match = radRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    const noun = findNoun(request, match.index);
    const label = noun ? `${noun} radius` : 'radius';
    addDim(span, { what: label, mm: parseFloat(match[1]) });
  }

  // 8. Length / Long: e.g. "60 mm long main tube", "150 mm arm", "150 mm wall plate", "200 mm shelf arm"
  const lenRe = /(\b\d+(?:\.\d+)?)\s*mm\s+(?:long\s+([a-zA-Z\s]+?)(?:with|,|$)|(arm|wall\s+plate|shelf\s+arm)\b)/gi;
  while ((match = lenRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    const target = (match[2] || match[3] || '').trim().toLowerCase();
    const label = target ? `${target} length` : 'length';
    addDim(span, { what: label, mm: parseFloat(match[1]) });
  }

  // 9. Thickness: e.g. "8 mm thick", "40 mm thick", "12 mm thick"
  const thickRe = /(?:up\s+to\s+)?(\b\d+(?:\.\d+)?)\s*mm\s+thick\b/gi;
  while ((match = thickRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    const noun = findNoun(request, match.index);
    const label = noun ? `${noun} thickness` : 'thickness';
    addDim(span, { what: label, mm: parseFloat(match[1]) });
  }

  // 10. Across flats: e.g. "30 mm across flats"
  const flatsRe = /(\b\d+(?:\.\d+)?)\s*mm\s+across\s+flats\b/gi;
  while ((match = flatsRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    addDim(span, { what: 'hex across flats', mm: parseFloat(match[1]) });
  }

  // 11. Apart: e.g. "50 mm apart", "14 apart"
  const apartRe = /(\b\d+(?:\.\d+)?)\s*(?:mm\s*)?apart\b/gi;
  while ((match = apartRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    addDim(span, { what: 'spacing', mm: parseFloat(match[1]) });
  }

  // 12. Above the plate: e.g. "0.5 mm above the plate"
  const aboveRe = /(\b\d+(?:\.\d+)?)\s*mm\s+above\s+(?:the\s+)?plate\b/gi;
  while ((match = aboveRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    addDim(span, { what: 'elevation above plate', mm: parseFloat(match[1]) });
  }

  // 13. Through-holes: e.g. "5 mm through-holes"
  const holeRe = /(\b\d+(?:\.\d+)?)\s*mm\s+through-holes?\b/gi;
  while ((match = holeRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    addDim(span, { what: 'mounting hole diameter', mm: parseFloat(match[1]) });
  }

  // 14. Corner insets: e.g. "12 mm in from each corner"
  const insetRe = /(\b\d+(?:\.\d+)?)\s*mm\s+in\s+from\s+(?:each\s+)?corner\b/gi;
  while ((match = insetRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    addDim(span, { what: 'hole inset', mm: parseFloat(match[1]) });
  }

  // 15. Explicit wide / deep / tall / thick without triple (e.g. in dock prompt: "180 wide (X), 120 deep (Y) and 8 thick", "80 wide, 110 tall and 6 thick")
  const explicitRe = /(\b\d+(?:\.\d+)?)\s*(?:mm\s*)?(wide|deep|tall|thick)(?:\s*\([XYZ]\))?/gi;
  while ((match = explicitRe.exec(request)) !== null) {
    const span: Span = { start: match.index, end: match.index + match[0].length };
    if (overlaps(span, spans)) continue;

    const val = parseFloat(match[1]);
    const kind = match[2].toLowerCase();
    const noun = findNoun(request, match.index);
    const prefix = noun ? `${noun} ` : '';

    if (kind === 'wide') {
      addDim(span, { what: `${prefix}width`, mm: val, axis: 'x' });
    } else if (kind === 'deep') {
      addDim(span, { what: `${prefix}depth`, mm: val, axis: 'y' });
    } else if (kind === 'tall') {
      addDim(span, { what: `${prefix}height`, mm: val, axis: 'z' });
    } else if (kind === 'thick') {
      addDim(span, { what: `${prefix}thickness`, mm: val, axis: 'z' });
    }
  }

  return dims;
}

/** Check if two values are equal within 1 mm or 2%. */
function isClose(actual: number, target: number): boolean {
  const tolerance = Math.max(1.0, 0.02 * target);
  return Math.abs(actual - target) <= tolerance;
}

/** Extract top-level numeric assignments from Python script. */
export function extractTopLevelAssignments(script: string): Map<string, number> {
  const vars = new Map<string, number>();
  for (const line of script.split(/\r?\n/)) {
    // Matches simple numeric assignments: var_name = 100 or var_name = 2.5
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*(?:#.*)?$/.exec(line);
    if (m) {
      vars.set(m[1], Number(m[2]));
      continue;
    }
    // Simple arithmetic like var = other / 2 or var = a + b
    const mArith = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z0-9_.]+)\s*([\+\-\*\/])\s*([A-Za-z0-9_.]+)\s*(?:#.*)?$/.exec(line);
    if (mArith) {
      const v1 = vars.get(mArith[2]) ?? (isNaN(Number(mArith[2])) ? undefined : Number(mArith[2]));
      const v2 = vars.get(mArith[4]) ?? (isNaN(Number(mArith[4])) ? undefined : Number(mArith[4]));
      if (v1 !== undefined && v2 !== undefined) {
        let res: number | undefined;
        if (mArith[3] === '+') res = v1 + v2;
        else if (mArith[3] === '-') res = v1 - v2;
        else if (mArith[3] === '*') res = v1 * v2;
        else if (mArith[3] === '/' && v2 !== 0) res = v1 / v2;
        if (res !== undefined) {
          vars.set(mArith[1], res);
        }
      }
    }
  }
  return vars;
}

/** Evaluate an expression string given known variables. */
function evalExpr(expr: string, vars: Map<string, number>): number | null {
  const trimmed = expr.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (vars.has(trimmed)) {
    return vars.get(trimmed)!;
  }
  // Try simple binary arithmetic: e.g. "box_w - 2 * wall" or "knuckle_d / 2"
  const mDiv = /^([A-Za-z0-9_.]+)\s*\/\s*([A-Za-z0-9_.]+)$/.exec(trimmed);
  if (mDiv) {
    const a = evalExpr(mDiv[1], vars);
    const b = evalExpr(mDiv[2], vars);
    if (a !== null && b !== null && b !== 0) return a / b;
  }
  const mSub = /^([A-Za-z0-9_.]+)\s*-\s*([A-Za-z0-9_.]+)$/.exec(trimmed);
  if (mSub) {
    const a = evalExpr(mSub[1], vars);
    const b = evalExpr(mSub[2], vars);
    if (a !== null && b !== null) return a - b;
  }
  return null;
}

/**
 * Extracts candidate body sizes from Box(...) and Cylinder(...) calls in the script.
 * Generous to bodies: an initial Box body size counts even when knuckles/hinges stick out.
 */
function extractBodySizes(
  script: string,
  vars: Map<string, number>
): Array<{ x?: number; y?: number; z?: number; anySize?: number[] }> {
  const bodies: Array<{ x?: number; y?: number; z?: number; anySize?: number[] }> = [];

  // Match Box(argX, argY, argZ, ...)
  const boxRe = /\bBox\s*\(\s*([^,\)]+)\s*,\s*([^,\)]+)\s*,\s*([^,\)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = boxRe.exec(script)) !== null) {
    const x = evalExpr(m[1], vars);
    const y = evalExpr(m[2], vars);
    const z = evalExpr(m[3], vars);
    const anySize: number[] = [];
    if (x !== null) anySize.push(Math.abs(x));
    if (y !== null) anySize.push(Math.abs(y));
    if (z !== null) anySize.push(Math.abs(z));
    bodies.push({
      x: x !== null ? Math.abs(x) : undefined,
      y: y !== null ? Math.abs(y) : undefined,
      z: z !== null ? Math.abs(z) : undefined,
      anySize,
    });
  }

  // Match Cylinder(radius, length, ...)
  const cylRe = /\bCylinder\s*\(\s*([^,\)]+)\s*,\s*([^,\)]+)/g;
  while ((m = cylRe.exec(script)) !== null) {
    const r = evalExpr(m[1], vars);
    const h = evalExpr(m[2], vars);
    const anySize: number[] = [];
    if (r !== null) {
      anySize.push(Math.abs(r));
      anySize.push(Math.abs(r) * 2); // diameter
    }
    if (h !== null) {
      anySize.push(Math.abs(h));
    }
    bodies.push({ anySize });
  }

  return bodies;
}

function matchesStatedDim(
  dim: StatedDim,
  facts: DesignerFacts | null,
  script: string,
  vars: Map<string, number>,
  bodies: Array<{ x?: number; y?: number; z?: number; anySize?: number[] }>
): boolean {
  const target = dim.mm;

  // 1. Check facts.dimensions
  if (facts?.dimensions) {
    for (const d of facts.dimensions) {
      if (isClose(d.value, target)) return true;
    }
  }

  // 2. Check top-level script variables
  for (const [, val] of vars) {
    if (isClose(val, target)) return true;
  }

  // 3. Check facts.parts
  if (facts?.parts && facts.parts.length > 0) {
    let candidateParts = facts.parts;
    if (dim.part) {
      try {
        const re = new RegExp(dim.part, 'i');
        const matched = facts.parts.filter((p) => re.test(p.label));
        if (matched.length > 0) candidateParts = matched;
      } catch {
        // Fall back to all parts if regex is invalid
      }
    }

    const axisIdx = dim.axis === 'x' ? 0 : dim.axis === 'y' ? 1 : dim.axis === 'z' ? 2 : undefined;
    for (const part of candidateParts) {
      if (axisIdx !== undefined) {
        if (isClose(part.size[axisIdx], target)) return true;
      } else {
        if (part.size.some((s) => isClose(s, target))) return true;
      }
    }
  }

  // 4. Check facts.span
  if (facts?.span) {
    const axisIdx = dim.axis === 'x' ? 0 : dim.axis === 'y' ? 1 : dim.axis === 'z' ? 2 : undefined;
    if (axisIdx !== undefined) {
      if (isClose(facts.span[axisIdx], target)) return true;
    } else {
      if (facts.span.some((s) => isClose(s, target))) return true;
    }
  }

  // 5. Check body sizes in script
  for (const body of bodies) {
    if (dim.axis === 'x' && body.x !== undefined && isClose(body.x, target)) return true;
    if (dim.axis === 'y' && body.y !== undefined && isClose(body.y, target)) return true;
    if (dim.axis === 'z' && body.z !== undefined && isClose(body.z, target)) return true;
    if (!dim.axis && body.anySize && body.anySize.some((s) => isClose(s, target))) return true;
  }

  return false;
}

/**
 * Calculates the share of stated dimensions matched within 1 mm or 2%,
 * by a named dimension with the same value OR a part or body size on the axis.
 */
export function statedDimConformance(
  dims: StatedDim[],
  facts: DesignerFacts | null,
  script: string
): number {
  if (!dims || dims.length === 0) return 1.0;

  const vars = extractTopLevelAssignments(script);
  // Also incorporate any dimensions already parsed by tools.ts
  for (const d of parseDimensions(script)) {
    if (!vars.has(d.name)) vars.set(d.name, d.value);
  }
  const bodies = extractBodySizes(script, vars);

  let matched = 0;
  for (const dim of dims) {
    if (matchesStatedDim(dim, facts, script, vars, bodies)) {
      matched++;
    }
  }
  return matched / dims.length;
}

/**
 * Calculates the share of stated dimensions that appear as top-level `name = value` lines.
 */
export function namedDimCoverage(dims: StatedDim[], script: string): number {
  if (!dims || dims.length === 0) return 1.0;

  const vars = extractTopLevelAssignments(script);
  for (const d of parseDimensions(script)) {
    if (!vars.has(d.name)) vars.set(d.name, d.value);
  }

  const values = Array.from(vars.values());
  let matched = 0;
  for (const dim of dims) {
    if (values.some((v) => isClose(v, dim.mm))) {
      matched++;
    }
  }
  return matched / dims.length;
}
