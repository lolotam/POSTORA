import { ImageOff } from "lucide-react";

export function TopVideoThumbnail({ url, className = "" }: { url?: string | null; className?: string }) {
  return (
    <div className={`flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted ${className}`}>
      {url ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
    </div>
  );
}
