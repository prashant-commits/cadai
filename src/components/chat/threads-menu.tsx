'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown, Check, Plus, Edit2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/store/app-store';
import type { ChatThread } from '@/types';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export const DELETE_THREAD_TITLE = 'Delete this thread?';
export const DELETE_THREAD_BODY =
  'Its messages and versions will be removed. This cannot be undone.';
export const DELETE_THREAD_FAILED =
  'The thread could not be deleted. Try again.';
export const RENAME_THREAD_FAILED =
  'The thread could not be renamed. Try again.';

export interface ThreadsMenuActionsDeps {
  deleteThread: (id: string) => void | Promise<void>;
  setConfirmOpen: (open: boolean) => void;
  toastError: (msg: string) => void;
}

export function createThreadsMenuActions(deps: ThreadsMenuActionsDeps) {
  let pendingDeleteId: string | null = null;

  return {
    requestDelete(id?: string) {
      if (id) {
        pendingDeleteId = id;
      }
      deps.setConfirmOpen(true);
    },
    async confirmDelete(id?: string) {
      const targetId = id ?? pendingDeleteId;
      if (!targetId) return;
      try {
        await deps.deleteThread(targetId);
        deps.setConfirmOpen(false);
        pendingDeleteId = null;
      } catch {
        deps.toastError(DELETE_THREAD_FAILED);
      }
    },
  };
}

export interface ThreadsMenuItemProps {
  children: React.ReactNode;
  onSelect?: () => void;
  className?: string;
  variant?: 'default' | 'destructive';
  'data-thread-id'?: string;
  'data-active'?: string;
  'aria-current'?: 'true' | undefined;
}

function DefaultThreadsMenuItem({
  children,
  onSelect,
  className,
  variant,
  'data-thread-id': dataThreadId,
  'data-active': dataActive,
  'aria-current': ariaCurrent,
}: ThreadsMenuItemProps) {
  return (
    <button
      type="button"
      data-thread-id={dataThreadId}
      data-active={dataActive}
      aria-current={ariaCurrent}
      data-variant={variant}
      onClick={onSelect}
      className={className}
    >
      {children}
    </button>
  );
}

function DefaultThreadsMenuSeparator({ className }: { className?: string }) {
  return <div className={cn('h-px bg-border my-1', className)} />;
}

function DropdownMenuThreadsItem({
  children,
  onSelect,
  className,
  variant,
  'data-thread-id': dataThreadId,
  'data-active': dataActive,
  'aria-current': ariaCurrent,
}: ThreadsMenuItemProps) {
  return (
    <DropdownMenuItem
      variant={variant}
      onSelect={onSelect}
      data-thread-id={dataThreadId}
      data-active={dataActive}
      aria-current={ariaCurrent}
      className={className}
    >
      {children}
    </DropdownMenuItem>
  );
}

export interface ThreadsMenuListProps {
  threads?: ChatThread[];
  activeThreadId?: string | null;
  onSelectThread?: (id: string) => void;
  onNewThread?: () => void;
  onRequestRename?: () => void;
  onRequestDelete?: (id?: string) => void;
  Item?: React.ComponentType<ThreadsMenuItemProps>;
  Separator?: React.ComponentType<{ className?: string }>;
}

