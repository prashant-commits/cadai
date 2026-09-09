import * as THREE from 'three';
import { AssemblySpec } from '../lib/agent/assembly-spec';
import { SpecViolation } from '../lib/agent/spec-audit';

export type AgentStepType = 'thinking' | 'generating' | 'validating' | 'fixing' | 'ready' | 'error' | 'awaiting_input';

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

export interface StandingConstraints {          // hard physical bounds
  buildVolumeMm?: [number, number, number];
  nozzleMm?: number; layerHeightMm?: number;
  material?: 'PLA' | 'PETG' | 'ABS' | 'ASA';
  minWallMm?: number;                 // defaults to nozzleMm * 4
  /**
   * Steepest overhang printable without support, measured from vertical.
   * 45 is the conventional FDM figure. Opt-in: analyzeStl always measures the
   * overhang, but it is only asserted once you declare a limit - otherwise
   * every model with a shallow chamfer would open the accept gate.
   */
  maxOverhangDeg?: number;
}

export interface PinnedParam {
  value: ParamValue;
  supersededValue: ParamValue;        // revert target
  pinnedAt: number;
}

export interface DesignContract {
  standing: StandingConstraints;
  spec?: AssemblySpec;                // approved intent
  specApprovedAt?: number;
  pinnedParams: Record<string, PinnedParam>;
}

export interface ContractDiff {
  applied: Array<{ name: string; pinned: ParamValue; aiValue: ParamValue }>;
  dropped: string[];                  // pinned, but the param no longer exists
  unchanged: string[];                // AI already matched the pin
  rejected: Array<{ name: string; value: ParamValue; reason: string }>;  // violates standing bounds
}

// The data a paused graph run sends the client to render a HIL gate.
export type GatePayload =
  | {
      kind: 'spec';
      spec: AssemblySpec | null;
      contract: DesignContract | null;
      revisionCount: number;
    }
  | {
      kind: 'accept';
      modelInfo: ModelInfo | null;
      violations: SpecViolation[];
      code: string;
      stl?: string;
      revisionCount: number;
    };

// What the client sends back to resume a paused graph run.
export interface GateDecision {
  action: 'approve' | 'revise' | 'cancel';
  spec?: AssemblySpec;   // edited spec, spec-gate approve only
  comment?: string;      // revise feedback, or an optional approve note
  /**
   * Answers to the spec's openQuestions, keyed by question id. The architect
   * asks these to resolve exactly the ambiguity that makes a spec wrong; before
   * this existed they rendered as read-only text and the only way to respond
   * was Revise, which threw the whole spec away and re-rolled the architect.
   */
  answers?: Record<string, string>;
}

export interface AgentProgress {
  id: string;
  type: AgentStepType;
  message: string;
  timestamp: number;
  details?: string;
  gate?: GatePayload;
  // Set alongside `gate` on an 'awaiting_input' step: the run to resume.
  runId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  image?: string;
  code?: string;
  progressUpdates?: AgentProgress[];
  timestamp: number;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  code: string;
  stlContent?: string | null;
  modelInfo?: ModelInfo | null;
  selectedModel?: string;
  designContract?: DesignContract;
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

export interface CompileResult {
  success: boolean;
  stlContent?: string;
  geometry?: THREE.BufferGeometry;
  modelInfo?: ModelInfo;
  error?: string;
  compileTimeMs?: number;
  aborted?: boolean;
}

export interface ViewportSettings {
  showGrid: boolean;
  showAxes: boolean;
  wireframe: boolean;
  isOrthographic: boolean;
  showEdges: boolean;
  autoRotate: boolean;
}
