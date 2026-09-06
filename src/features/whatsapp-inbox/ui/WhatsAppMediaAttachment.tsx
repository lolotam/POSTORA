import { useEffect, useRef, useState } from "react";
import { Download, FileIcon, Maximize2 } from "lucide-react";
import { useWhatsAppMedia } from "../application/useWhatsAppMedia";
import type { WhatsAppAttachment, WhatsAppResolvedMedia } from "../application/ports";
import { resolveMediaKind } from "../domain/mediaKind";
import { VoiceNotePlayer } from "./VoiceNotePlayer";
import { useWhatsAppInboxApi } from "./WhatsAppInboxApiProvider";
import { WhatsAppMediaLightbox, type LightboxEntry } from "./WhatsAppMediaLightbox";

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

function SmallAction({ label, onClick, children }: { label: string; onClick(): void; children: JSX.Element }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 opacity-70 transition-opacity hover:bg-background/60 hover:opacity-100"
    >
      {children}
    </button>
  );
}

function DocumentCard({
  media,
  attachment,
  onOpen,
}: {
  media: WhatsAppResolvedMedia;
  attachment: WhatsAppAttachment;
  /** Present for PDFs: the name becomes a button that previews the file. */
  onOpen?: () => void;
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
        {onOpen ? (
          <button type="button" onClick={onOpen} className="block truncate text-xs underline-offset-2 hover:underline">
            {label}
          </button>
        ) : (
          <p className="truncate text-xs">{label}</p>
        )}
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

export function WhatsAppMediaAttachment({
  attachment,
  createdTime,
}: WhatsAppMediaAttachmentProps): JSX.Element {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxEntry | null>(null);
  const api = useWhatsAppInboxApi();
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

  // The signed URL is same-origin-hostile for `<a download>` (cross-origin downloads open in
  // a tab instead), so the bytes go through a Blob and the port's saver.
  const download = async (url: string, fileName: string | null) => {
    const response = await fetch(url);
    const blob = await response.blob();
    api.downloadBlob(blob, fileName || (url === resolved?.url ? `whatsapp-${attachment.message_row_id}` : "whatsapp-image"));
  };
  const fileName = resolved?.file_name || attachment.name || null;

  let body: JSX.Element;
  if (!visible || !requestedRowIds.has(attachment.message_row_id) || !resolved) {
    body = <PendingPlaceholder busy={visible} />;
  } else if (!resolved.url) {
    body = <UnavailablePlaceholder />;
  } else {
    const url = resolved.url;
    const kind = resolveMediaKind(attachment, resolved.mime_type);
    if (kind === "image") {
      body = (
        <div className="mt-2">
          <button
            type="button"
            className="block max-w-full"
            onClick={() => setLightbox({ kind: "image", url, fileName, urls: imageUrls })}
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
              src={url}
              alt={attachment.name || "Image attachment"}
              className="min-h-24 min-w-24 max-h-72 max-w-full cursor-pointer rounded-lg bg-muted object-cover"
            />
          </button>
          <div className="mt-1 flex justify-end">
            <SmallAction label="Download image" onClick={() => void download(url, fileName)}>
              <Download className="h-3.5 w-3.5" />
            </SmallAction>
          </div>
        </div>
      );
    } else if (kind === "video") {
      body = (
        <div className="mt-2">
          <video src={url} controls preload="metadata" className="max-h-72 max-w-full rounded-lg" />
          <div className="mt-1 flex justify-end gap-1">
            <SmallAction label="Open video" onClick={() => setLightbox({ kind: "video", url, fileName })}>
              <Maximize2 className="h-3.5 w-3.5" />
            </SmallAction>
            <SmallAction label="Download video" onClick={() => void download(url, fileName)}>
              <Download className="h-3.5 w-3.5" />
            </SmallAction>
          </div>
        </div>
      );
    } else if (kind === "audio") {
      body = (
        <div className="mt-2 flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <VoiceNotePlayer src={url} durationSeconds={attachment.duration_seconds} />
          </div>
          <SmallAction label="Download audio" onClick={() => void download(url, fileName)}>
            <Download className="h-3.5 w-3.5" />
          </SmallAction>
        </div>
      );
    } else if (kind === "pdf") {
      body = (
        <DocumentCard
          media={resolved}
          attachment={attachment}
          onOpen={() => setLightbox({ kind: "pdf", url, fileName })}
        />
      );
    } else {
      body = <DocumentCard media={resolved} attachment={attachment} />;
    }
  }

  return (
    <div ref={sentinelRef} className="min-w-0">
      {body}
      <WhatsAppMediaLightbox
        entry={lightbox}
        onClose={() => setLightbox(null)}
        // Another gallery image carries another name, which this bubble does not know; the
        // download then falls back to a generic name rather than this attachment's.
        onNavigate={(url) => setLightbox((entry) => (entry ? { ...entry, url, fileName: url === resolved?.url ? fileName : null } : entry))}
        onDownload={(url, name) => void download(url, name)}
      />
    </div>
  );
}
