import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { YouTubeCommentsGateway } from "../application/ports";
import { YouTubeCommentsError } from "../domain/errors";
import {
  clearPendingOperation,
  clearPendingOperationsForAccount,
  findPendingOperations,
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
import { clearSettled, readOperationStatus, recoverOperation } from "./recoverOperation";
import { createStage4DraftStore } from "./stage4Drafts";
/** The outcome of one deliberate submit, as the composer must show it. */
export type SubmissionOutcome =
  | { kind: "confirmed"; receipt: Stage4ReceiptPayload; operationId: string }
  | { kind: "refused"; reason: string; draftKept: true; operationId: string }
  | {
    kind: "indeterminate";
    receipt: Stage4ReceiptPayload;
    operationId: string;
    /** What a status check compared against the draft (an edit), kept apart from the receipt state. */
    observation?: Stage4OperationStatusPayload["observation"];
  }
  | { kind: "pending"; operationId?: string }
  | { kind: "cancelled" }
  /**
   * The pre-submit check found that an EARLIER submit of the owner's has since
   * settled. Its result is shown first; what was typed now was not sent, and a
   * new key is minted only by the next deliberate submit (spec 9.1).
   */
  | { kind: "earlier"; state: "confirmed" | "refused"; reason: string | null; operationId: string }
  /** A failure with no receipt (a lost response): the operation id is what a status check needs. */
  | {
    kind: "error";
    reason: string;
    draftKept: true;
    operationId: string;
    /**
     * Set when a status check learned that the receipt can never be read again
     * (the binding changed). A surface that shows it acknowledges the identity;
     * an error without it (a lost answer, a miss inside the pre-claim grace)
     * keeps the identity so the check can be repeated.
     */
    terminal?: true;
  };

/** A restored operation from storage, after its status was read. */
export interface RecoveredOperation {
  operation: PendingStage4Operation;
  status: Stage4OperationStatusPayload | null;
  /** True when the local identity was cleared because the outcome is settled. */
  settled: boolean;
  /** True when the status could not be read for a TEMPORARY reason; the identity is kept. */
  unavailable: boolean;
  /** True when the receipt is still claimed or dispatched. */
  inFlight: boolean;
}

/** One submit's claim on a target while it runs. */
interface SubmitLock {
  /** The operation this submit minted; null while it is still recovering earlier ones. */
  operationId: string | null;
  /** The context epoch the lock was taken in. */
  epoch: number;
  isStillCurrent: () => boolean;
}

export interface Stage4PageState<Item> {
  items: Item[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  /** The stable refusal reason of the failed page, when the server named one. */
  errorCode: string | null;
  /** The channel binding the first page was read under; null until it is read (or for lists that carry none). */
  bindingGeneration: number | null;
  /** When the first page last finished loading (0 until it has); it moves on every reload. */
  firstPageUpdatedAt: number;
  /** When the read that produced the row of this key finished (0 for a key that is not loaded). */
  readAtOf: (key: string) => number;
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
    userId: string;
    accountId: string;
    resource: string;
    enabled: boolean;
    fetchPage: (cursor: string | undefined) => Promise<{ page: Item[]; next: string | null; account_id: string; binding_generation?: number }>;
  }): Stage4PageState<Item> {
    const listQueryClient = useQueryClient();
    const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
    // Reset the chain whenever the list identity changes: a cursor is signed
    // for one user and account, and a hook that stays mounted across a user
    // switch must never submit the previous user's cursor.
    const identity = `${listOptions.userId}:${listOptions.accountId}:${listOptions.resource}`;
    const lastIdentity = useRef(identity);
    if (lastIdentity.current !== identity) {
      lastIdentity.current = identity;
      setCursors([undefined]);
    }

    const pages = cursors.map((cursor, index) => ({
      queryKey: youtubeCommentsKey(listOptions.userId, listOptions.accountId, listOptions.resource, cursor ?? `page-${index}`),
      queryFn: async (): Promise<{ page: Item[]; next: string | null; stale: boolean; generation: number | null }> => {
        const result = await listOptions.fetchPage(cursor);
        return guard(result)
          ? { page: result.page, next: result.next, stale: false, generation: result.binding_generation ?? null }
          : { page: [], next: null, stale: true, generation: null };
      },
      // Only the live tail fetches. Every earlier page still has an OBSERVER
      // (a disabled one), which is what keeps its cache entry alive for as
      // long as the list is mounted: an unobserved entry is garbage-collected
      // after ten minutes and a long list would lose rows (spec 8.3).
      enabled: listOptions.enabled && index === cursors.length - 1,
      staleTime: YOUTUBE_COMMENTS_STALE_MS,
      retry: false,
    }));
    const pageQueries = useQueries({ queries: pages });
    const tailQuery = pageQueries[pageQueries.length - 1];

    const { items, readAt } = useMemo(() => {
      const byKey = new Map<string, Item>();
      const readAtByKey = new Map<string, number>();
      for (const query of pageQueries) {
        for (const item of query.data?.page ?? []) {
          // The copy read last wins, whatever page it came from.
          const readAt = readAtByKey.get(item.key);
          if (readAt === undefined || query.dataUpdatedAt >= readAt) {
            byKey.set(item.key, item);
            readAtByKey.set(item.key, query.dataUpdatedAt);
          }
        }
      }
      return { items: [...byKey.values()], readAt: readAtByKey };
    }, [pageQueries]);

    return {
      items,
      readAtOf: (key: string) => readAt.get(key) ?? 0,
      nextCursor: tailQuery.data?.next ?? null,
      loading: tailQuery.isLoading || tailQuery.isFetching,
      error: tailQuery.error instanceof YouTubeCommentsError ? tailQuery.error.code
        : tailQuery.error instanceof Error ? tailQuery.error.message : null,
      errorCode: tailQuery.error instanceof YouTubeCommentsError ? tailQuery.error.code : null,
      bindingGeneration: pageQueries[0]?.data?.generation ?? null,
      firstPageUpdatedAt: pageQueries[0]?.dataUpdatedAt ?? 0,
      loadMore: () => {
        const next = tailQuery.data?.next;
        if (next) setCursors((prev) => [...prev, next]);
      },
      retry: () => void tailQuery.refetch(),
      // Return to the first page and refetch IT explicitly: refetching the
      // current tail would re-run the last page and leave page one stale.
      reload: () => {
        setCursors([undefined]);
        void listQueryClient.invalidateQueries({ queryKey: pages[0].queryKey });
      },
    };
  }

  // ---- the video picker ------------------------------------------------------

  const [selectedVideoState, setSelectedVideoState] = useState<{ accountId: string; videoId: string | null } | null>(null);
  const selectedVideoId = selectedVideoState?.accountId === accountId ? selectedVideoState.videoId : null;
  const setSelectedVideoId = useCallback(
    (videoId: string | null) => {
      setSelectedVideoState({ accountId, videoId });
    },
    [accountId],
  );
  const [listMode, setListMode] = useState<"published" | "heldForReview">("published");

  const videos = usePagedList({
    userId,
    accountId,
    resource: "videos",
    enabled: canRead,
    fetchPage: async (cursor) => {
      const page = await gateway.videoPage(accountId, cursor);
      return {
        account_id: page.account_id,
        next: page.next_cursor,
        page: page.items.map((v) => ({
          key: v.id,
          id: v.id,
          title: v.title,
          published_at: v.published_at ?? null,
          thumbnail_url: v.thumbnail_url ?? null,
          description: v.description ?? null,
          visibility: v.visibility ?? null,
          date_kind: v.date_kind ?? null,
          duration_iso: v.duration_iso ?? null,
          view_count: v.view_count ?? null,
          comment_count: v.comment_count ?? null,
          is_short: v.is_short ?? null,
        })),
      };
    },
  });

  const effectiveVideoId = selectedVideoId ?? videos.items[0]?.id ?? null;

  const threads = usePagedList({
    userId,
    accountId,
    resource: `threads:${effectiveVideoId ?? "-"}:${listMode}`,
    enabled: canRead && !!effectiveVideoId,
    fetchPage: async (cursor) => {
      const page = await gateway.threadPage({ accountId, videoId: effectiveVideoId!, list: listMode, cursor });
      return {
        account_id: page.account_id,
        binding_generation: page.binding_generation,
        next: page.next_cursor,
        page: page.items.map((row) => ({ key: row.comment_id, row })),
      };
    },
  });
  // Every time the thread list has been read again (the Refresh button, and the
  // reload every confirmed action triggers) the OPEN reply pages are read again
  // too. It happens when the list has LANDED, not when the reload starts: only
  // then do the parents carry their new sealed handles. The epoch is what an
  // open thread's replies watch for.
  const [repliesEpoch, setRepliesEpoch] = useState(0);
  const firstPageUpdatedAt = threads.firstPageUpdatedAt;
  const seenListUpdate = useRef(firstPageUpdatedAt);
  useEffect(() => {
    if (seenListUpdate.current === firstPageUpdatedAt) return;
    seenListUpdate.current = firstPageUpdatedAt;
    setRepliesEpoch((epoch) => epoch + 1);
  }, [firstPageUpdatedAt]);

  // ---- drafts ---------------------------------------------------------------------
  //
  // What the owner typed into a reply or edit editor lives here, outside the row
  // that shows it: a Refresh returns every reply chain to page one and unmounts
  // the rows of the later pages. Memory only (comment text is never stored). A
  // draft written under another binding generation is forgotten when the list
  // reports the new one.
  const drafts = useMemo(() => createStage4DraftStore(), []);
  const listGeneration = threads.bindingGeneration;
  useEffect(() => {
    if (listGeneration !== null) drafts.keepGeneration(listGeneration);
  }, [drafts, listGeneration]);

  // ---- reply paging per thread ------------------------------------------------
  //
  // The controller only tracks WHICH parents are open; each open parent gets
  // its own paged list through useStage4Replies below, so a failure in one
  // thread's replies never touches another's rows.

  // A parent is identified by its comment id, which is stable. Its sealed
  // handle is issued again, new, on every list load, so a handle-keyed entry
  // would silently close a thread the owner opened whenever a reload (every
  // confirmed write triggers one) lands.
  const [replyTargetsOpen, setReplyTargetsOpen] = useState<Record<string, boolean>>({});
  const openReplies = useCallback((parentCommentId: string) => {
    setReplyTargetsOpen((prev) => ({ ...prev, [parentCommentId]: true }));
  }, []);
  const closeReplies = useCallback((parentCommentId: string) => {
    setReplyTargetsOpen((prev) => {
      const next = { ...prev };
      delete next[parentCommentId];
      return next;
    });
  }, []);

  // ---- submissions -------------------------------------------------------------
  //
  // Identity is persisted BEFORE the first network call and cleared only once
  // its outcome was shown (or can never be read again). A refused submit keeps
  // the draft; an indeterminate one is never re-sent (spec 9.1, 14).

  const [recovered, setRecoveredState] = useState<RecoveredOperation[]>([]);
  // What the owner can see right now, read after an await: a re-check that
  // finishes for a banner the owner has since dismissed has shown nothing.
  // The ref is written in the SAME call that queues the state update, never
  // by a later render: an answer that lands between a dismissal and the next
  // render would otherwise still find the dismissed entry.
  const recoveredRef = useRef(recovered);
  const setRecovered = useCallback((next: RecoveredOperation[]) => {
    recoveredRef.current = next;
    setRecoveredState(next);
  }, []);
  // One entry per target while a submit for it runs. The id stays null until
  // this submit mints its own operation; object identity and epoch protect a
  // newer submit's lock after a rapid context switch.
  const submitsInFlight = useRef(new Map<string, SubmitLock>());
  const aliveRef = useRef(true);
  const contextRef = useRef(`${userId}:${accountId}`);
  const activeVideoIdRef = useRef<string | null>(effectiveVideoId);
  const contextEpochRef = useRef(0);
  // Published in a layout effect so uncommitted renders never advance the
  // epoch, while every committed user, account or video switch bumps it before
  // any asynchronous recovery continuation can resume.
  useLayoutEffect(() => {
    const nextContext = `${userId}:${accountId}`;
    const accountChanged = contextRef.current !== nextContext;
    const videoChanged = effectiveVideoId !== null
      && activeVideoIdRef.current !== null
      && activeVideoIdRef.current !== effectiveVideoId;
    contextRef.current = nextContext;
    if (accountChanged) {
      activeVideoIdRef.current = effectiveVideoId;
      contextEpochRef.current += 1;
    } else if (effectiveVideoId !== null) {
      activeVideoIdRef.current = effectiveVideoId;
      if (videoChanged) contextEpochRef.current += 1;
    }
  }, [userId, accountId, effectiveVideoId]);
  useLayoutEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const submit = useCallback(
    async (action: Stage4OperationAction, input: {
      videoId: string;
      targetCommentId?: string;
      legacyTargetCommentId?: string;
      targetThreadId?: string;
      targetIsCanonicalParent?: boolean;
      targetHandle?: string;
      text?: string;
      status?: "published" | "heldForReview" | "rejected";
      banConfirmation?: string;
      /** A key already bound elsewhere (the ban confirmation); minted otherwise. */
      operationId?: string;
      isCurrent?: () => boolean;
      run: (operationId: string) => Promise<Stage4ReceiptPayload>;
    }): Promise<SubmissionOutcome> => {
      if (activeVideoIdRef.current === null) activeVideoIdRef.current = input.videoId;
      const submitContext = `${userId}:${accountId}`;
      const submitEpoch = contextEpochRef.current;
      const isStillCurrent = () => aliveRef.current
        && contextRef.current === submitContext
        && contextEpochRef.current === submitEpoch
        && (activeVideoIdRef.current === null || activeVideoIdRef.current === input.videoId)
        && (input.isCurrent ? input.isCurrent() : true);
      if (!isStillCurrent()) return { kind: "cancelled" };
      const targetCommentId = input.targetCommentId ?? "";
      const guardKey = `${accountId}|${input.videoId}|${action}|${targetCommentId}`;
      const pendingForTarget = (): PendingStage4Operation[] => {
        const loadedRows = threads.items.map((item) => item.row);
        return findPendingOperations(userId, { accountId, videoId: input.videoId, action })
          .filter((op) => matchesPendingTarget(op, action, targetCommentId, input.legacyTargetCommentId, input.targetThreadId, loadedRows));
      };
      // One submit per target at a time: a second click while the first is
      // still recovering or sending is answered as pending and sends nothing.
      // Recovery has no NEW operation id to check yet.
      const existingLock = submitsInFlight.current.get(guardKey);
      if (existingLock && blocksNewSubmit(existingLock, submitEpoch)) return pendingOutcomeFor(existingLock);
      const submitLock: SubmitLock = { operationId: null, epoch: submitEpoch, isStillCurrent };
      try {
        submitsInFlight.current.set(guardKey, submitLock);
        // An earlier submit for this target blocks a new one only while it may
        // still land (claimed or dispatched) or cannot be read right now. An
        // INDETERMINATE one stays guarded by the server's fence for the
        // original (the same logical create or reply is refused while it is
        // unresolved), so a different text, a deliberate new edit or a new
        // reject is a new intent and gets its own key (spec 9.1 and 9.3).
        for (const earlier of pendingForTarget()) {
          const recovery = await recoverOperation(gateway, accountId, earlier);
          if (!isStillCurrent()) return { kind: "cancelled" };
          if (recovery.inFlight || recovery.unavailable) return { kind: "pending", operationId: earlier.operationId };
          if (recovery.settled && recovery.status) {
            // A result the owner never saw: show it, and keep its identity until
            // the surface that shows it acknowledges it. Nothing new is sent in
            // the same click.
            if (recovery.status.state === "confirmed") void threads.reload();
            return {
              kind: "earlier",
              state: recovery.status.state as "confirmed" | "refused",
              reason: recovery.status.reason,
              operationId: earlier.operationId,
            };
          }
          // Unreadable for good (the binding changed): there is nothing to show.
          if (recovery.settled) clearPendingOperation(userId, earlier.operationId);
        }

        if (!isStillCurrent()) return { kind: "cancelled" };
        const operationId = input.operationId ?? mintOperationId();
        submitLock.operationId = operationId;
        const identity: PendingStage4Operation = {
          operationId,
          accountId,
          videoId: input.videoId,
          action,
          targetCommentId,
          ...(action === "reply" && input.targetIsCanonicalParent ? { targetIsCanonicalParent: true } : {}),
          createdAt: Date.now(),
        };
        savePendingOperation(userId, identity);

        let receipt: Stage4ReceiptPayload;
        try {
          receipt = await input.run(operationId);
        } catch (error) {
          return failedOutcome(error, operationId);
        }

        // The identity is NOT cleared here. Only a surface that shows the
        // outcome acknowledges it (see `acknowledge`): a response that lands
        // after its composer is gone leaves the identity for the recovery
        // banner of the next view instead of losing the only reference.
        if (receipt.state === "confirmed" && isStillCurrent()) {
          void threads.reload();
        }
        return outcomeForReceipt(receipt, operationId);
      } finally {
        if (submitsInFlight.current.get(guardKey) === submitLock) submitsInFlight.current.delete(guardKey);
      }
    },
    [userId, accountId, threads, gateway],
  );

  /** A surface that has shown this operation's outcome forgets its identity. */
  const acknowledge = useCallback(
    (operationId: string) => {
      clearPendingOperation(userId, operationId);
    },
    [userId],
  );

  const createThread = useCallback(
    (videoId: string, text: string, isCurrent?: () => boolean) => submit("create_thread", {
      videoId,
      isCurrent,
      run: (operationId) => gateway.createThread({ accountId, videoId, text, operationId }),
    }),
    [submit, gateway, accountId],
  );

  const reply = useCallback(
    (videoId: string, target: Stage4CommentRow, text: string, isCurrent?: () => boolean) => {
      const canonicalParentId = target.canonical_parent_id.trim();
      return submit("reply", {
        videoId,
        targetCommentId: canonicalParentId || target.comment_id,
        targetIsCanonicalParent: target.kind === "thread" || canonicalParentId.length > 0,
        legacyTargetCommentId: target.comment_id,
        targetThreadId: target.thread_id.trim(),
        isCurrent,
        run: (operationId) => gateway.reply({ accountId, targetHandle: target.handle, text, operationId }),
      });
    },
    [submit, gateway, accountId],
  );

  const editComment = useCallback(
    (videoId: string, target: Stage4CommentRow, text: string, isCurrent?: () => boolean) => submit("edit", {
      videoId,
      targetCommentId: target.comment_id,
      isCurrent,
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
    (videoId: string, target: Stage4CommentRow, status: "published" | "heldForReview" | "rejected", banConfirmation?: string, operationId?: string, isCurrent?: () => boolean) =>
      submit("moderate", {
        videoId,
        targetCommentId: target.comment_id,
        status,
        operationId,
        isCurrent,
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

  /**
   * Read one operation's receipt again (a lost response, an indeterminate
   * outcome). It reads only, never resends, and answers in the same shape as
   * a submit so the composer shows it the same way.
   */
  const checkStatus = useCallback(
    async (operationId: string, draftText?: string): Promise<SubmissionOutcome> => {
      // The same rules as the automatic recovery: it is the same read, through
      // the same function. A `not_found` right after the submit is still inside
      // the pre-claim grace window and keeps the identity; a settled answer is
      // definite. The local identity says what the operation was, which decides
      // whether the draft is sent along for the edit comparison.
      // The shared identity store covers both durable storage and its memory
      // fallback. With neither, nothing is invented: the status is read with no
      // draft (the action is unknown) and a miss stays temporary.
      const operation = listPendingOperations(userId, accountId).find((op) => op.operationId === operationId);
      const result = operation
        ? await recoverOperation(gateway, accountId, operation, operation.action === "edit" ? draftText : undefined)
        : await readOperationStatus(gateway, accountId, operationId, undefined, false);
      const status = result.status;
      if (!status) {
        // Not readable yet: the owner can check again. Unreadable for good (the
        // binding changed): final, and the surface that shows it acknowledges it.
        if (result.unavailable) return { kind: "error", reason: "upstream", draftKept: true, operationId };
        return { kind: "error", reason: "not_found", draftKept: true, operationId, terminal: true };
      }
      if (status.state === "confirmed") {
        void threads.reload();
        return { kind: "confirmed", receipt: status as Stage4ReceiptPayload, operationId };
      }
      if (status.state === "refused") return { kind: "refused", reason: status.reason ?? "upstream", draftKept: true, operationId };
      if (status.state === "indeterminate") {
        return { kind: "indeterminate", receipt: status as Stage4ReceiptPayload, operationId, observation: status.observation };
      }
      return { kind: "pending", operationId };
    },
    [gateway, accountId, userId, threads],
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
  }, [userId, accountId, gateway, setRecovered]);

  // An account switch discards every cached list, draft and open context.
  useEffect(() => {
    setSelectedVideoState(null);
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
    drafts,
    repliesEpoch,
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
    acknowledge,
    clearRecovered: (operationId: string) => {
      const entry = recoveredRef.current.find((r) => r.operation.operationId === operationId);
      // Dismissing acknowledges a terminal state the owner was shown. A
      // receipt still in flight, or one that could not be read, keeps its identity.
      if (entry && !entry.inFlight && !entry.unavailable) clearPendingOperation(userId, operationId);
      setRecovered(recoveredRef.current.filter((r) => r.operation.operationId !== operationId));
    },
    /** Check the status of one recovered operation again (after a temporary failure). */
    recheckRecovered: async (operationId: string) => {
      const current = recoveredRef.current.find((r) => r.operation.operationId === operationId);
      if (!current) return;
      const context = `${userId}:${accountId}`;
      const next = await recoverOperation(gateway, accountId, current.operation);
      // A view that is gone, or an account that is no longer current, never
      // acknowledges: the identity stays for the view that can show it.
      if (!aliveRef.current || contextRef.current !== context) return;
      // Dismissed while the re-check was in flight: its outcome was never shown,
      // so it is not acknowledged either, and the identity stays for the next view.
      if (!recoveredRef.current.some((r) => r.operation.operationId === operationId)) return;
      setRecovered(recoveredRef.current.map((r) => (r.operation.operationId === operationId ? next : r)));
      clearSettled(userId, [next]);
    },
    discardAccountContext: () => {
      clearPendingOperationsForAccount(userId, accountId);
    },
  };
}

/** Match a pending operation by canonical target, plus legacy child-keyed reply records. */
function matchesPendingTarget(
  op: PendingStage4Operation,
  action: Stage4OperationAction,
  targetCommentId: string,
  legacyTargetCommentId: string | undefined,
  targetThreadId: string | undefined,
  loadedRows: Stage4CommentRow[],
): boolean {
  if (op.targetCommentId === targetCommentId) return true;
  if (action !== "reply" || !op.targetCommentId) return false;
  if (op.targetIsCanonicalParent === true) return false;
  if (legacyTargetCommentId && op.targetCommentId === legacyTargetCommentId) return true;
  const loaded = loadedRows.find((row) => row.comment_id === op.targetCommentId);
  if (loaded) {
    const loadedCanonicalParentId = loaded.canonical_parent_id.trim() || (loaded.kind === "thread" ? loaded.comment_id : "");
    if (loadedCanonicalParentId) return loadedCanonicalParentId === targetCommentId;
    const loadedThreadId = loaded.thread_id.trim();
    const resolvedTargetThreadId = targetThreadId?.trim()
      || loadedRows.find((row) => row.comment_id === targetCommentId)?.thread_id.trim()
      || "";
    if (loadedThreadId && resolvedTargetThreadId) {
      return loadedThreadId === targetCommentId || loadedThreadId === resolvedTargetThreadId;
    }
    return true;
  }
  return true;
}

/**
 * A recovery lock blocks only while its caller and context stay current. Once
 * an operation is minted, its lock still blocks duplicates until the call ends.
 */
function blocksNewSubmit(lock: SubmitLock, epoch: number): boolean {
  return lock.operationId !== null || (lock.epoch === epoch && lock.isStillCurrent());
}

/** The answer a blocked submit gets: the operation to check, when one is known. */
function pendingOutcomeFor(lock: SubmitLock): SubmissionOutcome {
  return lock.operationId ? { kind: "pending", operationId: lock.operationId } : { kind: "pending" };
}

/** The outcome of a call that never returned a receipt. */
function failedOutcome(error: unknown, operationId: string): SubmissionOutcome {
  // A transport failure after the claim is indeterminate unless the server
  // said otherwise; the local identity stays until status is read.
  const reason = error instanceof YouTubeCommentsError ? error.code
    : error instanceof Error && error.message ? error.message
    : "upstream";
  if (isShownRefusal(reason)) return { kind: "refused", reason, draftKept: true, operationId };
  return { kind: "error", reason, draftKept: true, operationId };
}

/** The outcome a receipt maps to; every state but a refusal is an unknown settlement. */
function outcomeForReceipt(receipt: Stage4ReceiptPayload, operationId: string): SubmissionOutcome {
  if (receipt.state === "confirmed") return { kind: "confirmed", receipt, operationId };
  if (receipt.state === "refused") return { kind: "refused", reason: receipt.reason ?? "upstream", draftKept: true, operationId };
  // claimed, dispatched or indeterminate: the browser lost the answer before settlement.
  return { kind: "indeterminate", receipt, operationId };
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
  /**
   * The parent's comment id: stable. The query, its cursor chain and the rows
   * are keyed by it. Its sealed handle is re-issued on every list load, so a
   * handle-keyed entry would restart the replies from page one after a reload.
   */
  parentCommentId: string;
  /** The parent's CURRENT sealed handle: request data only, never part of a key. */
  parentHandle: string;
  /**
   * The channel binding the list was read under. A reconnect changes it, and
   * the cached pages and cursors of the old binding are then abandoned.
   */
  bindingGeneration: number | null;
  /** Changes whenever the thread list is reloaded: open reply pages are read again from page one. */
  refreshEpoch: number;
  enabled: boolean;
}) {
  const { userId, accountId, gateway, parentCommentId, parentHandle, bindingGeneration, refreshEpoch, enabled } = params;
  const queryClient = useQueryClient();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  // A cursor belongs to one user, account, binding and parent: reset the chain when any changes.
  const resource = `replies:${parentCommentId}:g${bindingGeneration ?? "-"}`;
  const repliesIdentity = `${userId}:${accountId}:${resource}`;
  const lastRepliesIdentity = useRef(repliesIdentity);
  if (lastRepliesIdentity.current !== repliesIdentity) {
    lastRepliesIdentity.current = repliesIdentity;
    setCursors([undefined]);
  }
  const firstPageKey = youtubeCommentsKey(userId, accountId, resource, "page-0");

  const tailIndex = cursors.length - 1;
  type ReplyPage = { page: { key: string; row: Stage4CommentRow }[]; next: string | null; stale: boolean };
  type ReplyItem = { key: string; row: Stage4CommentRow; readAt: number };
  // Every page keeps an observer (only the tail may fetch), so a page that is
  // not the live tail is not garbage-collected while the thread is open.
  const pageQueries = useQueries({
    queries: cursors.map((cursor, index) => ({
      queryKey: youtubeCommentsKey(userId, accountId, resource, cursor ?? `page-${index}`),
      queryFn: async (): Promise<ReplyPage> => {
        const page = await gateway.replyPage({ accountId, parentHandle, cursor });
        if (page.account_id !== accountId) return { page: [], next: null, stale: true };
        return {
          page: page.items.map((row) => ({ key: row.comment_id, row })),
          next: page.next_cursor,
          stale: false,
        };
      },
      enabled: enabled && index === tailIndex,
      staleTime: YOUTUBE_COMMENTS_STALE_MS,
      retry: false,
    })),
  });
  const tailQuery = pageQueries[tailIndex];

  const items = useMemo(() => {
    const byKey = new Map<string, ReplyItem>();
    const readAtByKey = new Map<string, number>();
    for (const query of pageQueries) {
      for (const item of query.data?.page ?? []) {
        // The copy read last wins, whatever page it came from.
        const readAt = readAtByKey.get(item.key);
        if (readAt === undefined || query.dataUpdatedAt >= readAt) {
          byKey.set(item.key, { ...item, readAt: query.dataUpdatedAt });
          readAtByKey.set(item.key, query.dataUpdatedAt);
        }
      }
    }
    return [...byKey.values()];
  }, [pageQueries]);

  /** Back to page one, read again. The rows already shown stay until the new page replaces them. */
  const reloadFromStart = useCallback(() => {
    setCursors([undefined]);
    void queryClient.invalidateQueries({ queryKey: firstPageKey });
  }, [queryClient, firstPageKey]);

  // The thread list was reloaded (Refresh, or a confirmed action on this
  // thread): the cached reply pages may be older than the thread's own rows.
  const lastEpoch = useRef(refreshEpoch);
  useEffect(() => {
    if (lastEpoch.current === refreshEpoch) return;
    lastEpoch.current = refreshEpoch;
    reloadFromStart();
  }, [refreshEpoch, reloadFromStart]);

  const errorCode = tailQuery.error instanceof YouTubeCommentsError ? tailQuery.error.code : null;
  return {
    items,
    nextCursor: tailQuery.data?.next ?? null,
    loading: tailQuery.isLoading || tailQuery.isFetching,
    error: errorCode ?? (tailQuery.error instanceof Error ? tailQuery.error.message : null),
    errorCode,
    loadMore: () => {
      const next = tailQuery.data?.next;
      if (next) setCursors((prev) => [...prev, next]);
    },
    retry: () => void tailQuery.refetch(),
    reloadFromStart,
  };
}
