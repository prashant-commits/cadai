'use client';

import React from 'react';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { useAppStore } from '@/store/app-store';
import { MODELS } from '@/lib/agent/models';
import { cn } from '@/lib/utils';

export function ModelSelect({ className }: { className?: string }) {
  const selectedModel = useAppStore((s) => s.selectedModel);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);

  const current = MODELS.find((m) => m.slug === selectedModel) ?? MODELS[0];
  const shortLabel = current ? current.label.split(' - ')[0] : selectedModel;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Model"
          data-slot="model-select"
          className={cn(
            'glass inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-foreground rounded-[var(--radius-pill)] hover:bg-accent transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring',
            className
          )}
        >
          <span>{shortLabel}</span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="glass min-w-[240px] p-1">
        <DropdownMenuRadioGroup value={selectedModel} onValueChange={setSelectedModel}>
          {MODELS.map((model) => (
            <DropdownMenuRadioItem
              key={model.slug}
              value={model.slug}
              className="cursor-pointer text-xs rounded-sm py-1.5 px-2 text-foreground focus:bg-accent focus:text-accent-foreground"
            >
              {model.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
