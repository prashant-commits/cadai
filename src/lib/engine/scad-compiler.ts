import { createOpenSCAD } from 'openscad-wasm';

/**
 * Machine-readable identity for the diagnostics we act on programmatically.
 * Lets consumers (spec-audit) gate on a diagnostic class without duplicating
 * the stderr string patterns that produced it.
 */
export type DiagnosticCode =
  | 'parse_error'
  | 'not_3d'
  | 'empty_object'
  | 'unknown_variable'
  | 'unknown_module'
  | 'unknown_function'
  | 'bad_parameter'
  | 'non_manifold';

/** Diagnostics that silently corrupt geometry: OpenSCAD warns, then renders the wrong solid. */
export const SILENT_CORRUPTION_CODES: readonly DiagnosticCode[] = [
  'unknown_variable',
  'unknown_module',
  'unknown_function',
  'bad_parameter',
];

export interface ScadDiagnostic {
  severity: 'error' | 'warning' | 'advisory';
  code?: DiagnosticCode;
  message: string;
  line?: number;
  count: number;
  raw: string;
}

export interface ScadGeometrySummary {
  /** 2 or 3. Absent when OpenSCAD produced no geometry at all. */
  dimensions?: number;
  boundingBox?: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  facets?: number;
  vertices?: number;
  edges?: number;
  volumes?: number; // Nef/CGAL only
  simple?: boolean; // Nef/CGAL only - CGAL's real 2-manifold test
  convex?: boolean; // PolySet only
  triangular?: boolean; // PolySet only
}

export interface ValidationResult {
  valid: boolean;
  stl?: string;
  error?: string; // preserved for back-compat
  exitCode: number;
  errors: ScadDiagnostic[];
  warnings: ScadDiagnostic[];
  summary?: ScadGeometrySummary;
  isManifold?: boolean;
  shellCount?: number;
  compileTimeMs: number;
  rawStderr: string[];
}

/** Classify one stderr line. Order matters: fatal patterns win over warning patterns. */
function classify(line: string): { severity: ScadDiagnostic['severity']; code?: DiagnosticCode } {
  // Noise OpenSCAD emits on every run, plus the indented Nef dump.
  if (
    line.includes('Could not initialize localization') ||
    line.includes('Geometries in cache') ||
    line.includes('Total rendering time') ||
    line.startsWith('  ')
  ) {
    return { severity: 'advisory' };
  }

  if (line.startsWith('ERROR:') || line.includes('parse file')) {
    return { severity: 'error', code: 'parse_error' };
  }
  if (line.includes('not a 3D object')) {
    return { severity: 'error', code: 'not_3d' };
  }
  if (line.includes('top level object is empty')) {
    return { severity: 'error', code: 'empty_object' };
  }

  // Silent corruption: OpenSCAD warns but still renders - the wrong solid.
  // Kept at 'warning' severity because that is what they are to the compiler;
  // spec-audit promotes them to a hard failure via `code`.
  if (line.includes('Ignoring unknown variable')) {
    return { severity: 'warning', code: 'unknown_variable' };
  }
  if (line.includes('Ignoring unknown module')) {
    return { severity: 'warning', code: 'unknown_module' };
  }
  if (line.includes('Ignoring unknown function')) {
    return { severity: 'warning', code: 'unknown_function' };
  }
  if (line.includes('Unable to convert')) {
    return { severity: 'warning', code: 'bad_parameter' };
  }
  if (line.includes('may not be a valid 2-manifold')) {
    return { severity: 'warning', code: 'non_manifold' };
  }
  if (line.startsWith('WARNING:') || line.startsWith('EXPORT-WARNING:')) {
    return { severity: 'warning' };
  }

  return { severity: 'advisory' };
}

/**
 * Normalises OpenSCAD's --summary JSON.
 *
 * The document is {cache, camera, geometry, time}; every field we care about is
 * nested under `geometry`, and the bounding box is snake_case there.
 */
function normaliseSummary(raw: unknown): ScadGeometrySummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const doc = raw as Record<string, any>;
  const g = (doc.geometry ?? doc) as Record<string, any>;
  if (!g || typeof g !== 'object') return undefined;

  const bb = g.bounding_box;
  const hasBox = bb && Array.isArray(bb.min) && Array.isArray(bb.max) && Array.isArray(bb.size);

  return {
    dimensions: typeof g.dimensions === 'number' ? g.dimensions : undefined,
    boundingBox: hasBox
      ? {
          min: [bb.min[0], bb.min[1], bb.min[2]],
          max: [bb.max[0], bb.max[1], bb.max[2]],
          size: [bb.size[0], bb.size[1], bb.size[2]],
        }
      : undefined,
    facets: g.facets,
    vertices: g.vertices,
    edges: g.edges,
    volumes: g.volumes,
    simple: g.simple,
    convex: g.convex,
    triangular: g.triangular,
  };
}

