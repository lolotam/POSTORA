import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { ReviewState } from "../domain/types";
import { ReviewGatewayError, useTikTokReviewGateway, type ReviewSavePatch } from "./ports";

export const tiktokReviewKeys = {
  accounts: ["tiktok-review", "accounts"] as const,
  creator: (accountId: string) => ["tiktok-review", "creator", accountId] as const,
  list: (accountId: string, state: ReviewState) => ["tiktok-review", "list", accountId, state] as const,
  lists: ["tiktok-review", "list"] as const,
  draft: (draftId: string) => ["tiktok-review", "draft", draftId] as const,
  media: (mediaFileId: string) => ["tiktok-review", "media", mediaFileId] as const,
};

export function isRevisionConflict(error: unknown): boolean {
  return error instanceof ReviewGatewayError && error.code === "REVISION_CONFLICT";
}

export function useTikTokAccounts() {
  const gateway = useTikTokReviewGateway();
  return useQuery({
    queryKey: tiktokReviewKeys.accounts,
    queryFn: () => gateway.listAccounts(),
  });
}

export function useTikTokCreatorInfo(accountId: string | null) {
  const gateway = useTikTokReviewGateway();
  return useQuery({
    queryKey: tiktokReviewKeys.creator(accountId ?? ""),
    queryFn: () => {
      if (!accountId) {
        return Promise.reject(new ReviewGatewayError("NOT_FOUND", "Choose a TikTok account.", 404));
      }
      return gateway.creatorInfo(accountId);
    },
    enabled: !!accountId,
    staleTime: 0,
  });
}

export function useTikTokDrafts(accountId: string | null, state: ReviewState) {
  const gateway = useTikTokReviewGateway();
  return useQuery({
    queryKey: tiktokReviewKeys.list(accountId ?? "", state),
    queryFn: () => {
      if (!accountId) {
        return Promise.reject(new ReviewGatewayError("NOT_FOUND", "Choose a TikTok account.", 404));
      }
      return gateway.list(accountId, state);
    },
    enabled: !!accountId,
  });
}

export function useTikTokDraft(draftId: string | null) {
  const gateway = useTikTokReviewGateway();
  return useQuery({
    queryKey: tiktokReviewKeys.draft(draftId ?? ""),
    queryFn: () => {
      if (!draftId) {
        return Promise.reject(new ReviewGatewayError("NOT_FOUND", "Choose a post.", 404));
      }
      return gateway.get(draftId);
    },
    enabled: !!draftId,
  });
}

/** A missing library row is an error here so the screen cannot treat it as "no video". */
export function useTikTokMediaPreview(mediaFileId: string | null) {
  const gateway = useTikTokReviewGateway();
  return useQuery({
    queryKey: tiktokReviewKeys.media(mediaFileId ?? ""),
    queryFn: async () => {
      if (!mediaFileId) {
        throw new ReviewGatewayError("NOT_FOUND", "That video could not be loaded.", 404);
      }
      const preview = await gateway.resolveMediaPreview(mediaFileId);
      if (!preview) {
        throw new ReviewGatewayError("NOT_FOUND", "That video could not be loaded.", 404);
      }
      return preview;
    },
    enabled: !!mediaFileId,
  });
}

export function useTikTokReviewCommands() {
  const gateway = useTikTokReviewGateway();
  const client = useQueryClient();
  const [conflictedDraftId, setConflictedDraftId] = useState<string | null>(null);

  function remember(draft: { id: string }) {
    client.setQueryData(tiktokReviewKeys.draft(draft.id), draft);
  }

  async function refresh(draftId: string | null) {
    await client.invalidateQueries({ queryKey: tiktokReviewKeys.lists });
    if (draftId) await client.invalidateQueries({ queryKey: tiktokReviewKeys.draft(draftId) });
  }

  function noteError(error: unknown, input: { draftId: string }) {
    if (isRevisionConflict(error)) setConflictedDraftId(input.draftId);
  }

  const createDraft = useMutation({
    mutationFn: (accountId: string) => gateway.create(accountId),
    onSuccess: (draft) => {
      setConflictedDraftId((current) => current === draft.id ? null : current);
      remember(draft);
      return refresh(draft.id);
    },
  });

  const saveDraft = useMutation({
    mutationFn: (input: { draftId: string; expectedRevision: number; patch: ReviewSavePatch }) =>
      gateway.save(input.draftId, input.expectedRevision, input.patch),
    onSuccess: (draft) => {
      setConflictedDraftId((current) => current === draft.id ? null : current);
      remember(draft);
      return refresh(draft.id);
    },
    onError: (error, input) => noteError(error, input),
  });

  const rejectDraft = useMutation({
    mutationFn: (input: { draftId: string; expectedRevision: number; reason: string }) =>
      gateway.reject(input.draftId, input.expectedRevision, input.reason),
    onSuccess: (draft) => {
      setConflictedDraftId((current) => current === draft.id ? null : current);
      remember(draft);
      return refresh(draft.id);
    },
    onError: (error, input) => noteError(error, input),
  });

  const archiveDraft = useMutation({
    mutationFn: (input: { draftId: string; expectedRevision: number }) =>
      gateway.archive(input.draftId, input.expectedRevision),
    onSuccess: (draft) => {
      setConflictedDraftId((current) => current === draft.id ? null : current);
      remember(draft);
      return refresh(draft.id);
    },
    onError: (error, input) => noteError(error, input),
  });

  const restoreDraft = useMutation({
    mutationFn: (input: { draftId: string; expectedRevision: number }) =>
      gateway.restore(input.draftId, input.expectedRevision),
    onSuccess: (draft) => {
      setConflictedDraftId((current) => current === draft.id ? null : current);
      remember(draft);
      return refresh(draft.id);
    },
    onError: (error, input) => noteError(error, input),
  });

  const submitDraft = useMutation({
    mutationFn: gateway.submit,
    onSuccess: (_result, command) => {
      setConflictedDraftId((current) => current === command.draftId ? null : current);
      return refresh(command.draftId);
    },
    onError: (error, input) => noteError(error, input),
  });

  const clearRevisionConflict = useCallback(() => setConflictedDraftId(null), []);

  return {
    createDraft,
    saveDraft,
    rejectDraft,
    archiveDraft,
    restoreDraft,
    submitDraft,
    conflictedDraftId,
    clearRevisionConflict,
  };
}
