'use client';

import React from 'react';
import { useAppStore } from '@/store/app-store';
import {
  Plus,
  Trash2,
  FolderKanban,
  X,
  Clock,
  Box,
  MessageSquare,
  Loader2,
} from 'lucide-react';

interface ThreadDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ThreadDrawer({ isOpen, onClose }: ThreadDrawerProps) {
  const {
    threads,
    activeThreadId,
    generatingThreadId,
    createNewThread,
    switchThread,
    deleteThread,
  } = useAppStore();

  if (!isOpen) return null;

  return (
    <div className="absolute inset-0 z-30 bg-slate-950/95 backdrop-blur-md flex flex-col border-r border-slate-800 animate-in fade-in duration-150 select-none">
      {/* Drawer Header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
        <div className="flex items-center gap-2 text-slate-200">
          <FolderKanban className="w-4 h-4 text-indigo-400" />
          <span className="text-xs font-semibold">Saved 3D Design Threads</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
            {threads.length}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              createNewThread();
              onClose();
            }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium shadow-xs transition-colors cursor-pointer"
            title="Create new design thread"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Design</span>
          </button>

          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors ml-1 cursor-pointer"
            title="Close threads list"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Threads List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 scrollbar-thin">
        {threads.map((thread) => {
          const isActive = thread.id === activeThreadId;
          const isGeneratingThis = generatingThreadId === thread.id;
          const dateStr = new Date(thread.updatedAt).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

          return (
            <div
              key={thread.id}
              onClick={() => {
                switchThread(thread.id);
                onClose();
              }}
              className={`group flex items-center justify-between p-2.5 rounded-lg border transition-all cursor-pointer ${
                isActive
                  ? 'bg-indigo-950/40 border-indigo-500/50 text-indigo-200'
                  : 'bg-slate-900/60 hover:bg-slate-900 border-slate-800/80 hover:border-slate-700 text-slate-300'
              }`}
            >
              <div className="min-w-0 flex-1 mr-2">
                <div className="flex items-center gap-2">
                  <Box className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-indigo-400' : 'text-slate-500'}`} />
                  <span className="text-xs font-semibold truncate block">
                    {thread.title}
                  </span>
                  {isGeneratingThis && (
                    <span className="flex items-center gap-1 text-[10px] text-indigo-400 font-mono px-1.5 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20">
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      <span>Generating</span>
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500 font-mono">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {dateStr}
                  </span>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" />
                    {thread.messages.length} msgs
                  </span>
                </div>
              </div>

              {/* Actions */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteThread(thread.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-rose-900/40 text-slate-500 hover:text-rose-400 transition-all cursor-pointer"
                title="Delete this design thread"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