export function ThreadsMenuList({
  threads: propThreads,
  activeThreadId: propActiveThreadId,
  onSelectThread,
  onNewThread,
  onRequestRename,
  onRequestDelete,
  Item = DefaultThreadsMenuItem,
  Separator = DefaultThreadsMenuSeparator,
}: ThreadsMenuListProps = {}) {
  const storeThreads = useAppStore((s) => s.threads);
  const storeActiveThreadId = useAppStore((s) => s.activeThreadId);

  const threads = propThreads ?? storeThreads;
  const activeThreadId = propActiveThreadId ?? storeActiveThreadId;

  return (
    <div data-slot="threads-list" className="flex flex-col gap-1 w-full">
      <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
        {threads.map((thread) => {
          const isActive = thread.id === activeThreadId;
          return (
            <Item
              key={thread.id}
              data-thread-id={thread.id}
              data-active={isActive ? 'true' : undefined}
              aria-current={isActive ? 'true' : undefined}
              onSelect={() => onSelectThread?.(thread.id)}
              className={cn(
                'flex items-center justify-between gap-2 w-full px-2 py-1.5 rounded-sm text-xs text-left cursor-pointer transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-foreground/80 hover:bg-accent/60 hover:text-foreground'
              )}
            >
              <span className="truncate">{thread.title || 'New design'}</span>
              {isActive && <Check className="size-3.5 text-primary shrink-0" />}
            </Item>
          );
        })}
      </div>

      <Separator />

      <Item
        onSelect={() => onNewThread?.()}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-xs text-foreground/90 hover:bg-accent hover:text-foreground cursor-pointer transition-colors text-left"
      >
        <Plus className="size-3.5 text-muted-foreground shrink-0" />
        <span>New thread</span>
      </Item>

      <Item
        onSelect={() => onRequestRename?.()}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-xs text-foreground/90 hover:bg-accent hover:text-foreground cursor-pointer transition-colors text-left"
      >
        <Edit2 className="size-3.5 text-muted-foreground shrink-0" />
        <span>Rename thread</span>
      </Item>

      <Item
        variant="destructive"
        onSelect={() => onRequestDelete?.(activeThreadId ?? undefined)}
        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-xs text-destructive hover:bg-destructive/10 cursor-pointer transition-colors text-left"
      >
        <Trash2 className="size-3.5 text-destructive shrink-0" />
        <span>Delete thread</span>
      </Item>
    </div>
  );
}

export function ThreadsMenu() {
  const {
    threads,
    activeThreadId,
    switchThread,
    newThread,
    renameThread,
    deleteThread,
  } = useAppStore();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameInput, setRenameInput] = useState('');

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId]
  );

  const actions = useMemo(
    () =>
      createThreadsMenuActions({
        deleteThread,
        setConfirmOpen,
        toastError: (msg) => toast.error(msg),
      }),
    [deleteThread]
  );

  const handleOpenRename = () => {
    setRenameInput(activeThread?.title ?? '');
    setRenameOpen(true);
  };

  const trimmedRename = renameInput.trim();
  const isSaveDisabled = !trimmedRename || trimmedRename.length > 120;

  const handleSaveRename = async () => {
    if (!activeThreadId || isSaveDisabled) return;
    try {
      await renameThread(activeThreadId, trimmedRename);
      setRenameOpen(false);
    } catch {
      toast.error(RENAME_THREAD_FAILED);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Threads"
            className="glass inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-foreground rounded-[var(--radius-pill)] hover:bg-accent transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring max-w-[200px]"
          >
            <span className="truncate">{activeThread?.title || 'New design'}</span>
            <ChevronDown className="size-3 text-muted-foreground shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="glass min-w-[220px] p-1.5">
          <ThreadsMenuList
            threads={threads}
            activeThreadId={activeThreadId}
            Item={DropdownMenuThreadsItem}
            Separator={DropdownMenuSeparator}
            onSelectThread={(id) => {
              try {
                switchThread(id);
              } catch {
                // ignore
              }
            }}
            onNewThread={() => {
              try {
                newThread();
              } catch {
                // ignore
              }
            }}
            onRequestRename={() => {
              handleOpenRename();
            }}
            onRequestDelete={(id) => {
              actions.requestDelete(id ?? activeThreadId ?? undefined);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rename Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="glass">
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              placeholder="Thread title"
              maxLength={120}
              autoFocus
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button disabled={isSaveDisabled} onClick={handleSaveRename}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Alert Dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="glass">
          <AlertDialogHeader>
            <AlertDialogTitle>{DELETE_THREAD_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{DELETE_THREAD_BODY}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void actions.confirmDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
