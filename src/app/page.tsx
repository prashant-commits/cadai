'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAppStore } from '@/store/app-store';
import { setNavigator } from '@/store/projects-slice';

export default function LandingPlaceholder() {
  const router = useRouter();
  const { projects, projectsStatus, loadProjects, startProject } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    setNavigator(router.push);
    void loadProjects();
  }, [router, loadProjects]);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isStarting) return;
    setIsStarting(true);
    try {
      await startProject(prompt.trim(), {});
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col items-center p-8 space-y-8">
      <header className="w-full max-w-3xl flex justify-between items-center py-4">
        <h1 className="text-xl font-bold tracking-tight">cadai</h1>
      </header>

      <div className="w-full max-w-xl glass p-6 flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Start a design</h2>
        <form onSubmit={handleStart} className="flex flex-col gap-3">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe a part or assembly to generate..."
            rows={3}
            className="w-full bg-input/20 border border-border rounded-lg p-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={!prompt.trim() || isStarting}
            className="self-end px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 transition-opacity cursor-pointer disabled:cursor-not-allowed"
          >
            {isStarting ? 'Starting...' : 'Start'}
          </button>
        </form>
      </div>

      <div className="w-full max-w-xl flex flex-col gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">Projects</h3>
        {projectsStatus === 'loading' && projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">Loading projects...</p>
        ) : projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">No projects yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/p/${p.id}`}
                  className="glass block p-4 hover:border-primary/50 transition-colors"
                >
                  <div className="font-medium text-sm">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.threadCount} {p.threadCount === 1 ? 'thread' : 'threads'}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
