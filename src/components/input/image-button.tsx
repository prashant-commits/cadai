'use client';

import React, { useRef } from 'react';
import { ImagePlus } from 'lucide-react';
import { useAppStore } from '@/store/app-store';
import { cn } from '@/lib/utils';

export function ImageButton({
  disabled,
  className,
}: {
  disabled?: boolean;
  className?: string;
}) {
  const attachImage = useAppStore((s) => s.attachImage);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        if (typeof dataUrl === 'string') {
          attachImage(dataUrl, 'reference');
        }
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        tabIndex={-1}
        className="hidden"
        onChange={handleChange}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={handleClick}
        aria-label="Attach image"
        data-slot="image-button"
        className={cn(
          'glass inline-flex size-8 items-center justify-center rounded-[var(--radius-pill)] text-foreground hover:bg-accent transition-colors cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          className
        )}
      >
        <ImagePlus className="size-4 text-foreground/80" />
      </button>
    </>
  );
}
