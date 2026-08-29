'use client';

import React from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ChatPanel } from '@/components/chat/chat-panel';
import { PrintAnalysisPanel } from '@/components/print-analysis/print-analysis-panel';
import { ViewportPanel } from '@/components/viewport/viewport-panel';
import { CodeEditorPanel } from '@/components/editor/code-editor-panel';

export function SplitPaneLayout() {
  return (
    <div className="flex-1 w-full h-[calc(100vh-3.5rem)] overflow-hidden">
      <Group orientation="horizontal" id="cadai-horizontal-layout">
        {/* Left Side: Chat (Full Vertical Height) */}
        <Panel defaultSize="40%" minSize="25%" maxSize="65%" className="flex flex-col h-full bg-slate-950">
          <ChatPanel />
        </Panel>

        {/* Horizontal Resize Separator */}
        <Separator className="w-1.5 bg-slate-900 hover:bg-indigo-600 active:bg-indigo-500 transition-colors flex items-center justify-center cursor-col-resize group z-20">
          <div className="w-0.5 h-8 bg-slate-700 group-hover:bg-white rounded-full transition-colors" />
        </Separator>

        {/* Right Side: Viewport + (Code Editor & Print Analysis) */}
        <Panel defaultSize="60%" minSize="35%" className="h-full">
          <Group orientation="vertical" id="cadai-vertical-layout">
            {/* Top Right: 3D Viewport */}
            <Panel defaultSize="60%" minSize="30%" className="relative h-full">
              <ViewportPanel />
            </Panel>

            {/* Vertical Resize Separator */}
            <Separator className="h-1.5 bg-slate-900 hover:bg-indigo-600 active:bg-indigo-500 transition-colors flex items-center justify-center cursor-row-resize group z-20">
              <div className="h-0.5 w-8 bg-slate-700 group-hover:bg-white rounded-full transition-colors" />
            </Separator>

            {/* Bottom Right: Code Editor & Collapsible Print Analysis Panel */}
            <Panel defaultSize="40%" minSize="20%" className="h-full">
              <div className="h-full w-full flex overflow-hidden">
                <div className="flex-1 min-w-0 h-full">
                  <CodeEditorPanel />
                </div>
                <PrintAnalysisPanel />
              </div>
            </Panel>
          </Group>
        </Panel>
      </Group>
    </div>
  );
}
