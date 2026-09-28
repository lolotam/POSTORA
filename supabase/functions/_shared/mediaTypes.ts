/**
 * Media allow-list shared by the browser and the edge functions.
 * supabase/functions/_shared/mediaTypes.ts must stay byte-identical — a Deno
 * test reads both files. WhatsApp Cloud sendability is recorded here for the
 * later scheduling PR; this PR only stores and displays the flag.
 */

export const MEDIA_DECODED_BYTE_CAP = 10 * 1024 * 1024;
export const MEDIA_JSON_BODY_BYTE_CAP = 14 * 1024 * 1024;

export const EXCLUDED_EXTENSIONS = ["exe", "html", "htm", "xml", "avi"] as const;

export type MediaKind = "image" | "video" | "audio" | "document" | "archive";
export type StoredFileType = "image" | "video" | "audio" | "document";
export type MediaIcon =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "word"
  | "excel"
  | "powerpoint"
  | "text"
  | "code"
  | "archive";
export type LibraryFilter = "all" | "image" | "video" | "audio" | "document" | "archive";
export type UploadFileType = "image" | "video" | "audio" | "document";

export interface MediaTypeEntry {
  mime: string;
  kind: MediaKind;
  storedFileType: StoredFileType;
  icon: MediaIcon;
  maxBytes: number;
  whatsappCloud: boolean;
}

export interface LibraryFileLike {
  file_type: string;
  file_path: string;
  mime_type?: string | null;
  metadata?: { kind?: unknown; original_filename?: unknown } | null;
}

const CAP = MEDIA_DECODED_BYTE_CAP;

function entry(
  mime: string,
  kind: MediaKind,
  storedFileType: StoredFileType,
  icon: MediaIcon,
  whatsappCloud: boolean,
): MediaTypeEntry {
  return { mime, kind, storedFileType, icon, maxBytes: CAP, whatsappCloud };
}

export const MEDIA_TYPES: Record<string, MediaTypeEntry> = {
  jpg: entry("image/jpeg", "image", "image", "image", true),
  jpeg: entry("image/jpeg", "image", "image", "image", true),
  png: entry("image/png", "image", "image", "image", true),
  gif: entry("image/gif", "image", "image", "image", false),
  webp: entry("image/webp", "image", "image", "image", false),
  avif: entry("image/avif", "image", "image", "image", false),
  heic: entry("image/heic", "image", "image", "image", false),
  heif: entry("image/heif", "image", "image", "image", false),
  psd: entry("image/vnd.adobe.photoshop", "image", "image", "image", false),
  mp4: entry("video/mp4", "video", "video", "video", true),
  mov: entry("video/quicktime", "video", "video", "video", false),
  webm: entry("video/webm", "video", "video", "video", false),
  mp3: entry("audio/mpeg", "audio", "audio", "audio", true),
  ogg: entry("audio/ogg", "audio", "audio", "audio", true),
  wav: entry("audio/wav", "audio", "audio", "audio", false),
  pdf: entry("application/pdf", "document", "document", "pdf", true),
  doc: entry("application/msword", "document", "document", "word", true),
  docx: entry("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document", "document", "word", true),
  xls: entry("application/vnd.ms-excel", "document", "document", "excel", true),
  xlsx: entry("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document", "document", "excel", true),
  ppt: entry("application/vnd.ms-powerpoint", "document", "document", "powerpoint", true),
  pptx: entry("application/vnd.openxmlformats-officedocument.presentationml.presentation", "document", "document", "powerpoint", true),
  txt: entry("text/plain", "document", "document", "text", true),
  csv: entry("text/csv", "document", "document", "text", false),
  md: entry("text/markdown", "document", "document", "code", false),
  json: entry("application/json", "document", "document", "code", false),
  zip: entry("application/zip", "archive", "document", "archive", false),
  rar: entry("application/vnd.rar", "archive", "document", "archive", false),
  "7z": entry("application/x-7z-compressed", "archive", "document", "archive", false),
  tar: entry("application/x-tar", "archive", "document", "archive", false),
  gz: entry("application/gzip", "archive", "document", "archive", false),
};

const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
};

