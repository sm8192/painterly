"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ImageUploader, { type SelectedImage } from "./ImageUploader";
import PaintingCanvas from "./PaintingCanvas";

export default function PainterlyApp() {
  const [file, setFile] = useState<File | null>(null);
  const [replayKey, setReplayKey] = useState(0);
  // The brush level the canvas is currently at. Kept here so Restart can
  // resume at it; reset to 0 (coarsest) only when a new image is chosen.
  // (State, not a ref, so it can be read during render for the prop.)
  const [level, setLevel] = useState(0);

  // Derive the object URL from the file during render (no effect/setState).
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  // Revoke the URL when it changes or the component unmounts.
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const handleLevelChange = useCallback((next: number) => {
    setLevel(next);
  }, []);

  const handleSelected = useCallback((next: SelectedImage | null) => {
    setLevel(0); // a new image starts coarse
    setFile(next?.file ?? null);
    setReplayKey((k) => k + 1);
  }, []);

  const replay = useCallback(() => {
    // Keep `level` as-is so Restart resumes at the current brush level.
    setReplayKey((k) => k + 1);
  }, []);

  const reset = useCallback(() => {
    // Dropping the file triggers the effect cleanup, which revokes the URL.
    setLevel(0);
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
        strokeSpeed={12}
        candidatesPerStroke={1000}
        errorMetric="squared"
        initialLevel={level}
        onLevelChange={handleLevelChange}
      />

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
