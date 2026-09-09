'use client';

import React, { useRef, useEffect, useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { X, Check, Eraser, PenTool, Undo2 } from 'lucide-react';

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  points: Point[];
  color: string;
  width: number;
  isEraser: boolean;
}

export function Annotator() {
  const { baseSnapshot, setIsAnnotating, setPendingAttachment } = useAppStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [color, setColor] = useState('#ef4444');
  const [lineWidth, setLineWidth] = useState(3);
  const [isEraser, setIsEraser] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<Stroke | null>(null);

  const colors = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#ffffff', '#000000'];

  // Initialize canvas with background
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !baseSnapshot) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set logical size to match container
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    redrawCanvas();
  }, [baseSnapshot, strokes, currentStroke]); // Redraw whenever strokes change

  const redrawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw background image
    if (baseSnapshot) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // Draw strokes after background loads to ensure correct layering
        drawStrokes(ctx);
      };
      img.src = baseSnapshot;
    }
  };

  const drawStrokes = (ctx: CanvasRenderingContext2D) => {
    const allStrokes = currentStroke ? [...strokes, currentStroke] : strokes;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    allStrokes.forEach((stroke) => {
      if (stroke.points.length < 2) return;

      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);

      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }

      if (stroke.isEraser) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = stroke.width * 3; // Eraser is bigger
        ctx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = stroke.width;
        ctx.strokeStyle = stroke.color;
      }
      ctx.stroke();
    });
    
    // Reset global composite operation
    ctx.globalCompositeOperation = 'source-over';
  };

  const getCoordinates = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const startDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDrawing(true);
    const point = getCoordinates(e);
    setCurrentStroke({
      points: [point],
      color,
      width: lineWidth,
      isEraser,
    });
  };

  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentStroke) return;
    const point = getCoordinates(e);
    setCurrentStroke({
      ...currentStroke,
      points: [...currentStroke.points, point],
    });
  };

  const stopDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setIsDrawing(false);
    if (currentStroke) {
      setStrokes([...strokes, currentStroke]);
      setCurrentStroke(null);
    }
  };

  const handleUndo = () => {
    setStrokes((prev) => prev.slice(0, -1));
  };

  const handleSave = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      // Force a synchronous redraw to ensure no async image loading issues
      // wait, redrawCanvas is async due to image.onload. 
      // Fortunately the canvas state is already currently visible to the user.
      // So we can just grab toDataURL right now!
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
      setPendingAttachment(dataUrl);
      setIsAnnotating(false);
    }
  };

  const handleCancel = () => {
    setIsAnnotating(false);
  };

  return (
    <div ref={containerRef} className="absolute inset-0 z-40 bg-slate-950 flex flex-col">
      {/* Toolbar */}
      <div className="h-12 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg">
            <button
              onClick={() => setIsEraser(false)}
              className={`p-1.5 rounded-md transition-colors ${!isEraser ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              title="Pen Tool"
            >
              <PenTool className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsEraser(true)}
              className={`p-1.5 rounded-md transition-colors ${isEraser ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
              title="Eraser"
            >
              <Eraser className="w-4 h-4" />
            </button>
          </div>

          <div className="w-px h-6 bg-slate-800" />

          {/* Color Picker */}
          {!isEraser && (
            <div className="flex items-center gap-1">
              {colors.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full border-2 transition-transform ${color === c ? 'scale-110 border-white' : 'border-transparent hover:scale-110'}`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          )}

          <div className="w-px h-6 bg-slate-800" />

          {/* Undo */}
          <button
            onClick={handleUndo}
            disabled={strokes.length === 0}
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:hover:bg-transparent"
            title="Undo"
          >
            <Undo2 className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-md transition-colors flex items-center gap-1.5"
          >
            <X className="w-4 h-4" /> Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-md transition-colors flex items-center gap-1.5 shadow-lg shadow-amber-600/20"
          >
            <Check className="w-4 h-4" /> Attach to Chat
          </button>
        </div>
      </div>

      {/* Drawing Area */}
      <div className="flex-1 relative cursor-crosshair overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute top-0 left-0 touch-none"
          onPointerDown={startDrawing}
          onPointerMove={draw}
          onPointerUp={stopDrawing}
          onPointerLeave={stopDrawing}
        />
      </div>
    </div>
  );
}