export function originalBasename(fileName: string): string {
  const trimmed = fileName.trim();
  let path = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      path = trimmed.split("?")[0];
    }
  }
  const withoutQuery = path.split("?")[0].split("#")[0];
  const base = withoutQuery.split(/[/\\]/).filter(Boolean).pop() || "file";
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

export function extensionOfName(fileName: string): string {
  const base = originalBasename(fileName);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isExcludedExtension(extension: string): boolean {
  return (EXCLUDED_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

export function mediaTypeForFileName(name: string): MediaTypeEntry | null {
  const extension = extensionOfName(name);
  if (!extension || isExcludedExtension(extension)) return null;
  return MEDIA_TYPES[extension] ?? null;
}

export function mediaTypeForMime(mime: string | null | undefined): { ext: string; entry: MediaTypeEntry } | null {
  if (!mime) return null;
  const bare = mime.split(";")[0].trim().toLowerCase();
  const normalized = MIME_ALIASES[bare] ?? bare;
  for (const [ext, typeEntry] of Object.entries(MEDIA_TYPES)) {
    if (typeEntry.mime === normalized) return { ext, entry: typeEntry };
  }
  return null;
}

export function acceptedExtensions(): string[] {
  return Object.keys(MEDIA_TYPES);
}

export function dropzoneAccept(): Record<string, string[]> {
  const accept: Record<string, string[]> = {};
  for (const [ext, typeEntry] of Object.entries(MEDIA_TYPES)) {
    const list = accept[typeEntry.mime] ?? [];
    list.push(`.${ext}`);
    accept[typeEntry.mime] = list;
  }
  return accept;
}

export function dedupeEligible(kind: MediaKind): boolean {
  return kind === "image" || kind === "video";
}

export function uploadFileTypeFor(kind: MediaKind): UploadFileType {
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (kind === "document" || kind === "archive") return "document";
  return "image";
}

export function isArchiveFile(file: LibraryFileLike): boolean {
  if (file.metadata?.kind === "archive") return true;
  const named = typeof file.metadata?.original_filename === "string" && file.metadata.original_filename
    ? file.metadata.original_filename
    : file.file_path;
  return mediaTypeForFileName(named)?.kind === "archive";
}

/** Posts accept images and video only. Archives are stored as documents. */
export function isPostableLibraryFile(file: LibraryFileLike): boolean {
  if (isArchiveFile(file)) return false;
  return file.file_type === "image" || file.file_type === "video" || file.file_type === "gif";
}

export function matchesLibraryFilter(file: LibraryFileLike, filter: LibraryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "archive") return isArchiveFile(file);
  if (filter === "document") return file.file_type === "document" && !isArchiveFile(file);
  if (filter === "audio") return file.file_type === "audio";
  if (filter === "image") return file.file_type === "image" || file.file_type === "gif";
  if (filter === "video") return file.file_type === "video";
  return false;
}

export function libraryFilePresentation(file: LibraryFileLike): { kind: MediaKind; icon: MediaIcon; extension: string } {
  const named = typeof file.metadata?.original_filename === "string" && file.metadata.original_filename
    ? file.metadata.original_filename
    : file.file_path;
  const fromName = mediaTypeForFileName(named);
  const extension = extensionOfName(named);
  if (fromName) return { kind: fromName.kind, icon: fromName.icon, extension };
  if (file.metadata?.kind === "archive") return { kind: "archive", icon: "archive", extension };
  const fromMime = mediaTypeForMime(file.mime_type);
  if (fromMime) return { kind: fromMime.entry.kind, icon: fromMime.entry.icon, extension: fromMime.ext };
  if (file.file_type === "audio") return { kind: "audio", icon: "audio", extension };
  if (file.file_type === "video") return { kind: "video", icon: "video", extension };
  if (file.file_type === "document") return { kind: "document", icon: "text", extension };
  return { kind: "image", icon: "image", extension };
}

export function downloadNameFor(file: LibraryFileLike): string {
  const original = file.metadata?.original_filename;
  if (typeof original === "string" && original.trim()) return originalBasename(original);
  return originalBasename(file.file_path);
}

export function librarySearchText(file: LibraryFileLike): string {
  const original = typeof file.metadata?.original_filename === "string" ? file.metadata.original_filename : "";
  return `${file.file_path} ${original}`.toLowerCase();
}
