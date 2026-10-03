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
  /** How many strokes are being painted at once. Lower = calmer. */
  maxActiveStrokes?: number;
  /** How fast each brush travels, in canvas px per frame. */
  strokeSpeed?: number;
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

/** A cell's sampled color and footprint on the canvas. */
interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/** A brush stroke that animates along a curved path over several frames. */
interface Stroke {
  color: string;
  width: number;
  /** Total path length in px. */
  length: number;
  /** How far along the path we've painted so far, in px. */
  drawn: number;
  /** Start point. */
  x0: number;
  y0: number;
  /** Direction (radians) and per-step curvature. */
  angle: number;
  curvature: number;
}

/**
 * Staged "painting" renderer. Starts from a blank canvas and works through
 * discrete coarse-to-fine stages. Within each stage, cells are painted as
 * animated brush strokes that start at a focal point and travel along a
 * curved path, following image contours. The final stage draws the real
 * image at full resolution, so the result is pixel-identical to the original.
 */
export default function PaintingCanvas({
  src,
  maxSize = 640,
  replayKey = 0,
  onDone,
  stagePauseMs = 550,
  maxActiveStrokes = 10,
  strokeSpeed = 3,
}: PaintingCanvasProps) {
  // Committed paint lives on the base canvas; moving brush tips are drawn on
  // an overlay that's cleared every frame so tips don't leave ghost trails.
  const baseRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest onDone in a ref so it is NOT a dependency of the paint
  // effect. Otherwise an inline onDone from the parent changes identity when
  // onDone fires, which would restart the whole animation one extra time.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const [progress, setProgress] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [stageCount, setStageCount] = useState(STAGE_LABELS.length);
  const [stageLabel, setStageLabel] = useState(STAGE_LABELS[0]);
  const [finished, setFinished] = useState(false);

  const paint = useCallback(() => {
    const base = baseRef.current;
    const tip = tipRef.current;
    if (!base || !tip) return;
    const ctx = base.getContext("2d");
    const tipCtx = tip.getContext("2d");
    if (!ctx || !tipCtx) return;

    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";

    image.onload = () => {
      if (cancelled) return;

      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

      for (const c of [base, tip]) {
        c.width = Math.round(width * dpr);
        c.height = Math.round(height * dpr);
        c.style.width = `${width}px`;
        c.style.height = `${height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tipCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      tipCtx.lineCap = "round";

      // Full-resolution source for sampling + the final exact pass.
      const source = document.createElement("canvas");
      source.width = width;
      source.height = height;
      const sourceCtx = source.getContext("2d", { willReadFrequently: true });
      if (!sourceCtx) return;
      sourceCtx.drawImage(image, 0, 0, width, height);
      const pixels = sourceCtx.getImageData(0, 0, width, height).data;

      // Start from a genuinely blank (white) canvas.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);

      // Local luminance, used to orient strokes along image contours.
      const luminanceAt = (x: number, y: number): number => {
        const cx = Math.min(width - 1, Math.max(0, Math.floor(x)));
        const cy = Math.min(height - 1, Math.max(0, Math.floor(y)));
        const i = (cy * width + cx) * 4;
        return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      };
      const contourAngleAt = (x: number, y: number): number => {
        const gx = luminanceAt(x + 1, y) - luminanceAt(x - 1, y);
        const gy = luminanceAt(x, y + 1) - luminanceAt(x, y - 1);
        if (gx === 0 && gy === 0) return Math.random() * Math.PI * 2;
        return Math.atan2(gy, gx) + Math.PI / 2; // run along the edge
      };

      // Grid resolution per stage, coarse → fine. Final exact pass has no grid.
      const gridStages = [6, 12, 24, 48, 96, 180];
      const totalStages = gridStages.length + 1;
      setStageCount(totalStages);

      const buildCells = (cellsAcross: number): Cell[] => {
        const longest = Math.max(width, height);
        const cellSize = Math.max(1, Math.round(longest / cellsAcross));
        const cols = Math.ceil(width / cellSize);
        const rows = Math.ceil(height / cellSize);

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
            cells.push({
              x: col * cellSize,
              y: row * cellSize,
              w: cellSize,
              h: cellSize,
              color: `rgba(${data[i]}, ${data[i + 1]}, ${data[i + 2]}, ${
                data[i + 3] / 255
              })`,
            });
          }
        }
        return cells;
      };

      const stages: Cell[][] = gridStages.map(buildCells);

      // Shuffle paint order within each stage so it fills in organically.
      const order: number[][] = stages.map((cells) => {
        const idx = cells.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        return idx;
      });

      // Turn a cell into a stroke plan: focal start point near the cell center,
      // heading along the local contour, length/width scaled to the cell.
      const planStroke = (cell: Cell, stage: number): Stroke => {
        const cx = cell.x + cell.w / 2;
        const cy = cell.y + cell.h / 2;
        const jitter = cell.w * 0.25;
        const x0 = cx + (Math.random() - 0.5) * jitter;
        const y0 = cy + (Math.random() - 0.5) * jitter;
        const angle = contourAngleAt(cx, cy);
        // Longer, bolder strokes early; short, fine strokes late.
        const lengthFactor = stage <= 1 ? 2.2 : stage <= 3 ? 1.6 : 1.1;
        const length = Math.max(cell.w, cell.h) * lengthFactor;
        const width = Math.max(1, (stage <= 2 ? cell.h * 0.9 : cell.h * 0.7));
        return {
          color: cell.color,
          width,
          length,
          drawn: 0,
          x0,
          y0,
          angle,
          curvature: (Math.random() - 0.5) * 0.05,
        };
      };

      // Point along a stroke's gently curving path at distance d.
      const pointAt = (s: Stroke, d: number): [number, number] => {
        const a = s.angle + s.curvature * d;
        return [s.x0 + Math.cos(a) * d, s.y0 + Math.sin(a) * d];
      };

      let currentStage = 0;
      let cursor = 0; // index into order[currentStage]
      const active: Stroke[] = [];
      let paused = false;

      const totalCells = stages.reduce((sum, s) => sum + s.length, 0);
      let completedCells = 0;

      const spawnIfNeeded = () => {
        while (
          !paused &&
          active.length < maxActiveStrokes &&
          currentStage < stages.length &&
          cursor < order[currentStage].length
        ) {
          const cell = stages[currentStage][order[currentStage][cursor]];
          cursor++;
          active.push(planStroke(cell, currentStage));
        }
      };

      // Commit one path segment of a stroke onto the base canvas.
      const commitSegment = (s: Stroke, from: number, to: number) => {
        const [ax, ay] = pointAt(s, from);
        const [bx, by] = pointAt(s, to);
        ctx.globalAlpha = currentStage <= 1 ? 0.92 : 1;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.globalAlpha = 1;
      };

      // Draw a soft moving brush tip on the overlay at the stroke's head.
      const drawTip = (s: Stroke) => {
        const [hx, hy] = pointAt(s, s.drawn);
        const r = s.width * 0.7;
        const grad = tipCtx.createRadialGradient(hx, hy, 0, hx, hy, r);
        grad.addColorStop(0, "rgba(255,255,255,0.55)");
        grad.addColorStop(0.5, s.color);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        tipCtx.fillStyle = grad;
        tipCtx.beginPath();
        tipCtx.arc(hx, hy, r, 0, Math.PI * 2);
        tipCtx.fill();
      };

      const updateProgress = () => {
        setProgress(Math.min(0.999, completedCells / (totalCells + 1)));
      };

      const advanceStage = () => {
        currentStage++;
        cursor = 0;
        if (currentStage < stages.length) {
          setStageIndex(currentStage);
          setStageLabel(
            STAGE_LABELS[Math.min(currentStage, STAGE_LABELS.length - 1)],
          );
        }
        paused = true;
        timeoutRef.current = setTimeout(() => {
          if (cancelled) return;
          paused = false;
          rafRef.current = requestAnimationFrame(step);
        }, stagePauseMs);
      };

      const runExactFinalPass = () => {
        if (cancelled) return;
        tipCtx.clearRect(0, 0, width, height);
        setStageIndex(stages.length);
        setStageLabel(STAGE_LABELS[STAGE_LABELS.length - 1]);
        ctx.drawImage(source, 0, 0, width, height); // identical to original
        setProgress(1);
        setFinished(true);
        onDoneRef.current?.();
      };

      const step = () => {
        if (cancelled) return;

        // Finished all painterly stages → exact final pass.
        if (currentStage >= stages.length) {
          runExactFinalPass();
          return;
        }

        if (paused) return; // waiting between stages; timeout will resume

        spawnIfNeeded();

        // Advance every active stroke by strokeSpeed px, committing the newly
        // traversed segment to the base canvas.
        tipCtx.clearRect(0, 0, width, height);
        for (let i = active.length - 1; i >= 0; i--) {
          const s = active[i];
          const from = s.drawn;
          const to = Math.min(s.length, s.drawn + strokeSpeed);
          commitSegment(s, from, to);
          s.drawn = to;

          if (s.drawn >= s.length) {
            active.splice(i, 1); // stroke landed
            completedCells++;
          } else {
            drawTip(s); // still travelling: show the brush head
          }
        }

        updateProgress();

        const stageDrained =
          cursor >= order[currentStage].length && active.length === 0;

        if (stageDrained) {
          advanceStage();
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = requestAnimationFrame(step);
        }
      };

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
  }, [src, maxSize, stagePauseMs, maxActiveStrokes, strokeSpeed]);

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
      <div className="relative overflow-hidden rounded-xl shadow-lg ring-1 ring-black/5 dark:ring-white/10">
        {/* Base canvas holds committed paint; tip canvas shows moving brushes. */}
        <canvas ref={baseRef} className="block max-w-full" />
        <canvas
          ref={tipRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
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
