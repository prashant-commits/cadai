import { parseParams } from './parse-params';
import { ParamValue } from '../../types';

export function setParamValue(code: string, name: string, value: ParamValue): string {
  const params = parseParams(code);
  const param = params.find(p => p.name === name);
  if (!param) return code;

  const lines = code.split('\n');
  const lineIdx = param.line - 1;
  const originalLine = lines[lineIdx];

  let formattedValue = String(value);
  if (typeof value === 'boolean') {
    formattedValue = value ? 'true' : 'false';
  } else if (typeof value === 'string') {
    formattedValue = `"${value}"`;
  }

  let inString = false;
  let commentIndex = -1;
  for (let j = 0; j < originalLine.length; j++) {
    if (originalLine[j] === '"' && (j === 0 || originalLine[j-1] !== '\\')) {
      inString = !inString;
    }
    if (!inString && originalLine[j] === '/' && originalLine[j+1] === '/') {
      commentIndex = j;
      break;
    }
  }

  const codePart = commentIndex === -1 ? originalLine : originalLine.slice(0, commentIndex);
  const commentPart = commentIndex === -1 ? '' : originalLine.slice(commentIndex);

  const eqIdx = codePart.indexOf('=');
  const semiIdx = codePart.indexOf(';', eqIdx);
  
  if (eqIdx !== -1 && semiIdx !== -1 && eqIdx < semiIdx) {
    const beforeEq = codePart.slice(0, eqIdx);
    const afterSemi = codePart.slice(semiIdx);
    // If beforeEq ends with space, we keep it, otherwise we don't need to add one, but it looks nicer.
    // However, to preserve bytes as much as possible, if original had spaces, we use them.
    // Actually, simply reproducing the format `beforeEq + '= ' + formattedValue + afterSemi` is good.
    // But let's look at `width = 40;`. beforeEq is `width `. So `width = 55;`. Perfect.
    // Let's use `beforeEq + '=' + (codePart[eqIdx + 1] === ' ' ? ' ' : '') + formattedValue + afterSemi`?
    // Let's just do `beforeEq + '=' + (codePart[eqIdx + 1] === ' ' ? ' ' : ' ') + formattedValue + afterSemi` - actually, always add space if none exists?
    // Let's stick to:
    const spaceAfterEq = codePart[eqIdx + 1] === ' ' ? ' ' : '';
    lines[lineIdx] = beforeEq + '=' + (spaceAfterEq || ' ') + formattedValue + afterSemi + commentPart;
  }

  return lines.join('\n');
}
