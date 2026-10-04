import { useEffect, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ScheduledMediaItem } from "./ScheduledPostMedia";

interface MediaLightboxDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ScheduledMediaItem[];
  initialIndex: number;
}

export function MediaLightboxDialog({
  open,
  onOpenChange,
  items,
  initialIndex,
}: MediaLightboxDialogProps) {
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    if (open) setIndex(initialIndex);
  }, [open, initialIndex]);

  if (items.length === 0) return null;
  const safeIndex = Math.min(Math.max(index, 0), items.length - 1);
  const current = items[safeIndex];

  const prev = () => setIndex((i) => (i - 1 + items.length) % items.length);
  const next = () => setIndex((i) => (i + 1) % items.length);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0 overflow-hidden bg-background border-border/60">
        <div className="relative flex items-center justify-center bg-black/80 min-h-[60vh]">
          {current.kind === "video" ? (
            <video
              key={current.id}
              src={current.url}
              className="max-h-[80vh] w-full object-contain"
              controls
              autoPlay
              playsInline
            />
          ) : (
            <img
              key={current.id}
              src={current.url}
              alt="Post media"
              className="max-h-[80vh] w-full object-contain"
            />
          )}

          {items.length > 1 && (
            <>
              <Button
                size="icon"
                variant="secondary"
                onClick={prev}
                className="absolute start-3 top-1/2 -translate-y-1/2 rounded-full bg-background"
                aria-label="Previous"
              >
                <ChevronLeft className="w-5 h-5" />
              </Button>
              <Button
                size="icon"
                variant="secondary"
                onClick={next}
                className="absolute end-3 top-1/2 -translate-y-1/2 rounded-full bg-background"
                aria-label="Next"
              >
                <ChevronRight className="w-5 h-5" />
              </Button>
              <div className="absolute bottom-3 start-1/2 -translate-x-1/2 rounded-full bg-background px-3 py-1 text-xs font-medium tabular-nums">
                {safeIndex + 1} / {items.length}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
