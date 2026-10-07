import * as THREE from 'three';
import { AssemblySpec } from '../lib/agent/assembly-spec';
import { SpecViolation } from '../lib/agent/spec-audit';

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
 * and fed straight into the Architect's and Drafter's prompts, where they
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

import type { VariantId, VariantReview } from '../lib/agent/spec-variants';

export interface GateVariant {
  id: VariantId;
  name: string;
  idea: string;
  spec: AssemblySpec | null;
  sheetSvg: string | null;
  review: VariantReview | null;
  error?: string;
}

// The data a paused graph run sends the client to render a HIL gate.
export type GatePayload =
  | {
      kind: 'spec';
      brief?: string;
      variants?: GateVariant[];
      recommendedId?: VariantId;
      openQuestions?: AssemblySpec['openQuestions'];
      contract: DesignContract | null;
      revisionCount: number;
      /** legacy records only */
      spec?: AssemblySpec | null;
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
  chosenVariantId?: VariantId;
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

/** Where one gate got to. `open` is the only state that accepts input. */
export type GateStatus = 'open' | 'approved' | 'revised' | 'denied';

/** How far the assistant message's own turn got. */
export type MessageStatus = 'streaming' | 'awaiting_input' | 'complete' | 'interrupted' | 'error';

/**
 * One human-in-the-loop gate, as it appears in the transcript.
 *
 * The payload rides here rather than inside the markdown: embedding a
 * multi-kilobyte spec would mean escaping it through the renderer and
 * re-parsing it on every read. The markdown carries only `<!--gate:<id>-->`.
 */
export interface GateRecord {
  payload: GatePayload;
  decision?: GateDecision;
  status: GateStatus;
  decidedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /**
   * The compact summary. This is the ONLY field replayed to the model: every
   * prior message's `content` is re-POSTed on the next turn, so the full
   * thinking transcript must not live here or context cost compounds per turn.
   */
  content: string;
  /** Serialised TranscriptNode[]; display only, never leaves the browser. */
  transcript?: string;
  gates?: Record<string, GateRecord>;
  status?: MessageStatus;
  /** The paused run behind an open gate on this message. */
  runId?: string;
  image?: string;
  code?: string;
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
