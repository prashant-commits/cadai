'use client';

import React, { useState, useEffect } from 'react';
import { useAppStore } from '@/store/app-store';
import { CodeEditorPanel } from '@/components/editor/code-editor-panel';
import { X } from 'lucide-react';

const GUTTER_PX = 16;
const CHAT_WIDTH_PX = 380;
const INSPECTOR_WIDTH_PX = 340;

/** The drawer spans the gap between the floating panels, so its header is never under them. */
export function codeDrawerInsets(chatCollapsed: boolean, inspectorCollapsed: boolean) {
  return {
    left: chatCollapsed ? GUTTER_PX : GUTTER_PX + CHAT_WIDTH_PX + GUTTER_PX,
    right: inspectorCollapsed ? GUTTER_PX : GUTTER_PX + INSPECTOR_WIDTH_PX + GUTTER_PX,
  };
}

export function CodeDrawer({
  chatCollapsed,
  inspectorCollapsed,
}: {
  chatCollapsed: boolean;
  inspectorCollapsed: boolean;
}) {
  const insets = codeDrawerInsets(chatCollapsed, inspectorCollapsed);
  const { codeDrawerOpen, setCodeDrawerOpen } = useAppStore();
  const [hasOpened, setHasOpened] = useState(codeDrawerOpen);

  if (codeDrawerOpen && !hasOpened) {
    setHasOpened(true);
  }

  useEffect(() => {
    if (!codeDrawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCodeDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [codeDrawerOpen, setCodeDrawerOpen]);

  return (
    <div
      role="region"
      aria-label="Code drawer"
      aria-hidden={!codeDrawerOpen}
      inert={!codeDrawerOpen ? true : undefined}
      style={{ left: insets.left, right: insets.right, background: 'var(--drawer-bg)' }}
      className={`glass absolute bottom-4 z-10 h-[46vh] rounded-[24px] flex flex-col overflow-hidden transition-[transform,left,right] duration-300 ease-in-out ${
        codeDrawerOpen ? 'translate-y-0' : 'translate-y-[calc(100%+1rem)] pointer-events-none'
      }`}
    >
      <div className="absolute top-2.5 right-3 z-20">
        <button
          type="button"
          onClick={() => setCodeDrawerOpen(false)}
          aria-label="Close code"
          className="p-1 rounded-full text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--accent)] transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {hasOpened && <CodeEditorPanel />}
    </div>
  );
}
