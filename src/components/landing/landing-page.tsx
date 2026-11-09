'use client';

import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { StartInput } from './start-input';
import { ProjectGrid } from './project-grid';
import { STARTER_IDEAS, pickTwo } from './starter-ideas';
import { useAppStore } from '@/store/app-store';

export function applyIdea(idea: string): string {
  return idea;
}

export function IdeaChip({
  idea,
  onSelect,
}: {
  idea: string;
  onSelect: (idea: string) => void;
}) {
  return (
    <button
      type="button"
      data-slot="idea-chip"
      onClick={() => onSelect(idea)}
      className="glass inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-foreground/80 hover:text-foreground hover:bg-accent rounded-[var(--radius-pill)] transition-colors cursor-pointer text-left"
    >
      <Sparkles className="size-3 text-muted-foreground shrink-0" />
      <span className="truncate">{idea}</span>
    </button>
  );
}

export interface LandingPageProps {
  rand?: () => number;
  now?: number;
}

export function LandingPage(props?: LandingPageProps) {
  const { projects, projectsStatus, loadProjects, startProject } = useAppStore();
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);

  const [ideas, setIdeas] = useState<[string, string]>(() => {
    if (props?.rand) {
      return pickTwo(props.rand);
    }
    return [STARTER_IDEAS[0], STARTER_IDEAS[1]];
  });

  useEffect(() => {
    if (!props?.rand) {
      const timer = setTimeout(() => {
        setIdeas(pickTwo(Math.random));
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [props?.rand]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const handleStart = async (
    text: string,
    opts: {
      attachments?: Array<{
        id: string;
        kind: 'markup' | 'reference';
        localUrl?: string;
      }>;
      model?: string;
    }
  ) => {
    setStarting(true);
    try {
      await startProject(text, opts);
    } catch {
      try {
        toast.error('Could not start the project.');
      } catch {
        // safe in test / node environments
      }
      setStarting(false);
    }
  };

  return (
    <main className="relative min-h-screen bg-background text-foreground flex flex-col items-center overflow-x-hidden">
      {/* Background radial glow overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-0 opacity-40"
        style={{
          backgroundImage: `
            radial-gradient(560px 320px at 22% 18%, var(--bg-glow-1), transparent 70%),
            radial-gradient(600px 340px at 85% 88%, var(--bg-glow-2), transparent 70%),
            radial-gradient(420px 240px at 60% 40%, var(--bg-glow-3), transparent 70%)
          `,
        }}
      />

      <div className="relative z-10 flex flex-col w-full min-h-screen">
        <header className="w-full flex items-center gap-2 pt-6 px-6">
          <div className="size-5 rounded-[6px] bg-[image:var(--accent-gradient)] shadow-[0_0_24px_var(--accent-glow)] shrink-0" />
          <span className="font-semibold text-sm tracking-tight text-foreground">
            cadai
          </span>
        </header>

        <section className="flex flex-col items-center justify-center min-h-[calc(100vh-140px)] w-full max-w-[680px] px-4 mx-auto gap-4 py-8">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground text-center">
            What do you want to make?
          </h1>

          <StartInput
            value={prompt}
            onChange={setPrompt}
            onStart={handleStart}
            starting={starting}
          />

          <div className="flex flex-wrap items-center justify-center gap-2 w-full">
            {ideas.map((idea) => (
              <IdeaChip
                key={idea}
                idea={idea}
                onSelect={(i) => setPrompt(applyIdea(i))}
              />
            ))}
          </div>
        </section>

        <section className="w-full max-w-[680px] px-4 mx-auto pb-16">
          <ProjectGrid
            projects={projects}
            status={projectsStatus}
            now={props?.now}
          />
        </section>
      </div>
    </main>
  );
}
