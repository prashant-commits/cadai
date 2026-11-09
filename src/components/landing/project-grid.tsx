'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { Box, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { ProjectSummary } from '@/lib/client/server-projects';
import { cn } from '@/lib/utils';

export function filterProjects(
  projects: ProjectSummary[],
  query: string
): ProjectSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) => p.name.toLowerCase().includes(q));
}

export function formatEdited(updatedAt: number, now: number): string {
  const diffMs = Math.max(0, now - updatedAt);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 1) {
    return 'edited just now';
  }
  if (diffMin < 60) {
    return `edited ${diffMin} min ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `edited ${diffHours} h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return 'edited yesterday';
  }
  if (diffDays < 7) {
    return `edited ${diffDays} days ago`;
  }
  const dateStr = new Date(updatedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return `edited ${dateStr}`;
}

export function ProjectThumbPlaceholder({ className }: { className?: string }) {
  return (
    <div
      data-slot="thumb-placeholder"
      className={cn(
        'flex h-28 w-full items-center justify-center rounded-lg bg-card/40 border border-border/50 text-muted-foreground',
        className
      )}
    >
      <Box className="size-6 text-muted-foreground/60" />
    </div>
  );
}

const DynamicCanvas = dynamic(
  () => import('./project-thumb-canvas').then((m) => m.ProjectThumbCanvas),
  {
    ssr: false,
    loading: () => <ProjectThumbPlaceholder />,
  }
);

export function ProjectThumb({ artifactId }: { artifactId: string | null }) {
  if (!artifactId) {
    return <ProjectThumbPlaceholder />;
  }
  return <DynamicCanvas artifactId={artifactId} />;
}

export interface ProjectGridProps {
  projects: ProjectSummary[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  initialSearch?: string;
  now?: number;
}

export function ProjectGrid({
  projects,
  status,
  initialSearch,
  now: propNow,
}: ProjectGridProps) {
  const [mountedNow] = useState(() => Date.now());
  const now = propNow ?? mountedNow;
  const [search, setSearch] = useState(initialSearch ?? '');
  const [showAll, setShowAll] = useState(false);

  const filtered = filterProjects(projects, search);
  const visibleProjects = showAll ? filtered : filtered.slice(0, 6);

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </h2>
        <div className="flex items-center gap-2">
          <div className="relative w-48">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="glass h-7 pl-8 pr-2 text-xs rounded-full bg-transparent border-border/40 focus-visible:ring-1"
            />
          </div>
          {filtered.length > 6 && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer px-2 py-1"
            >
              {showAll ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      </div>

      {status === 'loading' && projects.length === 0 && (
        <div className="py-12 text-center text-xs text-muted-foreground">
          Loading projects
        </div>
      )}

      {status === 'error' && projects.length === 0 && (
        <div className="py-12 text-center text-xs text-destructive">
          Could not load projects
        </div>
      )}

      {!(status === 'loading' && projects.length === 0) &&
        !(status === 'error' && projects.length === 0) && (
          <>
            {projects.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                No projects yet
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                No projects match
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {visibleProjects.map((p) => (
                  <Link
                    key={p.id}
                    href={`/p/${p.id}`}
                    className="glass group flex flex-col gap-2 rounded-xl p-3 transition-colors hover:bg-accent"
                  >
                    <ProjectThumb artifactId={p.thumbnailArtifactId} />
                    <div className="flex flex-col gap-0.5">
                      <div className="text-xs font-medium text-foreground truncate group-hover:text-primary transition-colors">
                        {p.name}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>
                          {p.threadCount === 1 ? '1 thread' : `${p.threadCount} threads`}
                        </span>
                        <span>{formatEdited(p.updatedAt, now)}</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
    </div>
  );
}
