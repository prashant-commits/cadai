import { BAD_PIN } from '@/lib/persist/phrases';
import { parseParams } from './parse-params';
import { ParamValue } from '../../types';

export class BadPinError extends Error {
  constructor() {
    super(BAD_PIN);
    this.name = 'BadPinError';
  }
}

export function formatPin(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) > 1e6) {
    throw new BadPinError();
  }
  let s = v.toFixed(6);
  if (s.includes('.')) {
    s = s.replace(/\.?0+$/, '');
  }
  if (s === '-0' || s === '') {
    s = '0';
  }
  return s;
}

export function setParamValue(code: string, name: string, value: ParamValue): string {
  const params = parseParams(code);
  const param = params.find((p) => p.name === name);
  if (!param) return code;

  const lines = code.split('\n');
  const lineIdx = param.line - 1;
  const originalLine = lines[lineIdx];

  const match = originalLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*\s*=\s*)-?\d+(?:\.\d+)?(.*)$/);
  if (match) {
    const formatted = typeof value === 'number' ? formatPin(value) : String(value);
    lines[lineIdx] = `${match[1]}${formatted}${match[2]}`;
  }
  return lines.join('\n');
}

export function applyPin(body: string, name: string, value: number): string {
  const formatted = formatPin(value);
  const params = parseParams(body);
  const param = params.find((p) => p.name === name);
  if (!param) {
    throw new BadPinError();
  }

  const lines = body.split('\n');
  const lineIdx = param.line - 1;
  const originalLine = lines[lineIdx];

  const match = originalLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*\s*=\s*)-?\d+(?:\.\d+)?(.*)$/);
  if (!match) {
    throw new BadPinError();
  }

  lines[lineIdx] = `${match[1]}${formatted}${match[2]}`;
  return lines.join('\n');
}

export function applyPins(body: string, pins: Record<string, number>): string {
  let result = body;
  const keys = Object.keys(pins).sort();
  for (const key of keys) {
    result = applyPin(result, key, pins[key]);
  }
  return result;
}
