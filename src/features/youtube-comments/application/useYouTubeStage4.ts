import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { YouTubeCommentsGateway } from "../application/ports";
import { YouTubeCommentsError } from "../domain/errors";
import {
  clearPendingOperation,
  clearPendingOperationsForAccount,
  findPendingOperation,
  listPendingOperations,
  mintOperationId,
  savePendingOperation,
  type PendingStage4Operation,
  type Stage4OperationAction,
} from "../domain/operationIdentity";
import type {
  Stage4CapabilitiesPayload,
  Stage4CommentRow,
  Stage4OperationStatusPayload,
  Stage4ReceiptPayload,
} from "../domain/types";
import { youtubeCommentsKey, YOUTUBE_COMMENTS_STALE_MS } from "./queryKeys";
import { clearSettled, recoverOperation } from "./recoverOperation";
/** The outcome of one deliberate submit, as the composer must show it. */
export type SubmissionOutcome =
  | { kind: "confirmed"; receipt: Stage4ReceiptPayload }
  | { kind: "refused"; reason: string; draftKept: true }
  | { kind: "indeterminate"; receipt: Stage4ReceiptPayload }
  | { kind: "pending"; operationId: string }
  | { kind: "error"; reason: string; draftKept: true };

/** A restored operation from storage, after its status was read. */
export interface RecoveredOperation {
  operation: PendingStage4Operation;
  status: Stage4OperationStatusPayload | null;
  /** True when the local identity was cleared because the outcome is settled. */
  settled: boolean;
  /** True when the status could not be read for a TEMPORARY reason; the identity is kept. */
  unavailable: boolean;
}

