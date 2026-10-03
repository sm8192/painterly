"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ImageUploader, { type SelectedImage } from "./ImageUploader";
import PaintingCanvas from "./PaintingCanvas";

export default function PainterlyApp() {
  const [file, setFile] = useState<File | null>(null);
  const [replayKey, setReplayKey] = useState(0);
  const [done, setDone] = useState(false);

  // Derive the object URL from the file during render (no effect/setState).
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  // Revoke the URL when it changes or the component unmounts.
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const handleSelected = useCallback((next: SelectedImage | null) => {
    setFile(next?.file ?? null);
    setDone(false);
    setReplayKey((k) => k + 1);
  }, []);

  const replay = useCallback(() => {
    setDone(false);
    setReplayKey((k) => k + 1);
  }, []);

  const reset = useCallback(() => {
    // Dropping the file triggers the effect cleanup, which revokes the URL.
    setFile(null);
    setDone(false);
  }, []);

  if (!file || !url) {
    return <ImageUploader onImageSelected={handleSelected} />;
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <PaintingCanvas
        src={url}
        replayKey={replayKey}
        onDone={() => setDone(true)}
      />

      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={replay}
          className="rounded-full bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
        >
          {done ? "Paint again" : "Restart"}
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
