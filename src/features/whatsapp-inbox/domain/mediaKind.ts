import type { WhatsAppAttachmentKind } from "../application/ports";

export type MediaKind = "image" | "video" | "audio" | "pdf" | "document";

function isPdfMime(mime: string | null | undefined): boolean {
  return (mime ?? "").split(";")[0].trim().toLowerCase() === "application/pdf";
}

/**
 * The resolved MIME wins (a name can lie); before resolution the stored MIME or the name
 * decides. Only documents need this: images, video and audio already arrive typed.
 */
export function resolveMediaKind(
  attachment: { kind: WhatsAppAttachmentKind; name: string | null; mime_type: string | null },
  resolvedMime?: string | null,
): MediaKind {
  if (attachment.kind !== "document") return attachment.kind;
  if (resolvedMime != null) return isPdfMime(resolvedMime) ? "pdf" : "document";
  if (isPdfMime(attachment.mime_type)) return "pdf";
  return (attachment.name ?? "").toLowerCase().endsWith(".pdf") ? "pdf" : "document";
}
