import { format } from "date-fns";
import Papa from "papaparse";

export interface TranscriptConversation {
  id: string;
  participantName: string;
  participantPhone: string;
  accountLabel: string;
}

export interface TranscriptAttachment {
  kind: "image" | "video" | "audio" | "document";
  message_row_id: string;
  mime_type: string | null;
  name: string | null;
  duration_seconds?: number | null;
}

export interface TranscriptMessage {
  id: string;
  message: string;
  from: { name: string; id: string };
  created_time: string;
  direction?: string | null;
  status?: string | null;
  provider_message_id?: string | null;
  revoked_at?: string | null;
  attachments: TranscriptAttachment[];
}

export interface TranscriptOptions {
  mediaIndex?: Map<string, string>;
  truncated?: boolean;
  exportedAt?: Date;
}

export const CSV_COLUMNS = [
  "timestamp",
  "direction",
  "from_name",
  "from_phone",
  "message_type",
  "message_text",
  "media_file",
  "provider_message_id",
  "status",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const TRUNCATION_NOTICE =
  "This export is truncated. Older messages were omitted because a safety limit on history pages was reached.";

const MEDIA_BYTE_ESTIMATE: Record<TranscriptAttachment["kind"], number> = {
  image: 400_000,
  video: 3_000_000,
  audio: 250_000,
  document: 500_000,
};

// The control-character range is the point, not an oversight: a participant name arrives
// from WhatsApp and can carry anything, and a NUL or escape sequence inside a zip entry
// name is a path-injection hazard on some extractors. eslint's no-control-regex cannot
// tell a sanitiser from a mistake, so it is silenced rather than the range dropped.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export function formatUtc(date: Date, pattern: string): string {
  // date-fns format() is local-TZ; export transcripts must be identical in every timezone.
  return format(new Date(date.getTime() + date.getTimezoneOffset() * 60_000), pattern);
}

export function estimateMediaBytes(messages: readonly TranscriptMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const attachment of message.attachments) {
      total += MEDIA_BYTE_ESTIMATE[attachment.kind] ?? 250_000;
    }
  }
  return total;
}

export function safeFileName(participantName: string, phone: string): string {
  const last4 = digitsOf(phone).slice(-4) || "0000";
  const cleaned = participantName
    .normalize("NFKC")
    .replace(UNSAFE_FILE_CHARS, "-")
    // Every dot goes, not just the leading and trailing ones. Anchored strips leave the
    // interior run intact -- "../../etc/passwd" survived as "-..-etc-passwd" -- and the
    // archive appends its own extension, so a base name never needs a dot of its own.
    .replace(/\.+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[-\s]+|[-\s]+$/g, "")
    .trim();
  const chars = Array.from(cleaned || "chat").slice(0, 80);
  const base = chars.join("") || "chat";
  return `${base}-${last4}`;
}

