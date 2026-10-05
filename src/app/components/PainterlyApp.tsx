"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ImageUploader, { type SelectedImage } from "./ImageUploader";
import PaintingCanvas from "./PaintingCanvas";

export default function PainterlyApp() {
  const [file, setFile] = useState<File | null>(null);
  const [replayKey, setReplayKey] = useState(0);

  // Draft values track the slider thumb live; applied values are what the
  // canvas actually uses. We commit draft → applied on release so dragging a
  // slider doesn't restart the painting on every tick.
  const [speedDraft, setSpeedDraft] = useState(3);
  const [speed, setSpeed] = useState(12);
  const [candidatesDraft, setCandidatesDraft] = useState(1000);
  const [candidates, setCandidates] = useState(1000);

  // How per-pixel color error is measured. Switching restarts the painting.
  const [errorMetric, setErrorMetric] = useState<"squared" | "absolute">(
    "squared",
  );

  const chooseMetric = useCallback((metric: "squared" | "absolute") => {
    setErrorMetric(metric);
    setReplayKey((k) => k + 1);
  }, []);

  const commitSpeed = useCallback(() => {
    setSpeed(speedDraft);
    setReplayKey((k) => k + 1);
  }, [speedDraft]);

  const commitCandidates = useCallback(() => {
    setCandidates(candidatesDraft);
    setReplayKey((k) => k + 1);
  }, [candidatesDraft]);

  // Derive the object URL from the file during render (no effect/setState).
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  // Revoke the URL when it changes or the component unmounts.
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const handleSelected = useCallback((next: SelectedImage | null) => {
    setFile(next?.file ?? null);
    setReplayKey((k) => k + 1);
  }, []);

  const replay = useCallback(() => {
    setReplayKey((k) => k + 1);
  }, []);

  const reset = useCallback(() => {
    // Dropping the file triggers the effect cleanup, which revokes the URL.
    setFile(null);
  }, []);

  if (!file || !url) {
    return <ImageUploader onImageSelected={handleSelected} />;
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <PaintingCanvas
        src={url}
        replayKey={replayKey}
        strokeSpeed={speed}
        candidatesPerStroke={candidates}
        errorMetric={errorMetric}
      />

      <div className="grid w-full max-w-md grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="flex items-center justify-between text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">Brush speed</span>
            <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
              {speedDraft} px/frame
            </span>
          </span>
          <input
            type="range"
            min={1}
            max={12}
            step={1}
            value={speedDraft}
            onChange={(e) => setSpeedDraft(Number(e.target.value))}
            onPointerUp={commitSpeed}
            onKeyUp={commitSpeed}
            className="w-full accent-indigo-600"
            aria-label="Brush speed in pixels per frame"
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="flex items-center justify-between text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">Candidates per stroke</span>
            <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
              {candidatesDraft}
            </span>
          </span>
          <input
            type="range"
            min={1}
            max={1000}
            step={1}
            value={candidatesDraft}
            onChange={(e) => setCandidatesDraft(Number(e.target.value))}
            onPointerUp={commitCandidates}
            onKeyUp={commitCandidates}
            className="w-full accent-indigo-600"
            aria-label="Number of candidate strokes simulated per move"
          />
        </label>
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          Color difference metric
        </span>
        <div
          role="radiogroup"
          aria-label="Color difference metric"
          className="inline-flex rounded-full border border-zinc-300 p-0.5 dark:border-zinc-700"
        >
          {(
            [
              ["squared", "Squared"],
              ["absolute", "Absolute"],
            ] as const
          ).map(([value, label]) => {
            const active = errorMetric === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => chooseMetric(value)}
                className={[
                  "flex-1 rounded-full px-4 py-1.5 font-medium transition-colors",
                  active
                    ? "bg-indigo-600 text-white"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
                ].join(" ")}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={replay}
          className="rounded-full bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
        >
          Restart
        </button>
        <button
          type="button"
          onClick={reset}
          className="rounded-full border border-zinc-300 px-5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          New image
        </button>
      </div>
    </div>
  );
}
