import { DBSchema } from 'idb';
import { AgentProgress, ChatMessage, DesignContract, ModelInfo } from '@/types';

export const DB_NAME = 'cadai-db';
export const DB_VERSION = 1;

export const ACTIVE_THREAD_META_KEY = 'activeThreadId';

/**
 * Legacy localStorage keys, read once during migration then removed. Both the
 * v2 and v1 blob formats are checked — v2 first, since that's the newer one.
 */
export const LEGACY_KEYS: ReadonlyArray<{ threads: string; activeThread: string }> = [
  { threads: 'cadai_threads_v2', activeThread: 'cadai_active_thread_id_v2' },
  { threads: 'cadai_threads_v1', activeThread: 'cadai_active_thread_id_v1' },
];

/** A thread without its messages — messages live in their own store. */
export interface ThreadRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  code: string;
  stlContent?: string | null;
  modelInfo?: ModelInfo | null;
  selectedModel?: string;
  designContract?: DesignContract;
}

/**
 * A message without its code snapshot — that lives in `generatedCode`, so
 * loading a thread's chat history doesn't drag every historical code blob
 * along with it.
 *
 * `rowId` is `${threadId}:${id}` because message ids are only unique within a
 * thread (every thread's welcome message is literally id `welcome-msg`).
 */
export interface MessageRow {
  rowId: string;
  threadId: string;
  id: string;
  role: ChatMessage['role'];
  content: string;
  image?: string;
  progressUpdates?: AgentProgress[];
  timestamp: number;
  hasCode: boolean;
}

/** The code snapshot attached to a single message. */
export interface GeneratedCodeRow {
  rowId: string;
  threadId: string;
  messageId: string;
  code: string;
}

export interface CadaiDB extends DBSchema {
  threads: {
    key: string;
    value: ThreadRow;
  };
  messages: {
    key: string;
    value: MessageRow;
    indexes: { threadId: string };
  };
  generatedCode: {
    key: string;
    value: GeneratedCodeRow;
    indexes: { threadId: string };
  };
  meta: {
    key: string;
    value: string;
  };
}

export function rowId(threadId: string, messageId: string): string {
  return `${threadId}:${messageId}`;
}
