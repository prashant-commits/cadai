import { renderHoleOp, renderCutRectOp } from './op-hole';
import { renderTextOp } from './op-text';
import { renderTextureOp, textureDensityError } from './op-texture';
import { renderMaterialOp } from './op-material';

export type FontId = 'inter-bold' | 'roboto-mono-bold' | 'oswald-semibold';

export type FacePlane = {
  origin: [number, number, number];
  normal: [number, number, number];
  xDir: [number, number, number];
};

export type OpBase = {
  id: string;
  part: string;
  plane: FacePlane;
  offset: [number, number];
  rotationDeg: number;
};

export type ToolOp =
  | (OpBase & {
      kind: 'text';
      text: string;
      font: FontId;
      sizeMm: number;
      mode: 'engrave' | 'emboss';
      depthMm: number;
      align?: 'left' | 'center' | 'right';
      color?: string;
    })
  | (OpBase & {
      kind: 'texture';
      pattern: 'knurl' | 'hex' | 'ribs' | 'dimples';
      pitchMm: number;
      depthMm: number;
      areaMm: [number, number];
    })
  | (OpBase & {
      kind: 'hole';
      size: 'M3' | 'M4' | 'M5' | 'M6' | 'M8' | 'custom';
      diameterMm: number;
      head: 'none' | 'counterbore' | 'countersink';
      depthMm: number | 'through';
    })
  | (OpBase & {
      kind: 'cut-rect';
      widthMm: number;
      heightMm: number;
      cornerRadiusMm: number;
      depthMm: number | 'through';
    })
  | {
      kind: 'material';
      id: string;
      target: string | 'model';
      material: 'brushed-metal' | 'matte-plastic' | 'wood' | 'color';
      color: string;
    };

export interface ParsedOp {
  op: ToolOp;
  /** 0-based character offset of the start of the `# cadai:op` marker comment line. */
  start: number;
  /** 0-based character offset of the end of the `# cadai:end` comment line (including trailing newline). */
  end: number;
}

export class OpTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpTargetError';
  }
}

export function isValidOpId(id: string): boolean {
  return typeof id === 'string' && id.length <= 40 && /^op_[a-zA-Z0-9_]{6,32}$/.test(id);
}

function isFiniteNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function isPositiveNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0;
}

function isNonNegativeNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function isPythonIdentifier(val: unknown, maxLen = 80): val is string {
  return (
    typeof val === 'string' &&
    val.length >= 1 &&
    val.length <= maxLen &&
    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)
  );
}

function isFacePlane(val: unknown): val is FacePlane {
  if (!val || typeof val !== 'object') return false;
  const p = val as Record<string, unknown>;
  if (!Array.isArray(p.origin) || p.origin.length !== 3 || !p.origin.every(isFiniteNumber)) {
    return false;
  }
  if (!Array.isArray(p.normal) || p.normal.length !== 3 || !p.normal.every(isFiniteNumber)) {
    return false;
  }
  const normLenSq = (p.normal[0] as number) ** 2 + (p.normal[1] as number) ** 2 + (p.normal[2] as number) ** 2;
  if (normLenSq === 0) return false;

  if (!Array.isArray(p.xDir) || p.xDir.length !== 3 || !p.xDir.every(isFiniteNumber)) {
    return false;
  }
  const xDirLenSq = (p.xDir[0] as number) ** 2 + (p.xDir[1] as number) ** 2 + (p.xDir[2] as number) ** 2;
  if (xDirLenSq === 0) return false;

  return true;
}

