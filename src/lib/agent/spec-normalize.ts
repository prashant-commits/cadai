import type { AssemblySpec } from './assembly-spec';
import { identifierIssue } from '../spec-sheet/blockout-scad';


/** "Wall Mount Backplate" -> "wall_mount_backplate"; always a valid OpenSCAD identifier. */
export function toSnakeCase(name: string): string {
  const s = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  if (!s) return 'part';
  return /^[a-z]/.test(s) ? s : `part_${s}`;
}

/**
 * Makes a parsed spec usable by deterministic code: component names become
 * module identifiers (with every reference renamed to match), every component
 * has a position. Applied to what the Architect returns and to what the client
 * sends back from the spec gate, so downstream code never sees "Cup Receptacle".
 */
export function normalizeSpec(spec: AssemblySpec): AssemblySpec {
  const rename = new Map<string, string>();
  const used = new Set<string>();

  const components = (spec.components ?? []).map((c) => {
    // A name that shadows an OpenSCAD builtin (hull, cube, offset ...) cannot be a
    // module name, so it gets a suffix; every reference follows via `rename`.
    const snake = toSnakeCase(c.name);
    const base = identifierIssue(snake) ? `${snake}_part` : snake;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    rename.set(c.name, name);
    return {
      ...c,
      name,
      position: c.position ?? [0, 0, 0]
    };
  });

  const ref = (x?: string) => (x === undefined ? undefined : rename.get(x) ?? x);
  
  let sheet = spec.sheet;
  if (sheet) {
    const sortedNames = Array.from(rename.keys()).sort((a, b) => b.length - a.length);
    for (const oldName of sortedNames) {
      const newName = rename.get(oldName)!;
      if (oldName === newName) continue;
      const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      sheet = sheet.replace(new RegExp(`\\b${escaped}\\b`, 'g'), newName);
    }
  }

  return {
    ...spec,
    sheet,
    components,
    jointContracts: spec.jointContracts?.map((j) => ({ ...j, partA: ref(j.partA), partB: ref(j.partB) })),
    stressPoints: spec.stressPoints.map((s) => ({ ...s, component: ref(s.component) })),
  };
}
