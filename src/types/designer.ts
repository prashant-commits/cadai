export type ParamKind = 'number' | 'range' | 'enum' | 'boolean';
export type ParamValue = number | boolean | string;

export interface ScadParam {
  name: string; kind: ParamKind;
  value: ParamValue; authoredValue: ParamValue;
  label?: string; group: string;
  min?: number; max?: number; step?: number;
  options?: Array<{ value: number | string; label: string }>;
  line: number;                       // 1-indexed, for "reveal in code"
}

/**
 * Hard geometric bounds on what may be generated.
 *
 * These are modelling constraints, not fabrication settings. Nozzle diameter,
 * layer height, material and a support-free overhang limit used to live here
 * and fed straight into generation prompts, where they
 * pulled the models into 3D-printing reasoning nobody had asked for: they
 * would size walls from a nozzle, re-orient parts to dodge an overhang, and
 * otherwise alter the requested geometry to satisfy a process this pipeline
 * does not model. Printability is a separate, opt-in analysis over a finished
 * model; analyzeStl still measures overhang for it. It is not an input to
 * generation.
 *
 * `minWallMm` survives because a minimum wall is a geometric floor the user
 * can state directly, and it is audited against every parameter named *wall*.
 */
export interface StandingConstraints {
  /** Overall size the assembly must fit inside, [x, y, z] mm. */
  maxSizeMm?: [number, number, number];
  /** Thinnest wall allowed anywhere, mm. Stated outright, derived from nothing. */
  minWallMm?: number;
}

export interface PinnedParam {
  value: ParamValue;
  supersededValue: ParamValue;        // revert target
  pinnedAt: number;
}

export interface DesignContract {
  standing: StandingConstraints;
  pinnedParams: Record<string, PinnedParam>;
}

export interface ContractDiff {
  applied: Array<{ name: string; pinned: ParamValue; aiValue: ParamValue }>;
  dropped: string[];                  // pinned, but the param no longer exists
  unchanged: string[];                // AI already matched the pin
  rejected: Array<{ name: string; value: ParamValue; reason: string }>;  // violates standing bounds
}

export interface ModelDimensions {
  x: number; // width in mm
  y: number; // depth in mm
  z: number; // height in mm
}

export interface ModelInfo {
  dimensions: ModelDimensions;
  volumeMm3: number;
  triangleCount: number;
  vertexCount: number;
  isWatertight: boolean;
  isFlatPackable: boolean;
  boundingBox: {
    min: [number, number, number];
    max: [number, number, number];
  };
  isManifold?: boolean;
  shellCount?: number;
  bottomAreaMm2?: number;
  surfaceAreaMm2?: number;
  centerOfMass?: [number, number, number];
  massGrams?: { pla: number; petg: number };
  overhang?: { unsupportedAreaMm2: number; maxOverhangDeg: number };
  compileTimeMs?: number;
}

export interface SpecViolation {
  kind:
    | 'compile'
    | 'bbox'
    | 'manifold'
    | 'shells'
    /** One component's own module is more than one solid piece: a cut runs through that part. */
    | 'severed'
    /** One component is a single solid that encloses an empty void. */
    | 'sealed_cavity'
    | 'empty'
    | 'dimensionality'
    | 'buildplate'
    | 'interference'
    | 'clearance'
    | 'unknown_symbol'
    | 'standing'
    /** Whole-model min z is not 0: something hangs below or hovers above the floor. */
    | 'floor'
    /** A placed component does not rest on the floor or on any other component. */
    | 'floating'
    /** A module's min corner is not at its local origin (informational once corrected). */
    | 'local_frame'
    /** The build replaced or dropped something the model wrote (B-rep emitter notes). Always a warning. */
    | 'build'
    /** A module's measured size disagrees with the spec's localExtents. */
    | 'extents'
    /** The spec contradicts itself: declared envelope vs the one its placements imply. */
    | 'coherence'
    /** A component module is mirrored as a whole, so the part is the wrong hand. */
    | 'handedness'
    /** A hole the spec declared is missing, displaced or the wrong size. */
    | 'feature'
    /** A shape schema constraint was violated (e.g. tube without innerD). */
    | 'shape'
    /** Emitted by the Design Inspector from rendered views. Always a warning. */
    | 'visual'
    /** Parameter leaves bbox and volume unchanged when swept. Always a warning. */
    | 'dead_parameter'
    /** Parameter variant fails compile, non-manifold, or goes below z = 0. Always a warning. */
    | 'sweep_failure'
    /** Numeric literal in module body equals a parameter value. Always a warning. */
    | 'literal_param';
  field: string;
  expected: number | string | boolean;
  measured: number | string | boolean;
  deltaMm?: number;
  tolerance?: number;
  severity: 'error' | 'warning';
  message: string;
}
