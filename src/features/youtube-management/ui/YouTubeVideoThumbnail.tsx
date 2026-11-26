import { ImageOff } from "lucide-react";
import { formatIsoDuration } from "../domain/formatIsoDuration";

export function YouTubeVideoThumbnail({ url, duration, className = "" }: {
  url: string | null;
  duration?: string | null;
  className?: string;
}) {
  const formattedDuration = formatIsoDuration(duration ?? null);
  return (
    <div className={`relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted ${className}`}>
      {url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
      {formattedDuration ? <span dir="ltr" className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 text-xs text-white">{formattedDuration}</span> : null}
    </div>
  );
}
