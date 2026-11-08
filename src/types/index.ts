import * as THREE from 'three';
import type { DesignContract, ModelInfo } from './designer';
import type { ServerThreadVersion } from '@/lib/client/server-thread';
export * from './designer';

/** How far the assistant message's own turn got. */
export type MessageStatus = 'streaming' | 'complete' | 'interrupted' | 'error';

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
  status?: MessageStatus;
  /** The run that produced this message. */
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
  step?: string | null;
  activeRunId?: string | null;
  versions?: ServerThreadVersion[];
}


export interface CompileResult {
  success: boolean;
  stlContent?: string;
  geometry?: THREE.BufferGeometry;
  modelInfo?: ModelInfo;
  error?: string;
  compileTimeMs?: number;
  aborted?: boolean;
  step?: string;
  language?: 'build123d';
}

export interface ViewportSettings {
  showGrid: boolean;
  showAxes: boolean;
  wireframe: boolean;
  isOrthographic: boolean;
  showEdges: boolean;
  autoRotate: boolean;
}