export async function compileScad(
  code: string,
  opts?: { defines?: Record<string, string | number>; strict?: boolean }
): Promise<ValidationResult> {
  const startTime = Date.now();
  const stderr: string[] = [];
  const stdout: string[] = [];

  const instance = await createOpenSCAD({
    print: (text: string) => stdout.push(text),
    printErr: (text: string) => stderr.push(text),
  });

  const mod = await (instance as any).getInstance();
  const FS = mod.FS;
  FS.writeFile('/in.scad', code);

  const args = ['/in.scad', '--summary', 'all', '--summary-file', '/sum.json', '-o', '/out.stl'];

  // Promotes every OpenSCAD warning class to a hard failure. Too blunt for the
  // agent loop (it fails generations that work today); useful for eval runs.
  if (opts?.strict) {
    args.push('--hardwarnings');
  }

  if (opts?.defines) {
    for (const [key, value] of Object.entries(opts.defines)) {
      // OpenSCAD wants string values quoted: -D PART="TENON"
      const valStr = typeof value === 'string' ? `"${value}"` : value.toString();
      args.push('-D', `${key}=${valStr}`);
    }
  }

  // callMain returns a real exit code. It can also throw (Emscripten abort), in
  // which case we still want the diagnostics captured above.
  let exitCode: number;
  let threw: string | undefined;
  try {
    exitCode = mod.callMain(args);
  } catch (e: any) {
    exitCode = typeof e?.status === 'number' ? e.status : 1;
    threw = e?.message ?? String(e);
  }
  const compileTimeMs = Date.now() - startTime;

  let stl: string | undefined;
  if (exitCode === 0) {
    try {
      const stlData = FS.readFile('/out.stl', { encoding: 'utf8' });
      stl = typeof stlData === 'string' ? stlData : new TextDecoder().decode(stlData);
    } catch {
      // No STL written (2D result, or the render bailed out).
    }
  }

  let summary: ScadGeometrySummary | undefined;
  try {
    const summaryData = FS.readFile('/sum.json', { encoding: 'utf8' });
    const sumStr =
      typeof summaryData === 'string' ? summaryData : new TextDecoder().decode(summaryData);
    summary = normaliseSummary(JSON.parse(sumStr));
  } catch {
    // No summary file (compile aborted before geometry evaluation).
  }

  const errors: ScadDiagnostic[] = [];
  const warnings: ScadDiagnostic[] = [];
  const dedupMap = new Map<string, ScadDiagnostic>();

  for (const lineStr of stderr) {
    const { severity, code: diagCode } = classify(lineStr);
    if (severity === 'advisory') continue;

    const lineMatch = lineStr.match(/in file [^ ]+, line (\d+)/);
    const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

    const key = `${severity}:${lineStr}:${lineNum}`;
    const existing = dedupMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      dedupMap.set(key, {
        severity,
        code: diagCode,
        message: lineStr,
        line: lineNum,
        count: 1,
        raw: lineStr,
      });
    }
  }

  for (const diag of dedupMap.values()) {
    if (diag.severity === 'error') errors.push(diag);
    else if (diag.severity === 'warning') warnings.push(diag);
  }

  if (threw && errors.length === 0) {
    errors.push({
      severity: 'error',
      message: `OpenSCAD aborted: ${threw}`,
      count: 1,
      raw: threw,
    });
  }

  const isManifold = summary?.simple;
  const shellCount = summary?.volumes !== undefined ? summary.volumes - 1 : undefined;

  const valid =
    exitCode === 0 &&
    stl !== undefined &&
    stl.trim().length > 0 &&
    stl.includes('facet normal') &&
    errors.length === 0;

  return {
    valid,
    stl,
    error: errors.length > 0 ? errors.map((e) => e.message).join('\n') : undefined,
    exitCode,
    errors,
    warnings,
    summary,
    isManifold,
    shellCount,
    compileTimeMs,
    rawStderr: stderr,
  };
}
