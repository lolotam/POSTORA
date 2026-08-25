import { strToU8, zipSync } from "fflate";
import {
  formatUtc,
  safeFileName,
  TRUNCATION_NOTICE,
  type TranscriptConversation,
} from "./conversationTranscript";

export interface ArchiveChat {
  conversationId: string;
  participantName: string;
  participantPhone: string;
  fileBaseName: string;
  markdown: string;
  messageCount: number;
  truncated: boolean;
}

export interface ArchiveMediaFile {
  fileName: string;
  bytes: Uint8Array;
}

export interface ChatArchiveInput {
  exportedAt: Date;
  accountLabel: string;
  chats: ArchiveChat[];
  mediaFiles?: ArchiveMediaFile[];
  missingMedia?: string[];
}

export function archiveFolderName(exportedAt: Date): string {
  return `postora-whatsapp-export-${formatUtc(exportedAt, "yyyy-MM-dd")}`;
}

export function uniqueFileBaseName(
  participantName: string,
  phone: string,
  used: Set<string>,
): string {
  const desired = safeFileName(participantName, phone);
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  let suffix = 2;
  while (used.has(`${desired}-${suffix}`)) suffix += 1;
  const unique = `${desired}-${suffix}`;
  used.add(unique);
  return unique;
}

export function buildReadme(input: ChatArchiveInput): string {
  const lines = [
    "# Postora WhatsApp export",
    "",
    `- Account: ${input.accountLabel}`,
    `- Exported at: ${input.exportedAt.toISOString()}`,
    `- Chats: ${input.chats.length}`,
    "",
  ];
  if (input.chats.some((chat) => chat.truncated)) {
    lines.push(`> ${TRUNCATION_NOTICE}`, "");
  }
  lines.push("| File | Participant | Messages | Truncated |", "| --- | --- | --- | --- |");
  for (const chat of input.chats) {
    lines.push(
      `| ${chat.fileBaseName}.md | ${chat.participantName} | ${chat.messageCount} | ${chat.truncated ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function buildChatArchive(input: ChatArchiveInput): Uint8Array {
  const folder = archiveFolderName(input.exportedAt);
  const files: Record<string, Uint8Array> = {
    [`${folder}/README.md`]: strToU8(buildReadme(input)),
  };
  for (const chat of input.chats) {
    files[`${folder}/${chat.fileBaseName}.md`] = strToU8(chat.markdown);
  }
  const includeMediaFolder = (input.mediaFiles?.length ?? 0) > 0
    || (input.missingMedia?.length ?? 0) > 0;
  if (includeMediaFolder) {
    for (const media of input.mediaFiles ?? []) {
      files[`${folder}/media/${media.fileName}`] = media.bytes;
    }
    if ((input.missingMedia?.length ?? 0) > 0) {
      files[`${folder}/media/_missing.txt`] = strToU8(`${(input.missingMedia ?? []).join("\n")}\n`);
    }
  }
  return zipSync(files);
}

export function transcriptConversation(
  chat: Pick<ArchiveChat, "conversationId" | "participantName" | "participantPhone">,
  accountLabel: string,
): TranscriptConversation {
  return {
    id: chat.conversationId,
    participantName: chat.participantName,
    participantPhone: chat.participantPhone,
    accountLabel,
  };
}
