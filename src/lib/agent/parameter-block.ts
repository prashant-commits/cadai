import type { AssemblySpec } from './assembly-spec';

/**
 * OpenSCAD Customizer assignments for the spec's parameters, then one
 * assignment per derived value. Empty when the spec declares neither.
 * Every line, including the last, ends with a newline.
 */
export function parameterBlock(spec: AssemblySpec): string {
  const lines: string[] = [];
  for (const p of spec.parameters ?? []) {
    const range = p.step === undefined
      ? `[${fmtParam(p.min)}:${fmtParam(p.max)}]`
      : `[${fmtParam(p.min)}:${fmtParam(p.step)}:${fmtParam(p.max)}]`;
    lines.push(`${p.name} = ${fmtParam(p.value)}; // ${range} ${p.description}`);
  }
  for (const d of spec.derived ?? []) {
    lines.push(`${d.name} = ${d.expr};`);
  }
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

function fmtParam(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1e6) / 1e6;
  return String(rounded);
}
