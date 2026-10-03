"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface PaintingCanvasProps {
  /** Object URL (or any image src) of the picture to paint. */
  src: string;
  /** Longest edge of the painting in CSS pixels. Defaults to 640. */
  maxSize?: number;
  /** Signal used to restart the animation. Changing it replays from scratch. */
  replayKey?: number;
  /** Called when the painting finishes. */
  onDone?: () => void;
  /** Pause between stages, in ms, so each stage reads as a distinct step. */
  stagePauseMs?: number;
  /** How many cells to paint per animation frame. Lower = slower/calmer. */
  cellsPerFrame?: number;
}

/** Human-readable label for each stage, coarse → fine. */
const STAGE_LABELS = [
  "Blocking in base shapes",
  "Massing in color",
  "Shaping forms",
  "Building midtones",
  "Adding detail",
  "Refining fine detail",
  "Final pass",
];

/**
 * Staged "painting" renderer. Starts from a blank canvas and works through
 * discrete coarse-to-fine stages: each stage repaints the whole canvas on a
 * grid of average-color dabs, finer than the last, with a short pause between
 * stages. The final stage draws the real image at full resolution, so the
 * result is pixel-identical to the original.
 */
export default function PaintingCanvas({
  src,
  maxSize = 640,
  replayKey = 0,
  onDone,
  stagePauseMs = 650,
  cellsPerFrame = 24,
}: PaintingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [progress, setProgress] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [stageCount, setStageCount] = useState(STAGE_LABELS.length);
  const [stageLabel, setStageLabel] = useState(STAGE_LABELS[0]);
  const [finished, setFinished] = useState(false);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";

    image.onload = () => {
      if (cancelled) return;

      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));

      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Keep the full-resolution source around for the final exact pass.
      const source = document.createElement("canvas");
      source.width = width;
      source.height = height;
      const sourceCtx = source.getContext("2d");
      if (!sourceCtx) return;
      sourceCtx.drawImage(image, 0, 0, width, height);

      // Start from a genuinely blank (white) canvas.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);

      // Define the grid resolution (cells across the longest edge) for each
      // painterly stage, coarse → fine. The last stage is handled specially
      // as an exact pixel copy, so it has no grid here.
      const gridStages = [6, 12, 24, 48, 96, 180];
      const totalStages = gridStages.length + 1; // + exact final pass
      setStageCount(totalStages);

      // Precompute, for each grid stage, the average color of every cell by
      // downscaling the source to that grid and reading the pixels back.
      type Cell = { x: number; y: number; w: number; h: number; color: string };
      const stages: Cell[][] = gridStages.map((cellsAcross) => {
        const longest = Math.max(width, height);
        const cellSize = Math.max(1, Math.round(longest / cellsAcross));
        const cols = Math.ceil(width / cellSize);
        const rows = Math.ceil(height / cellSize);

        // Downscale to cols×rows; each downscaled pixel ≈ that cell's average.
        const small = document.createElement("canvas");
        small.width = cols;
        small.height = rows;
        const smallCtx = small.getContext("2d", { willReadFrequently: true });
        if (!smallCtx) return [];
        smallCtx.imageSmoothingEnabled = true;
        smallCtx.imageSmoothingQuality = "high";
        smallCtx.drawImage(source, 0, 0, width, height, 0, 0, cols, rows);
        const data = smallCtx.getImageData(0, 0, cols, rows).data;

        const cells: Cell[] = [];
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const i = (row * cols + col) * 4;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3] / 255;
            cells.push({
              x: col * cellSize,
              y: row * cellSize,
              w: cellSize,
              h: cellSize,
              color: `rgba(${r}, ${g}, ${b}, ${a})`,
            });
          }
        }
        return cells;
      });

      // Paint one dab for a cell. Early (large) stages get rounder, overlapping
      // dabs for a soft blocked-in look; finer stages get tighter coverage.
      const paintCell = (cell: Cell, stage: number) => {
        ctx.fillStyle = cell.color;
        const overlap = stage <= 1 ? 1.35 : stage <= 3 ? 1.15 : 1.0;
        const w = cell.w * overlap;
        const h = cell.h * overlap;
        const cx = cell.x + cell.w / 2;
        const cy = cell.y + cell.h / 2;

        if (stage <= 2) {
          // Soft elliptical dabs for the rough early stages.
          ctx.beginPath();
          ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Rectangular coverage for crisper later stages.
          ctx.fillRect(cell.x, cell.y, Math.ceil(w), Math.ceil(h));
        }
      };

      let currentStage = 0;
      let cellCursor = 0;

      // Shuffle the paint order within a stage so it fills in organically
      // rather than scanning top-to-bottom.
      const order: number[][] = stages.map((cells) => {
        const idx = cells.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        return idx;
      });

      const updateProgress = () => {
        if (currentStage >= stages.length) {
          setProgress(1);
          return;
        }
        const within = stages[currentStage].length
          ? cellCursor / stages[currentStage].length
          : 1;
        setProgress(Math.min(0.999, (currentStage + within) / totalStages));
      };

      const runExactFinalPass = () => {
        if (cancelled) return;
        setStageIndex(stages.length); // final stage index
        setStageLabel(STAGE_LABELS[STAGE_LABELS.length - 1]);
        // Draw the true image on top → identical to the original.
        ctx.drawImage(source, 0, 0, width, height);
        setProgress(1);
        setFinished(true);
        onDone?.();
      };

      const step = () => {
        if (cancelled) return;

        if (currentStage >= stages.length) {
          runExactFinalPass();
          return;
        }

        const cells = stages[currentStage];
        const sequence = order[currentStage];

        let painted = 0;
        while (cellCursor < sequence.length && painted < cellsPerFrame) {
          paintCell(cells[sequence[cellCursor]], currentStage);
          cellCursor++;
          painted++;
        }

        updateProgress();

        if (cellCursor >= sequence.length) {
          // Stage complete: pause, then advance to the next stage.
          currentStage++;
          cellCursor = 0;
          if (currentStage < stages.length) {
            setStageIndex(currentStage);
            setStageLabel(STAGE_LABELS[Math.min(currentStage, STAGE_LABELS.length - 1)]);
          }
          timeoutRef.current = setTimeout(() => {
            if (cancelled) return;
            rafRef.current = requestAnimationFrame(step);
          }, stagePauseMs);
        } else {
          rafRef.current = requestAnimationFrame(step);
        }
      };

      // Initialize UI state and kick off stage 0.
      setIsReady(true);
      setFinished(false);
      setProgress(0);
      setStageIndex(0);
      setStageLabel(STAGE_LABELS[0]);
      rafRef.current = requestAnimationFrame(step);
    };

    image.onerror = () => {
      if (!cancelled) setIsReady(false);
    };

    image.src = src;

    return () => {
      cancelled = true;
    };
  }, [src, maxSize, stagePauseMs, cellsPerFrame, onDone]);

  useEffect(() => {
    const cleanupImage = paint();
    return () => {
      cleanupImage?.();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
    // replayKey is included so changing it re-runs the whole effect.
  }, [paint, replayKey]);

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div className="overflow-hidden rounded-xl shadow-lg ring-1 ring-black/5 dark:ring-white/10">
        <canvas ref={canvasRef} className="block max-w-full" />
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {finished
              ? "Finished"
              : `Stage ${Math.min(stageIndex + 1, stageCount)} of ${stageCount}`}
          </span>
          <span className="text-zinc-500 dark:text-zinc-400">
            {finished ? "Identical to original" : stageLabel}
          </span>
        </div>
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-label="Painting progress"
        >
          <div
            className="h-full rounded-full bg-indigo-500 transition-[width] duration-200 ease-out"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>

      {!isReady && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Preparing canvas…</p>
      )}
    </div>
  );
}
