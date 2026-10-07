import { cn } from "@/lib/utils";

/**
 * Animated gradient blob + dotted-grid texture background block.
 * Place as a sibling inside a `relative overflow-hidden` section.
 */
export function BlobHero({
  preset = "sky-violet-pink",
  className,
  withDots = true,
}: {
  preset?: "sky-violet-pink" | "emerald-cyan-sky" | "amber-rose-violet" | "violet-sky" | "tiktok";
  className?: string;
  withDots?: boolean;
}) {
  const blobs =
    preset === "tiktok"
      ? { a: "bg-tiktok-cyan/20", b: "bg-tiktok-red/15", c: "bg-tiktok-cyan/15", wash: "from-tiktok-cyan/5 via-transparent to-tiktok-red/5" }
      : preset === "emerald-cyan-sky"
      ? { a: "bg-emerald-400/30", b: "bg-cyan-400/25", c: "bg-sky-400/25", wash: "from-emerald-500/10 via-cyan-500/10 to-sky-500/10" }
      : preset === "amber-rose-violet"
        ? { a: "bg-amber-400/30", b: "bg-rose-400/25", c: "bg-violet-400/25", wash: "from-amber-500/10 via-rose-500/10 to-violet-500/10" }
        : preset === "violet-sky"
          ? { a: "bg-violet-400/30", b: "bg-sky-400/25", c: "bg-pink-400/20", wash: "from-violet-500/10 via-sky-500/10 to-pink-500/10" }
          : { a: "bg-sky-400/30", b: "bg-violet-400/25", c: "bg-pink-400/25", wash: "from-sky-500/10 via-violet-500/10 to-pink-500/10" };

  return (
    <div aria-hidden className={cn("absolute inset-0 -z-10 pointer-events-none", className)}>
      <div className={cn("absolute inset-0 bg-gradient-to-br", blobs.wash)} />
      <div className={cn("absolute -top-40 -start-20 h-[28rem] w-[28rem] rounded-full blur-3xl animate-blob-drift", blobs.a)} />
      <div className={cn("absolute -top-20 end-0 h-[24rem] w-[24rem] rounded-full blur-3xl animate-blob-drift animation-delay-200", blobs.b)} />
      <div className={cn("absolute bottom-0 start-1/3 h-[20rem] w-[20rem] rounded-full blur-3xl animate-blob-drift animation-delay-300", blobs.c)} />
      {withDots && (
        <div
          className="absolute inset-0 opacity-[0.04] dark:opacity-[0.07]"
          style={{
            backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />
      )}
    </div>
  );
}

export default BlobHero;