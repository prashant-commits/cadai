import { ScadParam, ParamKind, ParamValue } from '../../types';

export function parseParams(code: string): ScadParam[] {
  const lines = code.split(/\r?\n/);
  const params: ScadParam[] = [];
  
  let braceDepth = 0;
  let currentGroup = '';
  let isHidden = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const originalLineNum = i + 1;

    let inString = false;
    let commentIndex = -1;
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '"' && (j === 0 || line[j-1] !== '\\')) {
        inString = !inString;
      }
      if (!inString && line[j] === '/' && line[j+1] === '/') {
        commentIndex = j;
        break;
      }
    }

    const codePart = commentIndex === -1 ? line : line.slice(0, commentIndex);
    const commentPart = commentIndex === -1 ? '' : line.slice(commentIndex + 2).trim();

    // Track block comments for groups
    const groupMatch = line.match(/^\s*\/\*\s*\[(.*?)\]\s*\*\//);
    if (groupMatch) {
      const groupName = groupMatch[1].trim();
      if (groupName === 'Hidden') {
        isHidden = true;
      } else {
        currentGroup = groupName;
        isHidden = false;
      }
      continue;
    }

    // Track brace depth on codePart, ignoring contents of strings
    inString = false;
    let currentDepth = braceDepth;
    for (let j = 0; j < codePart.length; j++) {
      if (codePart[j] === '"' && (j === 0 || codePart[j-1] !== '\\')) {
        inString = !inString;
      }
      if (!inString) {
        if (codePart[j] === '{') braceDepth++;
        if (codePart[j] === '}') braceDepth--;
      }
    }

    // If we started this line inside a module body, skip parameter parsing for it.
    if (currentDepth > 0) continue;
    if (isHidden) continue;

    const assignmentMatch = codePart.match(/^\s*([a-zA-Z0-9_$]+)\s*=\s*(.+?)\s*;\s*$/);
    if (!assignmentMatch) continue;

    const name = assignmentMatch[1];
    let rawValue = assignmentMatch[2].trim();

    let value: ParamValue;
    let kind: ParamKind | null = null;
    let isQuotedString = false;
    
    if (rawValue === 'true') {
      value = true;
      kind = 'boolean';
    } else if (rawValue === 'false') {
      value = false;
      kind = 'boolean';
    } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      value = Number(rawValue);
    } else if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      value = rawValue.slice(1, -1);
      isQuotedString = true;
    } else {
      continue;
    }

    let label = undefined;
    let min: number | undefined;
    let max: number | undefined;
    let step: number | undefined;
    let options: Array<{ value: number | string; label: string }> | undefined;
    
    if (commentPart.startsWith('[')) {
      const endBracket = commentPart.indexOf(']');
      if (endBracket !== -1) {
        const annotation = commentPart.slice(1, endBracket).trim();
        const afterAnnotation = commentPart.slice(endBracket + 1).trim();
        if (afterAnnotation) {
          label = afterAnnotation;
        }

        const isRange = /^((?:-?\d+(?:\.\d+)?)\s*:\s*(?:(?:-?\d+(?:\.\d+)?)\s*:\s*)?(?:-?\d+(?:\.\d+)?))$/.test(annotation);
        
        if (isRange) {
           const parts = annotation.split(':').map(p => p.trim());
           kind = 'range';
           if (parts.length === 2) {
             min = Number(parts[0]);
             max = Number(parts[1]);
             step = (parts[0].includes('.') || parts[1].includes('.')) ? 0.1 : 1;
           } else {
             min = Number(parts[0]);
             step = Number(parts[1]);
             max = Number(parts[2]);
           }
        } else if (annotation.includes(',') || annotation.includes(':')) {
           kind = 'enum';
           options = [];
           const items = annotation.split(',').map(s => s.trim());
           for (const item of items) {
             const parts = item.split(':').map(p => p.trim());
             let optVal: string | number = parts[0];
             let optLabel = parts.length > 1 ? parts.slice(1).join(':') : parts[0];
             
             if (/^-?\d+(\.\d+)?$/.test(optVal)) {
               optVal = Number(optVal);
             } else if (optVal.startsWith('"') && optVal.endsWith('"')) {
               optVal = optVal.slice(1, -1);
             }
             
             if (typeof optLabel === 'string' && optLabel.startsWith('"') && optLabel.endsWith('"')) {
               optLabel = optLabel.slice(1, -1);
             }
             
             options.push({ value: optVal, label: optLabel });
           }
        }
      }
    }

    if (!label && commentPart && !commentPart.startsWith('[')) {
      label = commentPart;
    }

    if (!kind) {
      if (typeof value === 'boolean') kind = 'boolean';
      else if (typeof value === 'number') kind = 'number';
      else continue;
    }

    let group = currentGroup;
    if (name.startsWith('$')) {
      group = 'Advanced';
    } else if (!group) {
      group = 'Parameters';
    }

    const param: ScadParam = {
      name,
      kind,
      value,
      authoredValue: value,
      group,
      line: originalLineNum
    };
    if (label) param.label = label;
    if (min !== undefined) param.min = min;
    if (max !== undefined) param.max = max;
    if (step !== undefined) param.step = step;
    if (options) param.options = options;

    const existingIdx = params.findIndex(p => p.name === name);
    if (existingIdx !== -1) {
      params[existingIdx] = param;
    } else {
      params.push(param);
    }
  }

  return params;
}
