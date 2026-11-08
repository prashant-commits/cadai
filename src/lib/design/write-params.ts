import { parseParams } from './parse-params';
import { ParamValue } from '../../types';

export function setParamValue(code: string, name: string, value: ParamValue): string {
  const params = parseParams(code);
  const param = params.find(p => p.name === name);
  if (!param) return code;

  const lines = code.split('\n');
  const lineIdx = param.line - 1;
  const originalLine = lines[lineIdx];

  const match = originalLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*\s*=\s*)-?\d+(?:\.\d+)?(.*)$/);
  if (match) {
    lines[lineIdx] = `${match[1]}${value}${match[2]}`;
  }
  return lines.join('\n');
}
