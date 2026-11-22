/**
 * Production composition of the published-edit domain logic.
 *
 * The gate is a compile-time constant OFF. There is no environment variable,
 * flag table or feature switch that can turn it on: activation requires a code
 * change backed by approved D1 (If-Match enforcement) and D5 (fixture/rollout)
 * evidence. Tests construct the same composition with `enabled: true` and a
 * synthetic provider, so the connected path is exercised without live writes.
 */

import {
  createEditSnapshot,
  EditFailure,
  planEditUpdate,
  verifyEditResult,
  type EditFailureCode,
  type EditSnapshot,
} from "./editLifecycle.ts";
import type { YouTubeEditPort } from "./handler.ts";
import type { YouTubeEditProvider } from "./editProvider.ts";
import type { YouTubeCategoryClient } from "./categoryClient.ts";

export const PUBLISHED_EDIT_WRITE_ENABLED = false as const;

export interface EditCompositionInputs {
  /** Tests pass true with an approved synthetic provider; production passes the constant. */
  enabled: boolean;
  provider: YouTubeEditProvider;
  categories: YouTubeCategoryClient;
  tokens: {
    get(account: { id: string; accessToken: string | null; refreshToken: string | null; tokenExpiresAt: string | null; needsReauth: boolean }, options: { force: boolean }): Promise<
      | { ok: true; accessToken: string; minted: boolean }
      | { ok: false; code: "reconnect_required" | "upstream_unavailable" }
    >;
  };
  accounts: {
    load(input: { accountId: string; userId: string }): Promise<{
      id: string;
      userId: string;
      channelId: string | null;
      authProvider: string | null;
      needsReauth: boolean;
      accessToken: string | null;
      refreshToken: string | null;
      tokenExpiresAt: string | null;
      accountMetadata: unknown;
    } | null>;
  };
  clock: { now(): Date };
}

function toEditFailureCode(error: unknown): EditFailureCode | null {
  return error instanceof EditFailure ? error.code : null;
}

/**
 * Returns undefined while the gate is off: the handler then refuses every edit
 * before any provider call, which is the production state of this delivery.
 */
export function createConnectedEditPort(inputs: EditCompositionInputs): YouTubeEditPort | undefined {
  if (!inputs.enabled) return undefined;
  const { provider, categories, tokens, accounts, clock } = inputs;

  async function context(accountId: string, ownerId: string) {
    const account = await accounts.load({ accountId, userId: ownerId });
    if (!account || account.userId !== ownerId || account.channelId === null || account.authProvider === "composio") {
      throw new EditFailure("invalid_request", "No owned native channel is available for this edit.");
    }
    const token = await tokens.get(account, { force: false });
    if (!token.ok) throw new EditFailure("reconnect_required", "The selected channel cannot be used.");
    return { accessToken: token.accessToken, channelId: account.channelId };
  }

  return {
    failureCode: toEditFailureCode,
    async snapshot({ accountId, videoId, ownerId }) {
      const { accessToken, channelId } = await context(accountId, ownerId);
      const video = await provider.getVideo(accessToken, { videoId, channelId });
      if (!video.ok) throw new EditFailure(video.code === "not_found" ? "invalid_request" : video.code, "Video read failed.");
      return await createEditSnapshot({
        video: video.value,
        ownerId,
        accountId,
        expectedChannelId: channelId,
        fetchedAt: clock.now().toISOString(),
      });
    },
    async update({ accountId, videoId, ownerId, baseRevision, changes, privacyConfirmation }) {
      const { accessToken, channelId } = await context(accountId, ownerId);
      const before = await provider.getVideo(accessToken, { videoId, channelId });
      if (!before.ok) throw new EditFailure(before.code === "not_found" ? "invalid_request" : before.code, "Video read failed.");
      const snapshot: EditSnapshot = await createEditSnapshot({
        video: before.value,
        ownerId,
        accountId,
        expectedChannelId: channelId,
        fetchedAt: clock.now().toISOString(),
      });
      if (snapshot.revision !== baseRevision) throw new EditFailure("edit_conflict", "The video changed since it was opened.");
      const catalog = await categories.list(accessToken, { region: "US", locale: "en" });
      const assignableCategoryIds = catalog.ok ? new Set(catalog.value.filter((option) => option.assignable).map((option) => option.id)) : undefined;
      const plan = await planEditUpdate({
        snapshot,
        changes,
        freshVideo: before.value,
        ownerId,
        accountId,
        privacyConfirmation,
        assignableCategoryIds,
      });
      const written = await provider.updateVideo(accessToken, { videoId, plan });
      if (!written.ok) throw new EditFailure(written.code, "The conditional write was refused.");
      const reread = await provider.getVideo(accessToken, { videoId, channelId });
      if (!reread.ok) throw new EditFailure("outcome_unknown", "The result could not be verified.");
      verifyEditResult({ responseId: written.id, reread: reread.value, expectedVideoId: videoId, plan });
      return { snapshot, verified: true };
    },
  };
}