export function validateToolOp(op: unknown): op is ToolOp {
  if (!op || typeof op !== 'object') return false;
  const o = op as Record<string, unknown>;

  if (!isValidOpId(String(o.id))) {
    return false;
  }

  const kind = o.kind;
  if (typeof kind !== 'string') return false;

  if (kind === 'material') {
    const validMaterials = ['brushed-metal', 'matte-plastic', 'wood', 'color'];
    if (!validMaterials.includes(String(o.material))) return false;
    if (o.target !== 'model' && !isPythonIdentifier(o.target, 80)) {
      return false;
    }
    if (typeof o.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(o.color)) {
      return false;
    }
    return true;
  }

  // All other kinds extend OpBase:
  if (!isPythonIdentifier(o.part, 80)) return false;
  if (!isFacePlane(o.plane)) return false;
  if (!Array.isArray(o.offset) || o.offset.length !== 2 || !o.offset.every(isFiniteNumber)) {
    return false;
  }
  if (!isFiniteNumber(o.rotationDeg)) return false;

  switch (kind) {
    case 'hole': {
      const validSizes = ['M3', 'M4', 'M5', 'M6', 'M8', 'custom'];
      if (!validSizes.includes(String(o.size))) return false;
      const validHeads = ['none', 'counterbore', 'countersink'];
      if (!validHeads.includes(String(o.head))) return false;
      if (!isPositiveNumber(o.diameterMm)) return false;
      if (o.depthMm !== 'through' && !isPositiveNumber(o.depthMm)) return false;
      return true;
    }
    case 'cut-rect': {
      if (!isPositiveNumber(o.widthMm) || !isPositiveNumber(o.heightMm)) return false;
      if (!isNonNegativeNumber(o.cornerRadiusMm)) return false;
      if (o.depthMm !== 'through' && !isPositiveNumber(o.depthMm)) return false;
      return true;
    }
    case 'text': {
      if (typeof o.text !== 'string' || o.text.length < 1 || o.text.length > 64) {
        return false;
      }
      if (/[\u0000-\u001f\u007f-\u009f]/.test(o.text)) return false;
      const validFonts = ['inter-bold', 'roboto-mono-bold', 'oswald-semibold'];
      if (!validFonts.includes(String(o.font))) return false;
      const validModes = ['engrave', 'emboss'];
      if (!validModes.includes(String(o.mode))) return false;
      if (!isPositiveNumber(o.sizeMm) || !isPositiveNumber(o.depthMm)) return false;
      if (o.align !== undefined && !['left', 'center', 'right'].includes(String(o.align))) {
        return false;
      }
      if (o.color !== undefined && (typeof o.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(o.color))) {
        return false;
      }
      return true;
    }
    case 'texture': {
      const validPatterns = ['knurl', 'hex', 'ribs', 'dimples'];
      if (!validPatterns.includes(String(o.pattern))) return false;
      if (!isPositiveNumber(o.pitchMm) || !isPositiveNumber(o.depthMm)) return false;
      if (!Array.isArray(o.areaMm) || o.areaMm.length !== 2 || !o.areaMm.every(isPositiveNumber)) {
        return false;
      }
      if (
        textureDensityError({
          pattern: o.pattern as 'knurl' | 'hex' | 'ribs' | 'dimples',
          pitchMm: o.pitchMm as number,
          areaMm: o.areaMm as [number, number],
        }) !== null
      ) {
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}

export function renderOpBlock(op: ToolOp): string {
  if (!validateToolOp(op)) {
    throw new Error(`Invalid op: ${JSON.stringify(op)}`);
  }

  switch (op.kind) {
    case 'hole':
      return renderHoleOp(op);
    case 'cut-rect':
      return renderCutRectOp(op);
    case 'text':
      return renderTextOp(op);
    case 'texture':
      return renderTextureOp(op);
    case 'material':
      return renderMaterialOp(op);
  }
}

export function parseCadaiParts(body: string): string[] {
  const match = body.match(/_cadai_parts\s*=\s*\[([^\]]*)\]/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s));
}

function findStatementEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTripleSingle = false;
  let inTripleDouble = false;

  for (let idx = startIdx; idx < lines.length; idx++) {
    const line = lines[idx];
    let j = 0;
    while (j < line.length) {
      if (!inSingleQuote && !inDoubleQuote) {
        if (!inTripleSingle && line.startsWith('"""', j)) {
          inTripleDouble = !inTripleDouble;
          j += 3;
          continue;
        }
        if (!inTripleDouble && line.startsWith("'''", j)) {
          inTripleSingle = !inTripleSingle;
          j += 3;
          continue;
        }
      }
      if (inTripleDouble || inTripleSingle) {
        j++;
        continue;
      }
      const ch = line[j];
      if (ch === '\\' && (inSingleQuote || inDoubleQuote)) {
        j += 2;
        continue;
      }
      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        j++;
        continue;
      }
      if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        j++;
        continue;
      }
      if (inSingleQuote || inDoubleQuote) {
        j++;
        continue;
      }
      if (ch === '#') {
        break;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
      }
      j++;
    }

    const trimmed = line.trimEnd();
    const hasBackslash = trimmed.endsWith('\\');
    if (depth <= 0 && !hasBackslash && !inSingleQuote && !inDoubleQuote && !inTripleSingle && !inTripleDouble) {
      return idx;
    }
  }
  return startIdx;
}