export interface Stage4PageState<Item> {
  items: Item[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
  /** Retry only the failed page; earlier rows stay (spec 8.3). */
  retry: () => void;
  reload: () => void;
}

export function useYouTubeStage4(params: {
  userId: string;
  accountId: string;
  gateway: YouTubeCommentsGateway;
}) {
  const { userId, accountId } = params;
  const gateway = params.gateway;
  const queryClient = useQueryClient();

  // ---- capabilities --------------------------------------------------------

  const capabilitiesQuery = useQuery({
    queryKey: youtubeCommentsKey(userId, accountId, "capabilities"),
    queryFn: () => gateway.capabilities(accountId),
    enabled: !!accountId,
    staleTime: YOUTUBE_COMMENTS_STALE_MS,
    retry: false,
  });
  const capabilities: Stage4CapabilitiesPayload | null = capabilitiesQuery.data ?? null;
  const canRead = capabilities?.capabilities.read.allowed === true;
  const canHold = canRead && capabilities?.capabilities.held.allowed === true;
  const canWrite = canRead && capabilities?.capabilities.write.allowed === true;
  const canBan = canWrite && capabilities?.capabilities.ban.allowed === true;

  // Stale-account responses are dropped: a response for a previous selection
  // never reaches the state of the current one (spec 14).
  const guard = useCallback(
    <T extends { account_id: string | null }>(payload: T): T | null =>
      payload.account_id === accountId ? payload : null,
    [accountId],
  );

  // ---- a generic cursor-paged list ------------------------------------------

  function usePagedList<Item extends { key: string }>(listOptions: {
    resource: string;
    enabled: boolean;
    fetchPage: (cursor: string | undefined) => Promise<{ page: Item[]; next: string | null; account_id: string }>;
  }): Stage4PageState<Item> {
    const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
    // Reset the chain whenever the list identity changes.
    const identity = `${accountId}:${listOptions.resource}`;
    const lastIdentity = useRef(identity);
    if (lastIdentity.current !== identity) {
      lastIdentity.current = identity;
      setCursors([undefined]);
    }

    const pages = cursors.map((cursor, index) => ({
      queryKey: youtubeCommentsKey(userId, accountId, listOptions.resource, cursor ?? `page-${index}`),
      queryFn: async (): Promise<{ page: Item[]; next: string | null; stale: boolean }> => {
        const result = await listOptions.fetchPage(cursor);
        return guard(result) ? { page: result.page, next: result.next, stale: false } : { page: [], next: null, stale: true };
      },
      enabled: listOptions.enabled && index === cursors.length - 1,
      staleTime: YOUTUBE_COMMENTS_STALE_MS,
      retry: false,
    }));
    // One query for the live tail page; earlier pages come from the cache via
    // getQueryData, so a failed later page keeps earlier rows (spec 8.3).
    const tail = pages[pages.length - 1];
    const tailQuery = useQuery({
      queryKey: tail.queryKey,
      queryFn: tail.queryFn,
      enabled: tail.enabled,
      staleTime: YOUTUBE_COMMENTS_STALE_MS,
      retry: false,
    });

    const items = useMemo(() => {
      const byKey = new Map<string, Item>();
      for (let i = 0; i < cursors.length; i++) {
        // The live page is the tail; earlier pages are cached snapshots.
        const entry = i === cursors.length - 1
          ? tailQuery.data
          : queryClient.getQueryData<{ page: Item[] } | undefined>(
            youtubeCommentsKey(userId, accountId, listOptions.resource, cursors[i] ?? `page-${i}`),
          );
        for (const item of entry?.page ?? []) byKey.set(item.key, item);
      }
      return [...byKey.values()];
    }, [cursors, tailQuery.data, listOptions.resource]);

    return {
      items,
      nextCursor: tailQuery.data?.next ?? null,
      loading: tailQuery.isLoading || tailQuery.isFetching,
      error: tailQuery.error instanceof Error ? tailQuery.error.message : null,
      loadMore: () => {
        const next = tailQuery.data?.next;
        if (next) setCursors((prev) => [...prev, next]);
      },
      retry: () => void tailQuery.refetch(),
      // Return to the first page and refetch IT explicitly: refetching the
      // current tail would re-run the last page and leave page one stale.
      reload: () => {
        setCursors([undefined]);
        void queryClient.invalidateQueries({ queryKey: pages[0].queryKey });
      },
    };
  }

  // ---- the video picker ------------------------------------------------------

  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [listMode, setListMode] = useState<"published" | "heldForReview">("published");

  const videos = usePagedList({
    resource: "videos",
    enabled: canRead,
    fetchPage: async (cursor) => {
      const page = await gateway.videoPage(accountId, cursor);
      return {
        account_id: page.account_id,
        next: page.next_cursor,
        page: page.items.map((v) => ({ key: v.id, id: v.id, title: v.title, published_at: v.published_at })),
      };
    },
  });

  const effectiveVideoId = selectedVideoId && videos.items.some((v) => v.id === selectedVideoId)
    ? selectedVideoId
    : videos.items[0]?.id ?? null;

  const threads = usePagedList({
    resource: `threads:${effectiveVideoId ?? "-"}:${listMode}`,
    enabled: canRead && !!effectiveVideoId,
    fetchPage: async (cursor) => {
      const page = await gateway.threadPage({ accountId, videoId: effectiveVideoId!, list: listMode, cursor });
      return {
        account_id: page.account_id,
        next: page.next_cursor,
        page: page.items.map((row) => ({ key: row.comment_id, row })),
      };
    },
  });

  // ---- reply paging per thread ------------------------------------------------
  //
  // The controller only tracks WHICH parents are open; each open parent gets
  // its own paged list through useStage4Replies below, so a failure in one
  // thread's replies never touches another's rows.

  const [replyTargetsOpen, setReplyTargetsOpen] = useState<Record<string, boolean>>({});
  const openReplies = useCallback((parentHandle: string) => {
    setReplyTargetsOpen((prev) => ({ ...prev, [parentHandle]: true }));
  }, []);
  const closeReplies = useCallback((parentHandle: string) => {
    setReplyTargetsOpen((prev) => {
      const next = { ...prev };
      delete next[parentHandle];
      return next;
    });
  }, []);

  // ---- submissions -------------------------------------------------------------
  //
  // Identity is persisted BEFORE the first network call and cleared only once
  // its outcome was shown (or can never be read again). A refused submit keeps
  // the draft; an indeterminate one is never re-sent (spec 9.1, 14).

  const [recovered, setRecovered] = useState<RecoveredOperation[]>([]);

  const submit = useCallback(
    async (action: Stage4OperationAction, input: {
      videoId: string;
      targetCommentId?: string;
      targetHandle?: string;
      text?: string;
      status?: "published" | "heldForReview" | "rejected";
      banConfirmation?: string;
      /** A key already bound elsewhere (the ban confirmation); minted otherwise. */
      operationId?: string;
      run: (operationId: string) => Promise<Stage4ReceiptPayload>;
    }): Promise<SubmissionOutcome> => {
      const targetCommentId = input.targetCommentId ?? "";
      const pending = findPendingOperation(userId, { accountId, videoId: input.videoId, action, targetCommentId });
      if (pending) return { kind: "pending", operationId: pending.operationId };

      const operationId = input.operationId ?? mintOperationId();
      savePendingOperation(userId, {
        operationId,
        accountId,
        videoId: input.videoId,
        action,
        targetCommentId,
        createdAt: Date.now(),
      });

      let receipt: Stage4ReceiptPayload;
      try {
        receipt = await input.run(operationId);
      } catch (error) {
        const reason = error instanceof YouTubeCommentsError ? error.code
          : error instanceof Error && error.message ? error.message
          : "upstream";
        // A transport failure after the claim is indeterminate unless the
        // server said otherwise; the local identity stays until status is read.
        if (isShownRefusal(reason)) {
          clearPendingOperation(userId, operationId);
          return { kind: "refused", reason, draftKept: true };
        }
        return { kind: "error", reason, draftKept: true };
      }

      if (receipt.state === "confirmed" || receipt.state === "refused") {
        clearPendingOperation(userId, operationId);
      }
      if (receipt.state === "confirmed") {
        void threads.reload();
      }
      if (receipt.state === "confirmed") return { kind: "confirmed", receipt };
      if (receipt.state === "refused") return { kind: "refused", reason: receipt.reason ?? "upstream", draftKept: true };
      if (receipt.state === "indeterminate") return { kind: "indeterminate", receipt };
      // claimed/dispatched: the browser lost the answer before settlement.
      return { kind: "indeterminate", receipt };
    },
    [userId, accountId, threads],
  );

  const createThread = useCallback(
    (videoId: string, text: string) => submit("create_thread", {
      videoId,
      run: (operationId) => gateway.createThread({ accountId, videoId, text, operationId }),
    }),
    [submit, gateway, accountId],
  );

  const reply = useCallback(
    (videoId: string, target: Stage4CommentRow, text: string) => submit("reply", {
      videoId,
      targetCommentId: target.comment_id,
      run: (operationId) => gateway.reply({ accountId, targetHandle: target.handle, text, operationId }),
    }),
    [submit, gateway, accountId],
  );

  const editComment = useCallback(
    (videoId: string, target: Stage4CommentRow, text: string) => submit("edit", {
      videoId,
      targetCommentId: target.comment_id,
      run: (operationId) => gateway.edit({ accountId, targetHandle: target.handle, text, operationId }),
    }),
    [submit, gateway, accountId],
  );

  const requestBanConfirmation = useCallback(
    async (target: Stage4CommentRow, operationId: string) =>
      gateway.banConfirmation({ accountId, targetHandle: target.handle, operationId }),
    [gateway, accountId],
  );

  const moderate = useCallback(
    (videoId: string, target: Stage4CommentRow, status: "published" | "heldForReview" | "rejected", banConfirmation?: string, operationId?: string) =>
      submit("moderate", {
        videoId,
        targetCommentId: target.comment_id,
        status,
        operationId,
        run: (operationId) => gateway.moderate({ accountId, targetHandle: target.handle, status, operationId, banConfirmation }),
      }),
    [submit, gateway, accountId],
  );

  /** Delete the channel's own comment through the existing delete path, then refresh page one. */
  const deleteOwn = useCallback(
    async (row: Stage4CommentRow): Promise<{ kind: "deleted" } | { kind: "error"; reason: string }> => {
      if (!row.is_own) return { kind: "error", reason: "target_not_owned" };
      try {
        await gateway.deleteOwnComment({ accountId, commentId: row.comment_id });
      } catch (error) {
        return { kind: "error", reason: error instanceof YouTubeCommentsError ? error.code : "upstream" };
      }
      threads.reload();
      return { kind: "deleted" };
    },
    [gateway, accountId, threads],
  );

  const checkStatus = useCallback(
    async (operationId: string) => gateway.operationStatus({ accountId, operationId }),
    [gateway, accountId],
  );

  // ---- recovery on mount and account change ------------------------------------
  //
  // Receipt status is deliberately NOT behind the rollout policy (spec 7.4):
  // with every capability off, an owner can still read the local receipt of
  // an operation under the current binding. No provider read happens here.

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setRecovered([]);
    const pending = listPendingOperations(userId, accountId);
    void (async () => {
      const results: RecoveredOperation[] = [];
      for (const operation of pending) {
        // Only a definite answer clears the identity; a temporary failure
        // keeps it and is shown as "status unavailable", never as "reconnect".
        results.push(await recoverOperation(gateway, accountId, operation));
      }
      // Cleared only once the result is in this view's state: a view torn
      // down mid-read keeps the identity for the next one.
      if (!cancelled) {
        setRecovered(results);
        clearSettled(userId, results);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, accountId, gateway]);

  // An account switch discards every cached list, draft and open context.
  useEffect(() => {
    setSelectedVideoId(null);
    setListMode("published");
    setReplyTargetsOpen({});
  }, [accountId]);

  return {
    userId,
    accountId,
    gateway,
    capabilitiesQuery,
    capabilities,
    canRead,
    canHold,
    canWrite,
    canBan,
    videos,
    effectiveVideoId,
    selectedVideoId,
    setSelectedVideoId,
    listMode,
    setListMode,
    threads,
    replyTargetsOpen,
    openReplies,
    closeReplies,
    createThread,
    reply,
    editComment,
    moderate,
    deleteOwn,
    requestBanConfirmation,
    checkStatus,
    recovered,
    clearRecovered: (operationId: string) => setRecovered((prev) => prev.filter((r) => r.operation.operationId !== operationId)),
    /** Check the status of one recovered operation again (after a temporary failure). */
    recheckRecovered: async (operationId: string) => {
      const current = recovered.find((r) => r.operation.operationId === operationId);
      if (!current) return;
      const next = await recoverOperation(gateway, accountId, current.operation);
      setRecovered((prev) => prev.map((r) => (r.operation.operationId === operationId ? next : r)));
      clearSettled(userId, [next]);
    },
    discardAccountContext: () => clearPendingOperationsForAccount(userId, accountId),
  };
}

/** Reasons whose refusal is definite and was shown, so the identity may go.
 *  Unknown-transport outcomes (upstream, indeterminate) are deliberately NOT
 *  here: their identity stays until operation status has been read. */
function isShownRefusal(reason: string): boolean {
  const shown: string[] = [
    "invalid_request", "not_found", "provider_unsupported", "account_not_connected",
    "account_needs_reauth", "capability_off", "prerequisite_missing", "account_not_admitted",
    "tile_disabled", "rollout_missing", "rollout_invalid", "settings_unavailable",
    "invalid_handle", "expired_handle", "cross_context", "video_not_owned",
    "target_not_verified", "target_not_owned", "target_missing_author",
    "comment_text_required", "comment_text_too_long", "invalid_text",
    "conflict", "possible_duplicate", "recently_posted", "already_recorded",
    "binding_changed", "capability_denied", "ban_confirmation_required",
    "ban_confirmation_invalid", "ban_confirmation_expired", "ban_confirmation_mismatch",
    "comments_disabled", "scope_missing", "quota", "unauthorized_provider",
    "forbidden", "ineligible_account", "not_found_provider", "unauthorized",
    "rate_limited", "service_role_not_allowed",
  ];
  return shown.includes(reason);
}

/**
 * One paged reply list for one parent comment. Every row merges by comment id
 * across inline previews and reply pages; a failed page keeps earlier rows
 * and offers a retry of that page only (spec 8.3).
 */
export function useStage4Replies(params: {
  userId: string;
  accountId: string;
  gateway: YouTubeCommentsGateway;
  parentHandle: string;
  enabled: boolean;
}) {
  const { userId, accountId, gateway, parentHandle, enabled } = params;
  const queryClient = useQueryClient();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);

  const tailIndex = cursors.length - 1;
  const tailQuery = useQuery({
    queryKey: youtubeCommentsKey(userId, accountId, `replies:${parentHandle}`, cursors[tailIndex] ?? `page-${tailIndex}`),
    queryFn: async () => {
      const page = await gateway.replyPage({ accountId, parentHandle, cursor: cursors[tailIndex] });
      if (page.account_id !== accountId) return { page: [], next: null, stale: true };
      return {
        page: page.items.map((row) => ({ key: row.comment_id, row })),
        next: page.next_cursor,
        stale: false,
      };
    },
    enabled,
    staleTime: YOUTUBE_COMMENTS_STALE_MS,
    retry: false,
  });

  const items = useMemo(() => {
    const byKey = new Map<string, { key: string; row: Stage4CommentRow }>();
    for (let i = 0; i < tailIndex; i++) {
      const entry = queryClient.getQueryData<{ page: { key: string; row: Stage4CommentRow }[] } | undefined>(
        youtubeCommentsKey(userId, accountId, `replies:${parentHandle}`, cursors[i] ?? `page-${i}`),
      );
      for (const item of entry?.page ?? []) byKey.set(item.key, item);
    }
    for (const item of tailQuery.data?.page ?? []) byKey.set(item.key, item);
    return [...byKey.values()];
  }, [cursors, tailIndex, tailQuery.data, queryClient, userId, accountId, parentHandle]);

  return {
    items,
    nextCursor: tailQuery.data?.next ?? null,
    loading: tailQuery.isLoading || tailQuery.isFetching,
    error: tailQuery.error instanceof Error ? tailQuery.error.message : null,
    loadMore: () => {
      const next = tailQuery.data?.next;
      if (next) setCursors((prev) => [...prev, next]);
    },
    retry: () => void tailQuery.refetch(),
  };
}
