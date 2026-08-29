import * as THREE from 'three';

export type AgentStepType = 'thinking' | 'generating' | 'validating' | 'fixing' | 'ready' | 'error';

export interface AgentProgress {
  id: string;
  type: AgentStepType;
  message: string;
  timestamp: number;
  details?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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
  boundingBox: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface CompileResult {
  success: boolean;
  stlContent?: string;
  geometry?: THREE.BufferGeometry;
  modelInfo?: ModelInfo;
  error?: string;
  compileTimeMs?: number;
}

export interface ViewportSettings {
  showGrid: boolean;
  showAxes: boolean;
  wireframe: boolean;
  isOrthographic: boolean;
  showEdges: boolean;
  autoRotate: boolean;
}