export function applyOp(body: string, op: ToolOp): string {
  const parts = parseCadaiParts(body);
  const target = op.kind === 'material' ? op.target : op.part;

  if (target !== 'model' && !parts.includes(target)) {
    throw new OpTargetError(`Part "${target}" not found in _cadai_parts: [${parts.join(', ')}]`);
  }

  const partsMatch = body.match(/^([ \t]*_cadai_parts\s*=.*)$/m);
  if (!partsMatch || partsMatch.index === undefined) {
    throw new OpTargetError('Could not find _cadai_parts line in design body');
  }
  const partsLineIndex = partsMatch.index;

  const renderedBlock = renderOpBlock(op);

  if (target === 'model') {
    const before = body.slice(0, partsLineIndex);
    const after = body.slice(partsLineIndex);
    const prefix = before.endsWith('\n') ? '' : '\n';
    return `${before}${prefix}${renderedBlock}\n${after}`;
  }

  const beforeParts = body.slice(0, partsLineIndex);
  const lines = beforeParts.split('\n');

  // Track op blocks per line so we know if an assignment is inside an op block
  const blockAtLine: Array<string | null> = new Array(lines.length).fill(null);
  let currentBlockId: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const opStartMatch = lines[i].match(/^[ \t]*# cadai:op\s+[a-z-]+\s+id=([a-zA-Z0-9_]+)/);
    if (opStartMatch) {
      currentBlockId = opStartMatch[1];
    }
    blockAtLine[i] = currentBlockId;
    const opEndMatch = lines[i].match(/^[ \t]*# cadai:end\s+([a-zA-Z0-9_]+)/);
    if (opEndMatch && opEndMatch[1] === currentBlockId) {
      currentBlockId = null;
    }
  }

  let lastAssignStartIdx = -1;
  let lastAssignEndIdx = -1;
  let lastAssignBlockId: string | null = null;

  const assignRegex = new RegExp(`^[ \\t]*${target}(\\.[a-zA-Z_][a-zA-Z0-9_]*)?\\s*(=|\\+=|-=)`);

  for (let i = 0; i < lines.length; i++) {
    if (assignRegex.test(lines[i])) {
      lastAssignStartIdx = i;
      lastAssignEndIdx = findStatementEnd(lines, i);
      lastAssignBlockId = blockAtLine[i];
    }
  }

  if (lastAssignStartIdx === -1) {
    const before = beforeParts.endsWith('\n') ? beforeParts : `${beforeParts}\n`;
    return `${before}${renderedBlock}\n${body.slice(partsLineIndex)}`;
  }

  let insertLineIdx = lastAssignEndIdx;
  if (lastAssignBlockId !== null) {
    for (let i = lastAssignStartIdx; i < lines.length; i++) {
      const endMatch = lines[i].match(/^[ \t]*# cadai:end\s+([a-zA-Z0-9_]+)/);
      if (endMatch && endMatch[1] === lastAssignBlockId) {
        insertLineIdx = i;
        break;
      }
    }
  }

  const beforeLines = lines.slice(0, insertLineIdx + 1);
  const afterLines = lines.slice(insertLineIdx + 1);

  const newBefore = beforeLines.join('\n');
  const newAfter = afterLines.join('\n') + body.slice(partsLineIndex);

  return `${newBefore}\n${renderedBlock}\n${newAfter}`;
}

export function parseOpBlocks(body: string): ParsedOp[] {
  const results: ParsedOp[] = [];
  const opStartRegex = /^[ \t]*# cadai:op\s+([a-z-]+)\s+id=([a-zA-Z0-9_]+)\s+(\{.*\})\s*$/gm;

  let match: RegExpExecArray | null;
  while ((match = opStartRegex.exec(body)) !== null) {
    const markerKind = match[1];
    const markerId = match[2];
    const rawJson = match[3];
    const blockStart = match.index;

    let opData: ToolOp;
    try {
      opData = JSON.parse(rawJson) as ToolOp;
    } catch {
      continue;
    }

    if (opData.kind !== markerKind) {
      continue;
    }

    opData.id = markerId;

    // Look for `# cadai:end <id>`
    const endMarker = `# cadai:end ${markerId}`;
    const endIdx = body.indexOf(endMarker, match.index);
    if (endIdx === -1) {
      continue;
    }

    const endLineEnd = body.indexOf('\n', endIdx);
    const blockEnd = endLineEnd === -1 ? body.length : endLineEnd + 1;

    const blockText = body.slice(blockStart, blockEnd);
    const blockLines = blockText.split('\n');

    // Parse parameter lines: `<id>_<name> = <value>  # <label>`
    const paramRegex = new RegExp(`^[ \\t]*${markerId}_([a-zA-Z0-9_]+)\\s*=\\s*([-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)(?:\\s*#\\s*(.*))?$`);

    const params: Record<string, { value: number; label?: string }> = {};
    for (const line of blockLines) {
      const pm = line.match(paramRegex);
      if (pm) {
        params[pm[1]] = {
          value: parseFloat(pm[2]),
          label: pm[3]?.trim(),
        };
      }
    }

    // Apply parameters over opData (parameters win, ignore overshoot)
    if (opData.kind !== 'material') {
      const base = opData as Extract<ToolOp, { plane: FacePlane }>;
      if (params['plane_orig_x'] !== undefined) base.plane.origin[0] = params['plane_orig_x'].value;
      if (params['plane_orig_y'] !== undefined) base.plane.origin[1] = params['plane_orig_y'].value;
      if (params['plane_orig_z'] !== undefined) base.plane.origin[2] = params['plane_orig_z'].value;
      if (params['plane_norm_x'] !== undefined) base.plane.normal[0] = params['plane_norm_x'].value;
      if (params['plane_norm_y'] !== undefined) base.plane.normal[1] = params['plane_norm_y'].value;
      if (params['plane_norm_z'] !== undefined) base.plane.normal[2] = params['plane_norm_z'].value;
      if (params['plane_xdir_x'] !== undefined) base.plane.xDir[0] = params['plane_xdir_x'].value;
      if (params['plane_xdir_y'] !== undefined) base.plane.xDir[1] = params['plane_xdir_y'].value;
      if (params['plane_xdir_z'] !== undefined) base.plane.xDir[2] = params['plane_xdir_z'].value;

      if (params['offset_x'] !== undefined) base.offset[0] = params['offset_x'].value;
      if (params['offset_y'] !== undefined) base.offset[1] = params['offset_y'].value;
      if (params['rotation'] !== undefined) base.rotationDeg = params['rotation'].value;

      if (opData.kind === 'hole') {
        if (params['diameter'] !== undefined) opData.diameterMm = params['diameter'].value;
        if (params['depth'] !== undefined) {
          const depthParam = params['depth'];
          if (depthParam.label && depthParam.label.includes('(through)')) {
            opData.depthMm = 'through';
          } else {
            opData.depthMm = depthParam.value;
          }
        }
      } else if (opData.kind === 'cut-rect') {
        if (params['width'] !== undefined) opData.widthMm = params['width'].value;
        if (params['height'] !== undefined) opData.heightMm = params['height'].value;
        if (params['corner_radius'] !== undefined) opData.cornerRadiusMm = params['corner_radius'].value;
        if (params['depth'] !== undefined) {
          const depthParam = params['depth'];
          if (depthParam.label && depthParam.label.includes('(through)')) {
            opData.depthMm = 'through';
          } else {
            opData.depthMm = depthParam.value;
          }
        }
      } else if (opData.kind === 'text') {
        if (params['size'] !== undefined) opData.sizeMm = params['size'].value;
        if (params['depth'] !== undefined) opData.depthMm = params['depth'].value;
        const halignRegex = new RegExp(`^[ \\t]*${markerId}_halign\\s*=\\s*TextAlign\\.(LEFT|CENTER|RIGHT)`);
        for (const line of blockLines) {
          const hm = line.match(halignRegex);
          if (hm) {
            opData.align = hm[1].toLowerCase() as 'left' | 'center' | 'right';
            break;
          }
        }
      } else if (opData.kind === 'texture') {
        if (params['pitch'] !== undefined) opData.pitchMm = params['pitch'].value;
        if (params['depth'] !== undefined) opData.depthMm = params['depth'].value;
        if (params['area_w'] !== undefined) opData.areaMm[0] = params['area_w'].value;
        if (params['area_h'] !== undefined) opData.areaMm[1] = params['area_h'].value;
      }
    }

    if (!validateToolOp(opData)) {
      continue;
    }

    results.push({
      op: opData,
      start: blockStart,
      end: blockEnd,
    });
  }

  return results;
}
