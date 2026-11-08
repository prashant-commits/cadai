import { ScadParam, ParamKind } from '../../types';

export function parseParams(code: string): ScadParam[] {
  const lines = code.split(/\r?\n/);
  const params: ScadParam[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const originalLineNum = i + 1;

    // Must be top-level (column 0) numeric assignment:
    // name = <number>  # [min:step:max] description
    // or with optional ; and # or // comment
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*(?:;)?\s*(?:(?:#|\/\/)(.*))?$/);
    if (!match) continue;

    const name = match[1];
    const value = Number(match[2]);
    const authoredValue = value;
    const rawComment = match[3];

    let kind: ParamKind = 'number';
    let label: string | undefined;
    let min: number | undefined;
    let max: number | undefined;
    let step: number | undefined;

    if (rawComment !== undefined) {
      const commentPart = rawComment.trim();
      if (commentPart.startsWith('[')) {
        const endBracket = commentPart.indexOf(']');
        if (endBracket !== -1) {
          const annotation = commentPart.slice(1, endBracket).trim();
          const afterAnnotation = commentPart.slice(endBracket + 1).trim();
          if (afterAnnotation) {
            label = afterAnnotation;
          }

          const parts = annotation.split(':').map(p => p.trim());
          if (parts.length === 2) {
            const p0 = Number(parts[0]);
            const p1 = Number(parts[1]);
            if (!isNaN(p0) && !isNaN(p1)) {
              min = p0;
              max = p1;
              step = (parts[0].includes('.') || parts[1].includes('.')) ? 0.1 : 1;
              kind = 'range';
            }
          } else if (parts.length === 3) {
            const p0 = Number(parts[0]);
            const p1 = Number(parts[1]);
            const p2 = Number(parts[2]);
            if (!isNaN(p0) && !isNaN(p1) && !isNaN(p2)) {
              min = p0;
              step = p1;
              max = p2;
              kind = 'range';
            }
          }
        }
      } else if (commentPart) {
        label = commentPart;
      }
    }

    const param: ScadParam = {
      name,
      kind,
      value,
      authoredValue,
      group: 'Parameters',
      line: originalLineNum,
    };
    if (label) param.label = label;
    if (min !== undefined) param.min = min;
    if (max !== undefined) param.max = max;
    if (step !== undefined) param.step = step;

    const existingIdx = params.findIndex(p => p.name === name);
    if (existingIdx !== -1) {
      params[existingIdx] = param;
    } else {
      params.push(param);
    }
  }

  return params;
}