export function toMarkdown(
  conversation: TranscriptConversation,
  messages: readonly TranscriptMessage[],
  opts: TranscriptOptions = {},
): string {
  const ordered = chronological(messages);
  const exportedAt = (opts.exportedAt ?? new Date()).toISOString();
  const lines = [
    "---",
    `participant: ${yamlScalar(conversation.participantName)}`,
    `phone: ${yamlScalar(conversation.participantPhone)}`,
    `account: ${yamlScalar(conversation.accountLabel)}`,
    `exported_at: ${exportedAt}`,
    `message_count: ${ordered.length}`,
    `truncated: ${opts.truncated ? "true" : "false"}`,
    "---",
    "",
  ];
  if (opts.truncated) {
    lines.push(`> ${TRUNCATION_NOTICE}`, "");
  }

  let lastDay = "";
  for (const message of ordered) {
    const day = formatMessageDay(message.created_time);
    if (day !== lastDay) {
      lines.push(`## ${day}`, "");
      lastDay = day;
    }
    lines.push(markdownLine(message, conversation, opts.mediaIndex));
    const mediaLines = markdownMedia(message, opts.mediaIndex);
    if (mediaLines.length > 0 && message.message.trim() && !message.revoked_at) {
      lines.push(...mediaLines);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function toCsvRows(
  conversation: TranscriptConversation,
  messages: readonly TranscriptMessage[],
): Array<Record<CsvColumn, string>> {
  return chronological(messages).map((message) => {
    const direction = messageDirection(message, conversation);
    const mediaFile = primaryAttachment(message);
    return {
      timestamp: message.created_time,
      direction,
      from_name: message.from.name,
      from_phone: message.from.id,
      message_type: messageType(message),
      message_text: message.revoked_at ? "" : message.message,
      media_file: mediaFile?.name ?? "",
      provider_message_id: message.provider_message_id ?? "",
      status: message.status ?? "",
    };
  });
}

export function toCsv(
  conversation: TranscriptConversation,
  messages: readonly TranscriptMessage[],
): string {
  const rows = toCsvRows(conversation, messages);
  return Papa.unparse({
    fields: [...CSV_COLUMNS],
    data: rows.map((row) => CSV_COLUMNS.map((column) => row[column])),
  });
}

function chronological(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return [...messages].sort((left, right) => {
    const byTime = Date.parse(left.created_time) - Date.parse(right.created_time);
    if (byTime !== 0) return byTime;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function markdownLine(
  message: TranscriptMessage,
  conversation: TranscriptConversation,
  mediaIndex: Map<string, string> | undefined,
): string {
  const time = formatMessageTime(message.created_time);
  const name = message.from.name || conversation.participantName || "Unknown";
  if (message.revoked_at) return `**${time}** — ${name}: ~~deleted~~`;
  const body = message.message.trim();
  if (body) return `**${time}** — ${name}: ${body}`;
  const media = markdownMedia(message, mediaIndex);
  if (media.length === 1) return `**${time}** — ${name}: ${media[0]}`;
  if (media.length > 1) return `**${time}** — ${name}:`;
  return `**${time}** — ${name}:`;
}

function markdownMedia(
  message: TranscriptMessage,
  mediaIndex: Map<string, string> | undefined,
): string[] {
  if (message.revoked_at) return [];
  return message.attachments.map((attachment) => {
    const file = mediaIndex?.get(attachment.message_row_id);
    if (file) return includedMediaLink(attachment, file);
    return omittedMediaPlaceholder(attachment);
  });
}

function includedMediaLink(attachment: TranscriptAttachment, file: string): string {
  const href = `media/${file}`;
  if (attachment.kind === "image") return `![img](${href})`;
  if (attachment.kind === "audio") return `[voice note ${formatDuration(attachment.duration_seconds)}](${href})`;
  if (attachment.kind === "video") return `[video](${href})`;
  const label = attachment.name || "document";
  return `[${label}](${href})`;
}

function omittedMediaPlaceholder(attachment: TranscriptAttachment): string {
  if (attachment.kind === "image") return "_[image]_";
  if (attachment.kind === "audio") return "_[voice note]_";
  if (attachment.kind === "video") return "_[video]_";
  return "_[document]_";
}

function messageType(message: TranscriptMessage): string {
  if (message.revoked_at) return "deleted";
  const attachment = primaryAttachment(message);
  if (attachment) return attachment.kind;
  return "text";
}

function messageDirection(message: TranscriptMessage, conversation: TranscriptConversation): string {
  if (message.direction === "inbound" || message.direction === "outbound") return message.direction;
  const from = digitsOf(message.from.id);
  const participant = digitsOf(conversation.participantPhone);
  if (from && participant && from === participant) return "inbound";
  return "outbound";
}

function primaryAttachment(message: TranscriptMessage): TranscriptAttachment | undefined {
  return message.attachments[0];
}

function formatMessageDay(iso: string): string {
  const date = parsedDate(iso);
  return date ? formatUtc(date, "yyyy-MM-dd") : "unknown";
}

function formatMessageTime(iso: string): string {
  const date = parsedDate(iso);
  return date ? formatUtc(date, "HH:mm") : "--:--";
}

function parsedDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function yamlScalar(value: string): string {
  if (value.length === 0) return '""';
  if (/[:#\n]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}
