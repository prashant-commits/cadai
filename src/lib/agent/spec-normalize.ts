import type { AssemblySpec } from './assembly-spec';
import { ENGINEERING_MODULE_REGISTRY } from './engineering-tools';

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
 * has a position, and useModules only names registry keys that exist. Applied
 * to what the Architect returns and to what the client sends back from the
 * spec gate, so downstream code never sees "Cup Receptacle".
 */
export function normalizeSpec(spec: AssemblySpec): AssemblySpec {
  const rename = new Map<string, string>();
  const used = new Set<string>();

  const components = (spec.components ?? []).map((c) => {
    const base = toSnakeCase(c.name);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    rename.set(c.name, name);
    return {
      ...c,
      name,
      position: c.position ?? [0, 0, 0],
      useModules: c.useModules?.filter((k) => k in ENGINEERING_MODULE_REGISTRY),
    };
  });

  const ref = (x?: string) => (x === undefined ? undefined : rename.get(x) ?? x);

  return {
    ...spec,
    components,
    jointContracts: spec.jointContracts?.map((j) => ({ ...j, partA: ref(j.partA), partB: ref(j.partB) })),
    edgeTreatments: spec.edgeTreatments.map((e) => ({ ...e, component: ref(e.component) })),
    stressPoints: spec.stressPoints.map((s) => ({ ...s, component: ref(s.component) })),
  };
}
