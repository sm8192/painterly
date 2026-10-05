"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface PaintingCanvasProps {
  /** Object URL (or any image src) of the picture to paint. */
  src: string;
  /** Longest edge of the painting in CSS pixels. Defaults to 640. */
  maxSize?: number;
  /** Signal used to restart the animation. Changing it replays from scratch. */
  replayKey?: number;
  /** Pause between brush-size changes, in ms, so each reads as a distinct step. */
  stagePauseMs?: number;
  /** How fast the brush travels, in canvas px per frame. */
  strokeSpeed?: number;
  /**
   * How many candidate strokes to simulate per move. The one that best
   * reduces the difference from the target image is the one that gets painted.
   */
  candidatesPerStroke?: number;
}

/** Human-readable label for each brush-size level, coarse → fine. */
const STAGE_LABELS = [
  "Blocking in base shapes",
  "Massing in color",
  "Shaping forms",
  "Building midtones",
  "Adding detail",
  "Refining fine detail",
];

/** A cell's sampled color and footprint on the canvas. */
interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cell center, used for stroke placement and nearest-neighbor ordering. */
  cx: number;
  cy: number;
  color: string;
  /** The same color as numeric channels, for fast scoring. */
  r: number;
  g: number;
  b: number;
}

/** A brush stroke that animates along a curved path over several frames. */
interface Stroke {
  color: string;
  /** Stroke color as numeric channels, mirroring `color`. */
  r: number;
  g: number;
  b: number;
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
 * Progressive "painting" renderer. Starts from a blank canvas and refines it
 * with animated brush strokes that start at a focal point and travel along a
 * curved path, following image contours. The brush shrinks through coarse-to-
 * fine size levels as the match improves, then keeps refining indefinitely at
 * the finest level.
 */
export default function PaintingCanvas({
  src,
  maxSize = 640,
  replayKey = 0,
  stagePauseMs = 550,
  strokeSpeed = 12,
  candidatesPerStroke = 1000,
}: PaintingCanvasProps) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [progress, setProgress] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);
  const [stageCount, setStageCount] = useState(STAGE_LABELS.length);
  const [stageLabel, setStageLabel] = useState(STAGE_LABELS[0]);
  const [finished, setFinished] = useState(false);

  const paint = useCallback(() => {
    const base = baseRef.current;
    if (!base) return;
    const ctx = base.getContext("2d");
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

      base.width = Math.round(width * dpr);
      base.height = Math.round(height * dpr);
      base.style.width = `${width}px`;
      base.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

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

      // An in-memory mirror of what's currently painted, initialized to white.
      // We score candidate strokes against this + the target without touching
      // the visible canvas, then update it when the winning stroke is drawn.
      const currentR = new Uint8ClampedArray(width * height).fill(255);
      const currentG = new Uint8ClampedArray(width * height).fill(255);
      const currentB = new Uint8ClampedArray(width * height).fill(255);

      // Squared-error helper between a pixel's target color and an rgb triple.
      const pixelError = (idx: number, r: number, g: number, b: number) => {
        const ti = idx * 4;
        const dr = r - pixels[ti];
        const dg = g - pixels[ti + 1];
        const db = b - pixels[ti + 2];
        return dr * dr + dg * dg + db * db;
      };

      // Total difference between the blank (white) canvas and the target. The
      // progress bar reports how far the painting has closed this gap:
      //   progress = 1 - currentDifference / originalDifference
      let originalDifference = 0;
      for (let idx = 0; idx < width * height; idx++) {
        originalDifference += pixelError(idx, 255, 255, 255);
      }
      // Running total, updated incrementally as pixels are painted.
      let currentDifference = originalDifference;

      const pixelIndex = (x: number, y: number): number => {
        const cx = Math.min(width - 1, Math.max(0, Math.floor(x)));
        const cy = Math.min(height - 1, Math.max(0, Math.floor(y)));
        return cy * width + cx;
      };

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

      // Brush-size levels (grid resolution), coarse → fine. The brush shrinks
      // to the next level only when a difference/stall condition is met (see
      // the step loop), not after a fixed number of strokes. At the finest
      // level the process continues indefinitely.
      const gridStages = [8, 16, 32, 64, 128, 256, 480];
      const totalStages = gridStages.length;
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
            const x = col * cellSize;
            const y = row * cellSize;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            cells.push({
              x,
              y,
              w: cellSize,
              h: cellSize,
              cx: x + cellSize / 2,
              cy: y + cellSize / 2,
              // Always fully opaque: ignore any alpha in the source image so
              // strokes never paint semi-transparently.
              color: `rgb(${r}, ${g}, ${b})`,
              r,
              g,
              b,
            });
          }
        }
        return cells;
      };

      const stages: Cell[][] = gridStages.map(buildCells);

      /**
       * A spatial index over one stage's cells. Lets us repeatedly pull the
       * nearest not-yet-painted cell to a given point in roughly constant time
       * by bucketing cells into a uniform grid and searching outward in rings.
       */
      class NearestCells {
        private bucketSize: number;
        private cols: number;
        private rows: number;
        private buckets: Cell[][];
        public remaining: number;

        constructor(cells: Cell[]) {
          // Bucket roughly the size of a cell so each bucket holds a few cells.
          this.bucketSize = Math.max(
            8,
            cells.length ? Math.round(Math.max(width, height) / 24) : 8,
          );
          this.cols = Math.max(1, Math.ceil(width / this.bucketSize));
          this.rows = Math.max(1, Math.ceil(height / this.bucketSize));
          this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
          for (const cell of cells) {
            this.buckets[this.bucketIndex(cell.cx, cell.cy)].push(cell);
          }
          this.remaining = cells.length;
        }

        private bucketIndex(x: number, y: number): number {
          const bx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.bucketSize)));
          const by = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.bucketSize)));
          return by * this.cols + bx;
        }

        /** Remove and return the unpainted cell nearest to (px, py). */
        take(px: number, py: number): Cell | null {
          if (this.remaining <= 0) return null;
          const bx = Math.min(this.cols - 1, Math.max(0, Math.floor(px / this.bucketSize)));
          const by = Math.min(this.rows - 1, Math.max(0, Math.floor(py / this.bucketSize)));
          const maxRing = Math.max(this.cols, this.rows);

          let best: Cell | null = null;
          let bestBucket = -1;
          let bestPos = -1;
          let bestDist = Infinity;

          for (let ring = 0; ring <= maxRing; ring++) {
            // Scan all buckets at Chebyshev distance `ring` from the center.
            for (let gy = by - ring; gy <= by + ring; gy++) {
              if (gy < 0 || gy >= this.rows) continue;
              for (let gx = bx - ring; gx <= bx + ring; gx++) {
                if (gx < 0 || gx >= this.cols) continue;
                // Only the ring's perimeter is new on this iteration.
                const onRing =
                  gx === bx - ring || gx === bx + ring ||
                  gy === by - ring || gy === by + ring;
                if (!onRing) continue;

                const bucket = this.buckets[gy * this.cols + gx];
                for (let k = 0; k < bucket.length; k++) {
                  const c = bucket[k];
                  const dx = c.cx - px;
                  const dy = c.cy - py;
                  const dist = dx * dx + dy * dy;
                  if (dist < bestDist) {
                    bestDist = dist;
                    best = c;
                    bestBucket = gy * this.cols + gx;
                    bestPos = k;
                  }
                }
              }
            }
            // Once we have a candidate, one extra ring guarantees correctness
            // (a closer cell could sit in an adjacent bucket just out of range).
            if (best && ring > 0) break;
          }

          if (best) {
            const bucket = this.buckets[bestBucket];
            bucket.splice(bestPos, 1);
            this.remaining--;
          }
          return best;
        }
      }

      // The active cell supply for the current brush level. Rebuilt when a
      // level is (re)entered or exhausted without shrinking.
      let activeIndex = new NearestCells(stages[0]);

      // Generate one *candidate* stroke for a cell. Candidates share the cell's
      // color and focal area but vary in start jitter, heading, length,
      // curvature, and width, so we can simulate several and keep the best.
      const makeCandidate = (cell: Cell, stage: number): Stroke => {
        const jitter = cell.w * 0.3;
        const x0 = cell.cx + (Math.random() - 0.5) * jitter;
        const y0 = cell.cy + (Math.random() - 0.5) * jitter;
        // Base heading follows the local contour; candidates deviate a little.
        const baseAngle = contourAngleAt(cell.cx, cell.cy);
        const angle = baseAngle + (Math.random() - 0.5) * 0.9;
        // Longer, bolder strokes early; shorter, fine strokes late. The random
        // factor spans 0 → 4.5, so a stroke can be anything from a single dot
        // (length ~0, rendered as one round brush-width dab) up to the max.
        const lengthFactor = stage <= 1 ? 4.5 : stage <= 3 ? 3.2 : 2.2;
        const length = Math.max(cell.w, cell.h) * lengthFactor * (Math.random() * 4.5);
        const width =
          Math.max(1, stage <= 2 ? cell.h * 0.9 : cell.h * 0.7) *
          (0.75 + Math.random() * 0.5);
        // Curvature is angle-per-px, so a stroke's total sweep is
        // curvature * length. Derive it from the length and cap the sweep at
        // ±60° (π/3) so long strokes bend into a gentle arc instead of a spiral.
        const maxArc = Math.PI / 3;
        const curvature =
          length > 0 ? ((Math.random() * 2 - 1) * maxArc) / length : 0;
        return {
          color: cell.color,
          r: cell.r,
          g: cell.g,
          b: cell.b,
          width,
          length,
          drawn: 0,
          x0,
          y0,
          angle,
          curvature,
        };
      };

      // Point along a stroke's gently curving path at distance d.
      const pointAt = (s: Stroke, d: number): [number, number] => {
        const a = s.angle + s.curvature * d;
        return [s.x0 + Math.cos(a) * d, s.y0 + Math.sin(a) * d];
      };

      // Score a candidate by how much it would reduce the difference between
      // the current painting and the target image. For sample points along the
      // path (and across the brush width), we compare the squared color error
      // before (current canvas vs target) and after (stroke color vs target).
      // A positive score means the stroke makes the painting more accurate.
      const scoreStroke = (s: Stroke): number => {
        const stepPx = Math.max(2, s.width * 0.6);
        const steps = Math.max(2, Math.round(s.length / stepPx));
        const halfW = s.width / 2;
        // Sample the center plus two offsets across the brush width.
        const offsets = [-halfW * 0.6, 0, halfW * 0.6];

        let improvement = 0;
        for (let i = 0; i <= steps; i++) {
          const d = (i / steps) * s.length;
          const [px, py] = pointAt(s, d);
          // Perpendicular direction for width sampling.
          const a = s.angle + s.curvature * d + Math.PI / 2;
          const ox = Math.cos(a);
          const oy = Math.sin(a);

          for (const off of offsets) {
            const sx = px + ox * off;
            const sy = py + oy * off;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            const idx = pixelIndex(sx, sy);
            const ti = idx * 4;
            const tr = pixels[ti];
            const tg = pixels[ti + 1];
            const tb = pixels[ti + 2];

            // Error of the current canvas vs the target at this pixel.
            const dcr = currentR[idx] - tr;
            const dcg = currentG[idx] - tg;
            const dcb = currentB[idx] - tb;
            const errBefore = dcr * dcr + dcg * dcg + dcb * dcb;

            // Error if we painted the stroke color here instead.
            const dsr = s.r - tr;
            const dsg = s.g - tg;
            const dsb = s.b - tb;
            const errAfter = dsr * dsr + dsg * dsg + dsb * dsb;

            improvement += errBefore - errAfter;
          }
        }
        return improvement;
      };

      // Write the stroke's color into the in-memory mirror along a path
      // segment, so later candidate scoring reflects what we actually painted.
      const commitToMirror = (s: Stroke, from: number, to: number) => {
        const stepPx = Math.max(1, s.width * 0.4);
        const steps = Math.max(1, Math.round((to - from) / stepPx));
        const halfW = s.width / 2;
        for (let i = 0; i <= steps; i++) {
          const d = from + ((to - from) * i) / steps;
          const [px, py] = pointAt(s, d);
          const a = s.angle + s.curvature * d + Math.PI / 2;
          const ox = Math.cos(a);
          const oy = Math.sin(a);
          for (let off = -halfW; off <= halfW; off += 1) {
            const sx = px + ox * off;
            const sy = py + oy * off;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            const idx = pixelIndex(sx, sy);
            // Keep the running difference in sync: swap this pixel's old error
            // for its new error after painting the stroke color here.
            const errBefore = pixelError(idx, currentR[idx], currentG[idx], currentB[idx]);
            const errAfter = pixelError(idx, s.r, s.g, s.b);
            currentDifference += errAfter - errBefore;
            currentR[idx] = s.r;
            currentG[idx] = s.g;
            currentB[idx] = s.b;
          }
        }
      };

      let currentStage = 0;
      let paused = false;

      // Only one stroke is painted at a time. We remember where the last one
      // ended so the next stroke starts from the nearest remaining cell.
      let current: Stroke | null = null;
      let lastX = width / 2;
      let lastY = height / 2;

      // Brush-shrink tracking.
      // (A) shrink once the difference falls to 2/3 of its value at the last
      //     shrink; (B) shrink after this many consecutive non-improving moves.
      const SHRINK_DIFFERENCE_RATIO = 1 / 4;
      const SHRINK_NEGATIVE_STREAK = 20;
      let differenceAtLastShrink = currentDifference;
      let consecutiveNegative = 0;

      // Outcome of trying to start the next stroke.
      const enum NextResult {
        Started, // a worthwhile stroke was chosen and is now `current`
        Skipped, // a cell was consumed, but no candidate improved the image
        Empty, // the current level's cell supply is exhausted
      }

      // Try to start the next stroke: take the unpainted cell nearest the
      // previous endpoint, simulate several candidates, and keep the best.
      // If even the best candidate would move the canvas *away* from the
      // target (non-positive improvement), skip it rather than paint — a wrong
      // stroke is worse than no stroke.
      const beginNextStroke = (): NextResult => {
        if (currentStage >= stages.length) return NextResult.Empty;
        const cell = activeIndex.take(lastX, lastY);
        if (!cell) return NextResult.Empty;

        let best: Stroke | null = null;
        let bestScore = -Infinity;
        const n = Math.max(1, candidatesPerStroke);
        for (let i = 0; i < n; i++) {
          const candidate = makeCandidate(cell, currentStage);
          const score = scoreStroke(candidate);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }

        lastX = cell.cx;
        lastY = cell.cy;

        // Only paint if the best candidate actually improves the match.
        if (best && bestScore > 0) {
          current = best;
          consecutiveNegative = 0; // (B) reset: this move improved the image
          return NextResult.Started;
        }

        consecutiveNegative++; // (B) count a non-improving move
        return NextResult.Skipped;
      };

      // Commit one path segment of a stroke onto the base canvas, and mirror
      // the same paint into the in-memory buffer used for candidate scoring.
      const commitSegment = (s: Stroke, from: number, to: number) => {
        const [ax, ay] = pointAt(s, from);
        const [bx, by] = pointAt(s, to);
        // Strokes are always fully opaque.
        ctx.globalAlpha = 1;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
        commitToMirror(s, from, to);
      };

      const updateProgress = () => {
        // Fraction of the original canvas-to-target difference we've closed.
        const closed =
          originalDifference > 0 ? 1 - currentDifference / originalDifference : 1;
        setProgress(Math.min(0.999, Math.max(0, closed)));
      };

      // Shrink the brush to the next finer level. Resets the shrink trackers,
      // rebuilds the cell supply for the new level, and pauses briefly so the
      // size change reads as a distinct step.
      const shrinkBrush = () => {
        currentStage++;
        current = null;
        consecutiveNegative = 0;
        differenceAtLastShrink = currentDifference;
        if (currentStage < stages.length) {
          activeIndex = new NearestCells(stages[currentStage]);
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

      const atFinestLevel = () => currentStage >= stages.length - 1;

      // Whether either shrink condition is satisfied. Only applies above the
      // finest level — at the finest level there's nothing smaller to shrink
      // to, so a stall there finishes the painting instead (see shouldFinish).
      const shouldShrink = (): boolean => {
        if (atFinestLevel()) return false;
        return (
          currentDifference <= SHRINK_DIFFERENCE_RATIO * differenceAtLastShrink ||
          consecutiveNegative >= SHRINK_NEGATIVE_STREAK
        );
      };

      // The painting is complete once the finest brush can no longer improve
      // the image — i.e. it stalls (a run of non-improving strokes). The
      // canvas converges to the target through brushwork alone; we never copy
      // the source over it.
      const shouldFinish = (): boolean =>
        atFinestLevel() && consecutiveNegative >= SHRINK_NEGATIVE_STREAK;

      const finish = () => {
        setProgress(1);
        setFinished(true);
        // Stop the loop: no further frames are scheduled.
      };

      const step = () => {
        if (cancelled) return;

        if (paused) return; // waiting between levels; timeout will resume

        // If we're between strokes and the finest brush has stalled, finish.
        if (!current && shouldFinish()) {
          finish();
          return;
        }

        // If we're between strokes and a shrink condition is met, shrink now.
        if (!current && shouldShrink()) {
          shrinkBrush();
          rafRef.current = requestAnimationFrame(step);
          return;
        }

        // Make sure we have a stroke to work on. Non-improving moves ("skips")
        // don't paint anything, so keep pulling cells until one is worth
        // painting, a shrink condition fires, or the supply empties. Cap the
        // skips per frame so a mostly-correct level can't block the frame.
        if (!current) {
          const maxSkipsPerFrame = 256;
          let skips = 0;
          let result = beginNextStroke();
          while (
            result === NextResult.Skipped &&
            skips < maxSkipsPerFrame &&
            !shouldShrink() &&
            !shouldFinish()
          ) {
            skips++;
            result = beginNextStroke();
          }

          // At the finest level, a long non-improving streak means the
          // brushwork has converged — the painting is complete.
          if (shouldFinish()) {
            finish();
            return;
          }

          // Above the finest level, a shrink condition drops to a smaller brush.
          if (shouldShrink()) {
            shrinkBrush();
            rafRef.current = requestAnimationFrame(step);
            return;
          }

          if (result === NextResult.Empty) {
            // Supply exhausted at this size without a shrink condition yet.
            // Refill the level's cells and keep painting at the same brush
            // size; the shrink conditions will eventually advance the level.
            activeIndex = new NearestCells(stages[currentStage]);
            updateProgress();
            rafRef.current = requestAnimationFrame(step);
            return;
          }
          if (result === NextResult.Skipped) {
            // Hit the per-frame skip cap without finding a paintable stroke.
            updateProgress();
            rafRef.current = requestAnimationFrame(step);
            return;
          }
          // Otherwise a stroke was started; fall through to paint it.
        }

        // Advance the single current stroke by strokeSpeed px, committing the
        // newly traversed segment to the canvas.
        const s = current!;
        const from = s.drawn;
        const to = Math.min(s.length, s.drawn + strokeSpeed);
        commitSegment(s, from, to);
        s.drawn = to;

        if (s.drawn >= s.length) {
          // Stroke landed: record its endpoint and retire it.
          const [ex, ey] = pointAt(s, s.length);
          lastX = ex;
          lastY = ey;
          current = null;
        }

        updateProgress();
        rafRef.current = requestAnimationFrame(step);
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
  }, [src, maxSize, stagePauseMs, strokeSpeed, candidatesPerStroke]);

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
        <canvas ref={baseRef} className="block max-w-full" />
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {finished
              ? "Finished"
              : `Brush ${Math.min(stageIndex + 1, stageCount)} of ${stageCount}`}
          </span>
          <span className="text-zinc-500 dark:text-zinc-400">
            {finished ? "Painting complete" : stageLabel}
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
