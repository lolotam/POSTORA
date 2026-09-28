import {
  extensionOfName,
  mediaTypeForFileName,
  mediaTypeForMime,
  originalBasename,
  type MediaKind,
} from "../_shared/mediaTypes.ts";

export type RelayFileType = "image" | "video" | "gif" | "document" | "audio";

function relayFileType(kind: MediaKind, mime: string): RelayFileType {
  if (mime === "image/gif") return "gif";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (kind === "document" || kind === "archive") return "document";
  return "image";
}

/**
 * Name the file the upload function will classify. A supported extension is
 * kept. Anything else is replaced from the content type, or dropped, so the
 * relay never invents `.bin` or another unknown suffix.
 */
export function relayUploadTarget(sourceName: string, contentType?: string | null, idPart = "file"): { fileName: string; fileType: RelayFileType } {
  const trimmed = sourceName.trim();
  const base = trimmed ? originalBasename(trimmed) : "";
  const named = base ? mediaTypeForFileName(base) : null;
  if (named) return { fileName: base, fileType: relayFileType(named.kind, named.mime) };

  const explicit = extensionOfName(base);
  const stem = explicit ? base.slice(0, -(explicit.length + 1)) || idPart : (base || idPart);
  const fromMime = mediaTypeForMime(contentType);
  if (fromMime) {
    return { fileName: `${stem}.${fromMime.ext}`, fileType: relayFileType(fromMime.entry.kind, fromMime.entry.mime) };
  }
  return { fileName: stem, fileType: "image" };
}
