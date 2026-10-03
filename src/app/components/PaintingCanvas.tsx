"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface PaintingCanvasProps {
  /** Object URL (or any image src) of the picture to paint. */
  src: string;
  /** Longest edge of the painting in CSS pixels. Defaults to 640. */
  maxSize?: number;
  /** How many brushstrokes to lay down per animation frame. */
  strokesPerFrame?: number;
  /** Signal used to restart the animation. Changing it replays from scratch. */
  replayKey?: number;
  /** Called when the painting finishes. */
  onDone?: () => void;
}

/**
 * Progressive "painting" renderer. Draws the source image onto a hidden
 * canvas to read its pixels, then animates brushstrokes onto a visible canvas,
 * working coarse-to-fine so the picture resolves gradually.
 */
export default function PaintingCanvas({
  src,
  maxSize = 640,
  strokesPerFrame = 220,
  replayKey = 0,
  onDone,
}: PaintingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [isReady, setIsReady] = useState(false);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    const image = new Image();
    // Allow reading pixels for data URLs / same-origin object URLs.
    image.crossOrigin = "anonymous";

    image.onload = () => {
      if (cancelled) return;

      // Scale so the longest edge is maxSize, preserving aspect ratio.
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));

      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Read the source pixels from an offscreen canvas.
      const source = document.createElement("canvas");
      source.width = width;
      source.height = height;
      const sourceCtx = source.getContext("2d", { willReadFrequently: true });
      if (!sourceCtx) return;
      sourceCtx.drawImage(image, 0, 0, width, height);
      const pixels = sourceCtx.getImageData(0, 0, width, height).data;

      // Start from a muted average-ish wash so gaps don't flash white.
      ctx.fillStyle = "#d9d4cc";
      ctx.fillRect(0, 0, width, height);

      const colorAt = (x: number, y: number): string => {
        const cx = Math.min(width - 1, Math.max(0, Math.floor(x)));
        const cy = Math.min(height - 1, Math.max(0, Math.floor(y)));
        const i = (cy * width + cx) * 4;
        return `rgba(${pixels[i]}, ${pixels[i + 1]}, ${pixels[i + 2]}, ${
          pixels[i + 3] / 255
        })`;
      };

      // Sample a local gradient so strokes follow edges (perpendicular to it).
      const luminanceAt = (x: number, y: number): number => {
        const cx = Math.min(width - 1, Math.max(0, Math.floor(x)));
        const cy = Math.min(height - 1, Math.max(0, Math.floor(y)));
        const i = (cy * width + cx) * 4;
        return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      };

      const strokeAngleAt = (x: number, y: number): number => {
        const gx = luminanceAt(x + 1, y) - luminanceAt(x - 1, y);
        const gy = luminanceAt(x, y + 1) - luminanceAt(x, y - 1);
        if (gx === 0 && gy === 0) {
          return Math.random() * Math.PI; // flat area: random direction
        }
        // Stroke runs perpendicular to the gradient (along the edge).
        return Math.atan2(gy, gx) + Math.PI / 2;
      };

      ctx.lineCap = "round";

      // Coarse-to-fine passes: large brushes first, then progressively smaller.
      const passes = [
        { brush: Math.max(10, Math.round(Math.max(width, height) / 18)), count: 0 },
        { brush: Math.max(6, Math.round(Math.max(width, height) / 36)), count: 0 },
        { brush: Math.max(3, Math.round(Math.max(width, height) / 72)), count: 0 },
        { brush: Math.max(2, Math.round(Math.max(width, height) / 140)), count: 0 },
      ];
      // Strokes per pass scales with area and inverse brush size.
      const area = width * height;
      for (const pass of passes) {
        pass.count = Math.round((area / (pass.brush * pass.brush)) * 1.4);
      }
      const totalStrokes = passes.reduce((sum, p) => sum + p.count, 0);

      let passIndex = 0;
      let drawnInPass = 0;
      let drawnTotal = 0;

      const drawStroke = (brush: number) => {
        const x = Math.random() * width;
        const y = Math.random() * height;
        const angle = strokeAngleAt(x, y);
        const length = brush * (1.5 + Math.random());
        const width2 = brush * (0.6 + Math.random() * 0.5);

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = colorAt(x, y);
        ctx.lineWidth = width2;
        ctx.beginPath();
        ctx.moveTo(-length / 2, 0);
        ctx.lineTo(length / 2, 0);
        ctx.stroke();
        ctx.restore();
      };

      const step = () => {
        if (cancelled) return;

        for (let n = 0; n < strokesPerFrame; n++) {
          if (passIndex >= passes.length) break;
          const pass = passes[passIndex];
          drawStroke(pass.brush);
          drawnInPass++;
          drawnTotal++;
          if (drawnInPass >= pass.count) {
            passIndex++;
            drawnInPass = 0;
          }
        }

        setProgress(Math.min(1, drawnTotal / totalStrokes));

        if (passIndex < passes.length) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = null;
          onDone?.();
        }
      };

      setIsReady(true);
      setProgress(0);
      rafRef.current = requestAnimationFrame(step);
    };

    image.onerror = () => {
      if (!cancelled) setIsReady(false);
    };

    image.src = src;

    return () => {
      cancelled = true;
    };
  }, [src, maxSize, strokesPerFrame, onDone]);

  useEffect(() => {
    const cleanupImage = paint();
    return () => {
      cleanupImage?.();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // replayKey is included so changing it re-runs the whole effect.
  }, [paint, replayKey]);

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div className="overflow-hidden rounded-xl shadow-lg ring-1 ring-black/5 dark:ring-white/10">
        <canvas ref={canvasRef} className="block max-w-full" />
      </div>
      <div
        className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-label="Painting progress"
      >
        <div
          className="h-full rounded-full bg-indigo-500 transition-[width] duration-150 ease-out"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      {!isReady && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Preparing canvas…</p>
      )}
    </div>
  );
}
