'use client';

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export function FloatingPanel(props: {
  side: 'left' | 'right';
  collapsed: boolean;
  onToggle: () => void;
  widthPx: number;
  children: React.ReactNode;
}) {
  const { side, collapsed, onToggle, widthPx, children } = props;

  const isLeft = side === 'left';

  return (
    <>
      <div
        data-side={side}
        data-collapsed={String(collapsed)}
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
        style={{ width: widthPx }}
        className={cn(
          'glass absolute top-16 bottom-4 z-20 flex flex-col overflow-clip transition-transform duration-300 ease-in-out',
          isLeft ? 'left-4' : 'right-4',
          collapsed &&
            (isLeft
              ? '-translate-x-[calc(100%+1rem)] pointer-events-none'
              : 'translate-x-[calc(100%+1rem)] pointer-events-none')
        )}
      >
        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Hide panel"
            className={cn(
              'absolute top-3 z-30 flex items-center justify-center p-1.5 rounded-full hover:bg-[var(--accent)] text-[var(--fg-muted)] hover:text-[var(--fg)] cursor-pointer transition-colors',
              isLeft ? 'right-3' : 'left-3'
            )}
          >
            {isLeft ? (
              <ChevronLeft className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        )}
        <div className="relative flex-1 min-h-0 flex flex-col overflow-clip">
          {children}
        </div>
      </div>

      {collapsed && (
        <button
          type="button"
          onClick={onToggle}
          aria-label="Show panel"
          className={cn(
            'glass absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center py-4 px-1.5 cursor-pointer hover:bg-[var(--accent)] text-[var(--fg-muted)] hover:text-[var(--fg)] transition-all',
            isLeft ? 'left-0 rounded-r-full' : 'right-0 rounded-l-full'
          )}
        >
          {isLeft ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronLeft className="size-4" />
          )}
        </button>
      )}
    </>
  );
}
