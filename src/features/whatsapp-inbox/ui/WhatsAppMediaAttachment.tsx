import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Download, FileIcon } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWhatsAppMedia } from "../application/useWhatsAppMedia";
import type { WhatsAppAttachment, WhatsAppResolvedMedia } from "../application/ports";
import { VoiceNotePlayer } from "./VoiceNotePlayer";

interface WhatsAppMediaAttachmentProps {
  attachment: WhatsAppAttachment;
  createdTime?: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function scrollRootFor(element: Element): Element | null {
  let current = element.parentElement;
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

function UnavailablePlaceholder(): JSX.Element {
  return (
    <div
      role="status"
      data-testid="wa-media-unavailable"
      className="mt-2 rounded-lg bg-background/50 px-3 py-2 text-xs"
    >
      Media unavailable
    </div>
  );
}

function PendingPlaceholder({ busy }: { busy: boolean }): JSX.Element {
  return (
    <div
      role="status"
      aria-busy={busy}
      data-testid="wa-media-pending"
      className="mt-2 h-24 max-w-xs animate-pulse rounded-lg bg-background/40"
    />
  );
}

function DocumentCard({
  media,
  attachment,
}: {
  media: WhatsAppResolvedMedia;
  attachment: WhatsAppAttachment;
}): JSX.Element {
  const filename = media.file_name || attachment.name;
  const size = typeof media.size_bytes === "number" ? formatSize(media.size_bytes) : null;
  const label = filename || "Document";

  return (
    <div
      data-testid="wa-media-document"
      className="mt-2 flex items-center gap-2 rounded-lg bg-background/50 p-2"
    >
      <FileIcon className="h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="truncate text-xs">{label}</p>
        {size && <p className="text-[10px] text-current/70">{size}</p>}
      </div>
      {media.url && (
        <a
          href={media.url}
          download={filename || true}
          className="ml-auto inline-flex items-center gap-1 text-xs underline"
        >
          <Download className="h-3 w-3" />
          Download
        </a>
      )}
    </div>
  );
}

function ImageLightbox({
  open,
  onOpenChange,
  urls,
  index,
  onIndexChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  urls: string[];
  index: number;
  onIndexChange(index: number): void;
}): JSX.Element | null {
  if (urls.length === 0) return null;
  const safeIndex = Math.min(Math.max(index, 0), urls.length - 1);
  const current = urls[safeIndex];

  const prev = () => onIndexChange((safeIndex - 1 + urls.length) % urls.length);
  const next = () => onIndexChange((safeIndex + 1) % urls.length);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      prev();
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl overflow-hidden border-none bg-black/95 p-0"
        onKeyDown={handleKeyDown}
        hideCloseButton
      >
        <div className="relative flex min-h-[60vh] items-center justify-center">
          <img src={current} alt="" className="max-h-[80vh] w-full object-contain" />
          {urls.length > 1 && (
            <>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Previous image"
                onClick={prev}
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label="Next image"
                onClick={next}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function WhatsAppMediaAttachment({
  attachment,
  createdTime,
}: WhatsAppMediaAttachmentProps): JSX.Element {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const { requestMedia, mediaByRowId, requestedRowIds, imageUrls } = useWhatsAppMedia();
  const resolved = mediaByRowId.get(attachment.message_row_id);

  // Laziness must never be the reason media NEVER loads.
  //
  // IntersectionObserver alone was that reason: Chrome suspends its callbacks while a tab is
  // hidden, so a chat opened in a background tab -- or left while it loaded -- kept every
  // bubble on the pending skeleton, which reads as an attachment that cannot be played.
  // Verified in a real browser: with document.visibilityState "hidden", an observer on a
  // fully on-screen 126x108 element never fires, with or without a root.
  //
  // So the observer is now one of three triggers, all cheap and idempotent (requestMedia
  // dedupes by row id): a geometric check for anything already in or near the pane, the
  // observer for everything scrolled to later, and a visibilitychange re-check for the tab
  // that was hidden when the thread opened. rootMargin also starts the fetch just before a
  // bubble arrives rather than at the moment it does.
  useEffect(() => {
    const element = sentinelRef.current;
    if (!element) return;

    const root = scrollRootFor(element);
    const nearViewport = () => {
      const box = element.getBoundingClientRect();
      const bounds = root
        ? root.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight } as DOMRect;
      const margin = 400;
      return box.bottom > bounds.top - margin && box.top < bounds.bottom + margin;
    };

    if (nearViewport()) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { root, rootMargin: "400px", threshold: 0 },
    );
    observer.observe(element);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && nearViewport()) setVisible(true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    requestMedia(attachment.message_row_id, { createdTime });
  }, [attachment.kind, attachment.message_row_id, createdTime, requestMedia, visible]);

  const openLightbox = (url: string) => {
    const index = imageUrls.indexOf(url);
    setLightboxIndex(index >= 0 ? index : 0);
    setLightboxOpen(true);
  };

  let body: JSX.Element;
  if (!visible || !requestedRowIds.has(attachment.message_row_id) || !resolved) {
    body = <PendingPlaceholder busy={visible} />;
  } else if (!resolved.url) {
    body = <UnavailablePlaceholder />;
  } else if (attachment.kind === "image") {
    body = (
      <>
        <button
          type="button"
          className="mt-2 block max-w-full"
          onClick={() => openLightbox(resolved.url as string)}
        >
          {/* Deliberately NOT loading="lazy". These bubbles live in a nested scroll container
              that is scrolled programmatically to the newest message, and Chrome never marks
              such images visible, so they stay unloaded forever: a permanently blank bubble
              whose URL is perfectly good (verified by hand -- HTTP 200 image/jpeg, and a bare
              new Image() with the same src decodes at full size).

              Nothing is lost by dropping it. The expensive half is already lazy: useWhatsAppMedia
              only asks the server to materialise bytes once a bubble enters the viewport, so the
              browser attribute was saving a request we had already decided to make.

              min-h/min-w give the element a box before its bytes arrive -- otherwise an <img>
              with only max-* constraints lays out at 0x0 and the bubble collapses while loading. */}
          <img
            src={resolved.url}
            alt={attachment.name || "Image attachment"}
            className="min-h-24 min-w-24 max-h-72 max-w-full cursor-pointer rounded-lg bg-muted object-cover"
          />
        </button>
        <ImageLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          urls={imageUrls}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
        />
      </>
    );
  } else if (attachment.kind === "video") {
    body = (
      <video
        src={resolved.url}
        controls
        preload="metadata"
        className="mt-2 max-h-72 max-w-full rounded-lg"
      />
    );
  } else if (attachment.kind === "audio") {
    body = (
      <div className="mt-2">
        <VoiceNotePlayer src={resolved.url} durationSeconds={attachment.duration_seconds} />
      </div>
    );
  } else {
    body = <DocumentCard media={resolved} attachment={attachment} />;
  }

  return (
    <div ref={sentinelRef} className="min-w-0">
      {body}
    </div>
  );
}
