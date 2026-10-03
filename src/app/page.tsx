import ImageUploader from "./components/ImageUploader";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <main className="flex w-full max-w-xl flex-col items-center gap-10">
        <header className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Painterly
          </h1>
          <p className="max-w-md text-lg leading-7 text-zinc-600 dark:text-zinc-400">
            Upload an image and watch it come to life, one brushstroke at a time.
          </p>
        </header>

        <ImageUploader />
      </main>
    </div>
  );
}
