"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SelectedImage {
  /** The original file the user chose. */
  file: File;
}

/** Internal preview state: the file plus a locally-owned preview URL. */
interface Preview {
  file: File;
  url: string;
}

interface ImageUploaderProps {
  /** Called whenever a valid image is selected (or cleared with `null`). */
  onImageSelected?: (image: SelectedImage | null) => void;
}

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export default function ImageUploader({ onImageSelected }: ImageUploaderProps) {
  const [selected, setSelected] = useState<Preview | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The preview URL is owned solely by this component (never handed to the
  // parent), so it's safe to revoke on change/unmount.
  useEffect(() => {
    return () => {
      if (selected) {
        URL.revokeObjectURL(selected.url);
      }
    };
  }, [selected]);

  const handleFile = useCallback(
    (file: File | undefined | null) => {
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        setError("That file isn't an image. Please choose a PNG, JPEG, WEBP, or GIF.");
        return;
      }

      if (ACCEPTED_TYPES.length > 0 && !ACCEPTED_TYPES.includes(file.type)) {
        setError("Unsupported image format. Try PNG, JPEG, WEBP, or GIF.");
        return;
      }

      setError(null);
      setSelected((previous) => {
        if (previous) {
          URL.revokeObjectURL(previous.url);
        }
        return { file, url: URL.createObjectURL(file) };
      });
      // Hand the raw file to the parent; consumers derive their own URLs.
      onImageSelected?.({ file });
    },
    [onImageSelected],
  );

  const clearSelection = useCallback(() => {
    setSelected((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous.url);
      }
      return null;
    });
    setError(null);
    onImageSelected?.(null);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }, [onImageSelected]);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      handleFile(event.dataTransfer.files?.[0]);
    },
    [handleFile],
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return (
    <div className="w-full max-w-xl">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload an image by clicking or dragging a file here"
        onClick={openFilePicker}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openFilePicker();
          }
        }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={[
          "flex min-h-64 cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed p-8 text-center transition-colors",
          isDragging
            ? "border-indigo-500 bg-indigo-50 dark:border-indigo-400 dark:bg-indigo-950/30"
            : "border-zinc-300 bg-zinc-50 hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600",
        ].join(" ")}
      >
        {selected ? (
          <div className="flex flex-col items-center gap-4">
            {/* Use a plain <img> here: the source is a runtime object URL,
                which next/image cannot optimize. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={selected.url}
              alt={`Preview of ${selected.file.name}`}
              className="max-h-64 w-auto rounded-lg object-contain shadow-sm"
            />
            <p className="max-w-xs truncate text-sm text-zinc-500 dark:text-zinc-400">
              {selected.file.name}
            </p>
          </div>
        ) : (
          <>
            <svg
              aria-hidden="true"
              className="h-12 w-12 text-zinc-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
              />
            </svg>
            <div className="space-y-1">
              <p className="text-base font-medium text-zinc-800 dark:text-zinc-200">
                Drop an image here, or click to browse
              </p>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                PNG, JPEG, WEBP, or GIF
              </p>
            </div>
          </>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(event) => handleFile(event.target.files?.[0])}
        />
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {selected && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={clearSelection}
            className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Choose a different image
          </button>
        </div>
      )}
    </div>
  );
}
