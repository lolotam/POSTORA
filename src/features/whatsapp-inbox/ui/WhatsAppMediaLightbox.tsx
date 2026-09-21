import type { KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";

export interface LightboxEntry {
  kind: "image" | "video" | "pdf";
  url: string;
  fileName: string | null;
  /** Image galleries: every image url in the thread; navigation moves inside it. */
  urls?: string[];
}

interface WhatsAppMediaLightboxProps {
  entry: LightboxEntry | null;
  onClose(): void;
  onNavigate?(url: string): void;
  onDownload(url: string, fileName: string | null): void;
}

export function WhatsAppMediaLightbox({
  entry,
  onClose,
  onNavigate,
  onDownload,
}: WhatsAppMediaLightboxProps): JSX.Element | null {
  if (!entry) return null;
  const urls = entry.kind === "image" ? entry.urls ?? [entry.url] : [entry.url];
  const index = Math.max(0, urls.indexOf(entry.url));
  const prev = () => onNavigate?.(urls[(index - 1 + urls.length) % urls.length]);
  const next = () => onNavigate?.(urls[(index + 1) % urls.length]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      prev();
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
    }
  };
  const label = entry.fileName ?? (entry.kind === "image" ? "Image" : entry.kind === "video" ? "Video" : "PDF");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-4xl overflow-hidden border-none bg-black/95 p-2"
        onKeyDown={onKeyDown}
        hideCloseButton
      >
        <div className="relative flex min-h-[60vh] items-center justify-center">
          {entry.kind === "image" ? (
            <img src={entry.url} alt={label} className="max-h-[80vh] w-full object-contain" />
          ) : entry.kind === "video" ? (
            <video src={entry.url} controls autoPlay playsInline className="max-h-[80vh] w-full rounded-md bg-black" />
          ) : (
            <iframe src={entry.url} title={label} className="h-[80vh] w-full rounded-md bg-white" />
          )}
          {urls.length > 1 && (
            <>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Previous image"
                onClick={prev}
                className="absolute start-3 top-1/2 -translate-y-1/2 rounded-full"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Next image"
                onClick={next}
                className="absolute end-3 top-1/2 -translate-y-1/2 rounded-full"
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => onDownload(entry.url, entry.fileName)}>
            <Download className="h-4 w-4" /> Download
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
