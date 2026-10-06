import PainterlyApp from "./components/PainterlyApp";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <main className="flex w-full max-w-xl flex-col items-center gap-10">
        <header className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Painterly
          </h1>
          <p className="max-w-md text-lg leading-7 text-zinc-600 dark:text-zinc-400">
            Give me an image and I'll paint it for you.
          </p>
        </header>

        <PainterlyApp />
      </main>
    </div>
  );
}
