'use client';

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/store/app-store';
import { ServerError } from '@/lib/client/server-projects';
import { BAD_PROJECT_NAME } from '@/lib/persist/phrases';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
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

export const DELETE_PROJECT_TITLE = 'Delete this project?';
export const DELETE_PROJECT_BODY =
  'Its threads and versions will be removed. This cannot be undone.';
export const DELETE_PROJECT_FAILED =
  'The project could not be deleted. Try again.';
export const RENAME_PROJECT_FAILED =
  'The project could not be renamed. Try again.';

export function createProjectMenuActions(deps: {
  deleteProject: (id: string) => Promise<void>;
  setConfirmOpen: (open: boolean) => void;
  toastError: (msg: string) => void;
}): { requestDelete(): void; confirmDelete(id: string): Promise<void> } {
  return {
    requestDelete() {
      deps.setConfirmOpen(true);
    },
    async confirmDelete(id: string) {
      try {
        await deps.deleteProject(id);
        deps.setConfirmOpen(false);
      } catch {
        deps.toastError(DELETE_PROJECT_FAILED);
      }
    },
  };
}

export function ProjectMenu() {
  const router = useRouter();
  const {
    projects,
    activeProjectId,
    loadProjects,
    renameProject,
    deleteProject,
  } = useAppStore();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameInput, setRenameInput] = useState('');

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId]
  );

  const otherProjects = useMemo(
    () => projects.filter((p) => p.id !== activeProjectId),
    [projects, activeProjectId]
  );

  const actions = useMemo(
    () =>
      createProjectMenuActions({
        deleteProject,
        setConfirmOpen,
        toastError: (msg) => toast.error(msg),
      }),
    [deleteProject]
  );

  const handleOpenRename = () => {
    setRenameInput(activeProject?.name ?? '');
    setRenameOpen(true);
  };

  const trimmedRename = renameInput.trim();
  const isSaveDisabled = !trimmedRename || trimmedRename.length > 120;

  const handleSaveRename = async () => {
    if (!activeProjectId || isSaveDisabled) return;
    try {
      await renameProject(activeProjectId, trimmedRename);
      setRenameOpen(false);
    } catch (err: unknown) {
      const is400 =
        (err instanceof ServerError && err.status === 400) ||
        (typeof err === 'object' &&
          err !== null &&
          'status' in err &&
          (err as { status: unknown }).status === 400);

      if (is400) {
        toast.error(BAD_PROJECT_NAME);
      } else {
        toast.error(RENAME_PROJECT_FAILED);
      }
    }
  };

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            void loadProjects();
          }
        }}
      >
        <DropdownMenuTrigger className="inline-flex items-center gap-1 text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] cursor-pointer outline-none transition-colors">
          <span className="truncate max-w-[180px]">
            {activeProject?.name || 'Project'}
          </span>
          <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-70" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[10px] uppercase font-semibold text-[var(--fg-muted)] px-2 py-1">
              Switch
            </DropdownMenuLabel>
            {otherProjects.length > 0 ? (
              otherProjects.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => router.push(`/p/${p.id}`)}
                >
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled>
                <span>No other projects</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />

          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => router.push('/')}>
              New project
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={handleOpenRename}>
              Rename project
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => actions.requestDelete()}
            >
              Delete project
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Rename Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              placeholder="Project name"
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
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{DELETE_PROJECT_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{DELETE_PROJECT_BODY}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (activeProjectId) {
                  void actions.confirmDelete(activeProjectId);
                }
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
