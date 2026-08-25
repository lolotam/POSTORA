import { useCallback, useRef, useState } from "react";
import {
  archiveFolderName,
  buildChatArchive,
  transcriptConversation,
  uniqueFileBaseName,
  type ArchiveChat,
  type ArchiveMediaFile,
} from "../domain/chatArchive";
import {
  estimateMediaBytes,
  safeFileName,
  toCsv,
  toMarkdown,
  type TranscriptMessage,
} from "../domain/conversationTranscript";
import { useWhatsAppInboxApi } from "../ui/WhatsAppInboxApiProvider";
import type { MessageCursor, WhatsAppMessage } from "./ports";

/** The server refuses more than ten row ids per whatsapp_get_media call. */
const MEDIA_BATCH_SIZE = 10;
/** Signed-URL downloads run in parallel; four keeps a big export off the connection limit. */
const MEDIA_CONCURRENCY = 4;
const PAGE_SIZE = 100;
/**
 * A ceiling is a safety net, not a silent cap: when it bites, the README and the affected
 * transcript both say so, because an export that quietly stops halfway is worse than one that
 * admits it did.
 */
const MAX_PAGES_PER_CHAT = 200;

export type ExportFormat = "md" | "csv";

export interface ExportChatTarget {
  conversationId: string;
  participantName: string;
  participantPhone: string;
}

export type ExportChatState = "pending" | "fetching" | "done" | "failed";

export interface ExportChatProgress {
  conversationId: string;
  participantName: string;
  state: ExportChatState;
  messagesFetched: number;
  truncated: boolean;
}

export interface ExportProgress {
  totalChats: number;
  chats: ExportChatProgress[];
}

export interface RunExportInput {
  socialAccountId: string;
  accountLabel: string;
  chats: ExportChatTarget[];
  format: ExportFormat;
  includeMedia: boolean;
  exportedAt: Date;
}

interface FetchedChat {
  target: ExportChatTarget;
  messages: WhatsAppMessage[];
  truncated: boolean;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Messages arrive newest-first from the API; a transcript reads oldest-first.
 * Sorting here rather than trusting arrival order keeps the codecs pure.
 */
function toTranscriptMessages(messages: WhatsAppMessage[]): TranscriptMessage[] {
  return [...messages]
    .sort((a, b) => (a.created_time ?? "").localeCompare(b.created_time ?? ""))
    .map((message) => message as unknown as TranscriptMessage);
}

export function useConversationExport() {
  const api = useWhatsAppInboxApi();
  const abortRef = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const patchChat = useCallback((conversationId: string, patch: Partial<ExportChatProgress>) => {
    setProgress((current) => {
      if (!current) return current;
      return {
        ...current,
        chats: current.chats.map((chat) =>
          chat.conversationId === conversationId ? { ...chat, ...patch } : chat,
        ),
      };
    });
  }, []);

  /**
   * Walks the paginated endpoint to the end of the thread. The rendered store holds only what
   * the user scrolled through, so reading from it would silently export a fraction of the chat.
   */
  const fetchWholeChat = useCallback(
    async (
      socialAccountId: string,
      target: ExportChatTarget,
      signal: AbortSignal,
    ): Promise<FetchedChat> => {
      const messages: WhatsAppMessage[] = [];
      const seen = new Set<string>();
      let before: MessageCursor | undefined;
      let truncated = false;

      for (let page = 0; page < MAX_PAGES_PER_CHAT; page += 1) {
        const response = await api.getMessagesPage(
          {
            social_account_id: socialAccountId,
            conversation_id: target.conversationId,
            limit: PAGE_SIZE,
            ...(before ? { before } : {}),
          },
          signal,
        );

        for (const message of response.messages) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          messages.push(message);
        }
        patchChat(target.conversationId, { messagesFetched: messages.length });

        const info = response.page_info;
        if (!info?.has_more || !info.next_before) return { target, messages, truncated };
        before = info.next_before;
        if (page === MAX_PAGES_PER_CHAT - 1) truncated = true;
      }

      return { target, messages, truncated: true };
    },
    [api, patchChat],
  );

