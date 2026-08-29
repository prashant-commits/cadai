'use client';

import dynamic from 'next/dynamic';
import { AppHeader } from '@/components/layout/header';

// Dynamically load SplitPaneLayout with SSR disabled for Three.js & Monaco Editor
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

export default function Home() {
  return (
    <main className="h-screen w-screen flex flex-col overflow-hidden bg-slate-950">
      <AppHeader />
      <SplitPaneLayout />
    </main>
  );
}
