'use client';

import React, { useState, useCallback } from 'react';
import { useAppStore } from '@/store/app-store';
import { ViewportPanel } from '@/components/viewport/viewport-panel';
import { ChatPanel } from '@/components/chat/chat-panel';
import { DesignPanel } from '@/components/design/design-panel';
import { CodeEditorPanel } from '@/components/editor/code-editor-panel';
import { AppHeader } from './app-header';
import { FloatingPanel } from './floating-panel';
import { ExportMenu } from './export-menu';
import { CodeDrawer } from './code-drawer';

export const CHAT_COLLAPSED_KEY = 'cadai:workspace:chat-collapsed';
export const INSPECTOR_COLLAPSED_KEY = 'cadai:workspace:inspector-collapsed';

export function readCollapsed(key: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, collapsed ? '1' : '0');
    }
  } catch {
    // swallow errors
  }
}

export function Workspace() {
  const { editorView } = useAppStore();

  const [chatCollapsed, setChatCollapsed] = useState(() =>
    readCollapsed(CHAT_COLLAPSED_KEY)
  );
  const [inspectorCollapsed, setInspectorCollapsed] = useState(() =>
    readCollapsed(INSPECTOR_COLLAPSED_KEY)
  );

  const toggleChat = useCallback(() => {
    setChatCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(CHAT_COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  const toggleInspector = useCallback(() => {
    setInspectorCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(INSPECTOR_COLLAPSED_KEY, next);
      return next;
    });
  }, []);

  return (
    <div
      className="fixed inset-0 overflow-hidden text-[var(--fg)]"
      style={{
        background: [
          'radial-gradient(560px 320px at 22% 18%, var(--bg-glow-1), transparent 70%)',
          'radial-gradient(600px 340px at 85% 88%, var(--bg-glow-2), transparent 70%)',
          'radial-gradient(420px 240px at 60% 40%, var(--bg-glow-3), transparent 70%)',
          'radial-gradient(1200px 520px at 55% 60%, var(--bg-2) 0%, var(--bg) 68%)',
        ].join(', '),
      }}
    >
      {/* Grid overlay */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(var(--grid-line) 1px, transparent 1px), linear-gradient(90deg, var(--grid-line) 1px, transparent 1px)',
          backgroundSize: '30px 30px',
          maskImage:
            'radial-gradient(ellipse at 55% 60%, var(--bg) 25%, transparent 78%)',
          WebkitMaskImage:
            'radial-gradient(ellipse at 55% 60%, var(--bg) 25%, transparent 78%)',
        }}
      />

      {/* Viewport full-screen layer */}
      <div className="absolute inset-0">
        <ViewportPanel />
      </div>

      {/* Code Drawer */}
      <CodeDrawer />

      {/* App Header top-left */}
      <AppHeader />

      {/* Export slot top-right */}
      <div data-slot="export" className="absolute top-4 right-4 z-20">
        <ExportMenu />
      </div>

      {/* Left Chat panel */}
      <FloatingPanel
        side="left"
        collapsed={chatCollapsed}
        onToggle={toggleChat}
        widthPx={380}
      >
        <div data-panel="chat" className="relative flex-1 min-h-0 flex flex-col">
          <ChatPanel />
        </div>
      </FloatingPanel>

      {/* Right Inspector panel */}
      <FloatingPanel
        side="right"
        collapsed={inspectorCollapsed}
        onToggle={toggleInspector}
        widthPx={340}
      >
        <div data-panel="inspector" className="relative flex-1 min-h-0 flex flex-col">
          {editorView === 'code' ? <CodeEditorPanel /> : <DesignPanel />}
        </div>
      </FloatingPanel>
    </div>
  );
}
