'use client';

import React from 'react';
import { ProjectMenu } from './project-menu';

export function AppHeader() {
  return (
    <header className="absolute top-4 left-5 z-20 flex items-center gap-2.5 font-semibold text-sm tracking-tight select-none text-[var(--fg)]">
      <div
        className="w-5 h-5 rounded-[7px] shrink-0"
        style={{
          background: 'var(--accent-gradient)',
          boxShadow: '0 0 18px var(--accent-glow)',
        }}
      />
      <span>cadai</span>
      <ProjectMenu />
    </header>
  );
}
