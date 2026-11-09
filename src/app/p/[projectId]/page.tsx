'use client';

import React, { Suspense, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAppStore } from '@/store/app-store';
import { setNavigator, isProjectOpened } from '@/store/projects-slice';

function WorkspaceLoadingFallback() {
  return (
    <div
      className="fixed inset-0 flex items-center justify-center font-mono text-xs text-[var(--fg-muted)] select-none"
      style={{
        background: [
          'radial-gradient(560px 320px at 22% 18%, var(--bg-glow-1), transparent 70%)',
          'radial-gradient(600px 340px at 85% 88%, var(--bg-glow-2), transparent 70%)',
          'radial-gradient(420px 240px at 60% 40%, var(--bg-glow-3), transparent 70%)',
          'radial-gradient(1200px 520px at 55% 60%, var(--bg-2) 0%, var(--bg) 68%)',
        ].join(', '),
      }}
    >
      <div className="glass px-4 py-3 flex items-center gap-2.5">
        <div className="w-4 h-4 rounded-full border-2 border-[var(--primary)] border-t-transparent animate-spin" />
        <span>Opening the workspace…</span>
      </div>
    </div>
  );
}

const Workspace = dynamic(
  () =>
    import('@/components/workspace/workspace').then((mod) => mod.Workspace),
  {
    ssr: false,
    loading: () => <WorkspaceLoadingFallback />,
  }
);

function WorkspaceContent() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const { openProject, activeProjectId, activeThreadId } = useAppStore();

  const projectId =
    typeof params?.projectId === 'string'
      ? params.projectId
      : Array.isArray(params?.projectId)
      ? params.projectId[0]
      : '';
  const t = searchParams.get('t');
  const openedProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    setNavigator(router.push);
  }, [router]);

  useEffect(() => {
    if (projectId && openedProjectIdRef.current !== projectId) {
      openedProjectIdRef.current = projectId;
      void openProject(projectId, t ?? undefined);
    }
  }, [projectId, t, openProject]);

  useEffect(() => {
    if (
      activeProjectId === projectId &&
      isProjectOpened(projectId) &&
      activeThreadId &&
      activeThreadId !== t
    ) {
      router.replace(`/p/${projectId}?t=${activeThreadId}`);
    }
  }, [activeProjectId, projectId, activeThreadId, t, router]);

  return <Workspace />;
}

export default function ProjectWorkspacePage() {
  return (
    <Suspense fallback={<WorkspaceLoadingFallback />}>
      <WorkspaceContent />
    </Suspense>
  );
}
