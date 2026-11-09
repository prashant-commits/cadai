'use client';

import React, { Suspense, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AppHeader } from '@/components/layout/header';
import { useAppStore } from '@/store/app-store';
import { setNavigator } from '@/store/projects-slice';

const SplitPaneLayout = dynamic(
  () => import('@/components/layout/split-pane').then((mod) => mod.SplitPaneLayout),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 w-full h-[calc(100vh-3.5rem)] bg-slate-950 flex items-center justify-center text-slate-500 font-mono text-xs">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
          <span>Initializing CAD AI Workspace...</span>
        </div>
      </div>
    ),
  }
);

function WorkspaceContent() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const { openProject } = useAppStore();

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

  return (
    <main className="h-screen w-screen flex flex-col overflow-hidden bg-slate-950">
      <AppHeader />
      <SplitPaneLayout />
    </main>
  );
}

export default function ProjectWorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen w-screen bg-slate-950 flex items-center justify-center text-slate-500 font-mono text-xs">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
            <span>Initializing CAD AI Workspace...</span>
          </div>
        </div>
      }
    >
      <WorkspaceContent />
    </Suspense>
  );
}