  /**
   * Collects media for a chat. A single failed photo must never abort a transcript of
   * thousands of messages, so failures are recorded and the export continues.
   */
  const fetchMediaFor = useCallback(
    async (
      socialAccountId: string,
      fetched: FetchedChat,
      folder: string,
      signal: AbortSignal,
      files: ArchiveMediaFile[],
      missing: string[],
    ) => {
      const rowIds = fetched.messages
        .filter((message) => (message.attachments?.length ?? 0) > 0)
        .map((message) => message.id);
      if (rowIds.length === 0) return;

      for (let i = 0; i < rowIds.length; i += MEDIA_BATCH_SIZE) {
        const batch = rowIds.slice(i, i + MEDIA_BATCH_SIZE);
        const { media } = await api.getMedia(
          { social_account_id: socialAccountId, message_row_ids: batch },
          signal,
        );

        const downloadable = media.filter((item) => item.url);
        for (let j = 0; j < downloadable.length; j += MEDIA_CONCURRENCY) {
          const slice = downloadable.slice(j, j + MEDIA_CONCURRENCY);
          await Promise.all(
            slice.map(async (item) => {
              try {
                const response = await fetch(item.url as string, { signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const bytes = new Uint8Array(await response.arrayBuffer());
                files.push({ fileName: `${folder}/${item.message_row_id}`, bytes });
              } catch (error) {
                if (isAbort(error)) throw error;
                missing.push(`${folder}/${item.message_row_id}`);
              }
            }),
          );
        }
        for (const item of media) {
          if (!item.url) missing.push(`${folder}/${item.message_row_id}`);
        }
      }
    },
    [api],
  );

  const runExport = useCallback(
    async (input: RunExportInput): Promise<boolean> => {
      const controller = new AbortController();
      abortRef.current = controller;
      setIsExporting(true);
      setProgress({
        totalChats: input.chats.length,
        chats: input.chats.map((chat) => ({
          conversationId: chat.conversationId,
          participantName: chat.participantName,
          state: "pending",
          messagesFetched: 0,
          truncated: false,
        })),
      });

      const usedNames = new Set<string>();
      const archiveChats: ArchiveChat[] = [];
      const mediaFiles: ArchiveMediaFile[] = [];
      const missingMedia: string[] = [];

      try {
        for (const target of input.chats) {
          patchChat(target.conversationId, { state: "fetching" });
          let fetched: FetchedChat;
          try {
            fetched = await fetchWholeChat(input.socialAccountId, target, controller.signal);
          } catch (error) {
            if (isAbort(error)) throw error;
            patchChat(target.conversationId, { state: "failed" });
            continue;
          }

          const fileBaseName = uniqueFileBaseName(
            target.participantName,
            target.participantPhone,
            usedNames,
          );
          const conversation = transcriptConversation(
            {
              conversationId: target.conversationId,
              participantName: target.participantName,
              participantPhone: target.participantPhone,
            },
            input.accountLabel,
          );
          const messages = toTranscriptMessages(fetched.messages);

          if (input.includeMedia) {
            await fetchMediaFor(
              input.socialAccountId,
              fetched,
              fileBaseName,
              controller.signal,
              mediaFiles,
              missingMedia,
            );
          }

          archiveChats.push({
            conversationId: target.conversationId,
            participantName: target.participantName,
            participantPhone: target.participantPhone,
            fileBaseName,
            markdown: toMarkdown(conversation, messages, { truncated: fetched.truncated }),
            messageCount: messages.length,
            truncated: fetched.truncated,
          });
          patchChat(target.conversationId, {
            state: "done",
            messagesFetched: messages.length,
            truncated: fetched.truncated,
          });

          // A single chat downloads as one file; only a multi-chat export becomes an archive.
          if (input.chats.length === 1) {
            const single = archiveChats[0];
            const body = input.format === "csv"
              ? toCsv(conversation, messages)
              : single.markdown;
            const mime = input.format === "csv" ? "text/csv;charset=utf-8" : "text/markdown;charset=utf-8";
            api.downloadBlob(new Blob([body], { type: mime }), `${single.fileBaseName}.${input.format}`);
            return true;
          }
        }

        if (archiveChats.length === 0) return false;

        const zipped = buildChatArchive({
          exportedAt: input.exportedAt,
          accountLabel: input.accountLabel,
          chats: archiveChats,
          mediaFiles: input.includeMedia ? mediaFiles : undefined,
          missingMedia: missingMedia.length > 0 ? missingMedia : undefined,
        });
        api.downloadBlob(
          new Blob([zipped as BlobPart], { type: "application/zip" }),
          `${archiveFolderName(input.exportedAt)}.zip`,
        );
        return true;
      } catch (error) {
        if (isAbort(error)) return false;
        throw error;
      } finally {
        abortRef.current = null;
        setIsExporting(false);
      }
    },
    [api, fetchMediaFor, fetchWholeChat, patchChat],
  );

  return { runExport, cancel, progress, isExporting, estimateMediaBytes, safeFileName };
}
