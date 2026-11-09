import { STALE_CLIENT } from '@/lib/persist/phrases';
import type { ServerThreadSummary } from '@/lib/client/server-thread';

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  threadCount: number;
  thumbnailArtifactId: string | null;
}

export class ServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ServerError';
    this.status = status;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<ServerError> {
  let code = 'unknown';
  let message: string = STALE_CLIENT;
  try {
    const data = await res.json();
    if (data?.error?.code && typeof data.error.code === 'string') {
      code = data.error.code;
    }
    if (data?.error?.message && typeof data.error.message === 'string') {
      message = data.error.message;
    }
  } catch {
    // Keep fallback code and message
  }
  return new ServerError(res.status, code, message);
}

export async function listProjects(opts?: {
  search?: string;
  limit?: number;
}): Promise<ProjectSummary[]> {
  const params = new URLSearchParams();
  if (opts?.search !== undefined && opts.search.length > 0) {
    params.set('search', opts.search);
  }
  if (opts?.limit !== undefined && Number.isFinite(opts.limit)) {
    params.set('limit', String(opts.limit));
  }
  const qs = params.toString();
  const url = qs ? `/api/projects?${qs}` : '/api/projects';

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ServerError(0, 'network', STALE_CLIENT);
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  const data = await res.json();
  return data.projects;
}

export async function createProject(name: string): Promise<ProjectSummary> {
  let res: Response;
  try {
    res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch {
    throw new ServerError(0, 'network', STALE_CLIENT);
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  const data = await res.json();
  return {
    id: data.project.id,
    name: data.project.name,
    updatedAt: data.project.updatedAt,
    threadCount: 0,
    thumbnailArtifactId: null,
  };
}

export async function renameProject(id: string, name: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch {
    throw new ServerError(0, 'network', STALE_CLIENT);
  }

  if (!res.ok) {
    throw await parseError(res);
  }
}

export async function deleteProject(id: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch {
    throw new ServerError(0, 'network', STALE_CLIENT);
  }

  if (!res.ok) {
    throw await parseError(res);
  }
}

export async function listProjectThreads(id: string): Promise<ServerThreadSummary[]> {
  let res: Response;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(id)}/threads`);
  } catch {
    throw new ServerError(0, 'network', STALE_CLIENT);
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  const data = await res.json();
  return data.threads;
}
