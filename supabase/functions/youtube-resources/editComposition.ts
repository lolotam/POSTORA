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

/**
 * The two fail-closed checks that stand between a validated plan and a
 * provider write. Both are ports so the offline composition can prove they
 * are consulted; production leaves the whole edit port disabled.
 */
export interface EditWriteGuard {
  /** Fail-closed per-owner mutation rate/quota gate. */
  authorizeWrite(input: { accountId: string; ownerId: string; channelId: string }): Promise<boolean>;
  /** Re-read account, channel binding and token identity just before dispatch. */
  stillBound(input: {
    accountId: string;
    ownerId: string;
    channelId: string;
    accessToken: string;
  }): Promise<boolean>;
}

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
  writeGuard: EditWriteGuard;
}

function toEditFailureCode(error: unknown): EditFailureCode | null {
  return error instanceof EditFailure ? error.code : null;
}

/** The channel's catalog region when the account recorded one, else US. */
function effectiveRegion(accountMetadata: unknown): string {
  const metadata = (accountMetadata ?? {}) as Record<string, unknown>;
  const value = metadata.country ?? metadata.region;
  return typeof value === "string" && /^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : "US";
}

/**
 * Returns undefined while the gate is off: the handler then refuses every edit
 * before any provider call, which is the production state of this delivery.
 */
export function createConnectedEditPort(inputs: EditCompositionInputs): YouTubeEditPort | undefined {
  if (!inputs.enabled) return undefined;
  const { provider, categories, tokens, accounts, clock, writeGuard } = inputs;

  async function context(accountId: string, ownerId: string) {
    const account = await accounts.load({ accountId, userId: ownerId });
    if (!account || account.userId !== ownerId || account.channelId === null || account.authProvider === "composio") {
      throw new EditFailure("invalid_request", "No owned native channel is available for this edit.");
    }
    const token = await tokens.get(account, { force: false });
    if (!token.ok) throw new EditFailure("reconnect_required", "The selected channel cannot be used.");
    return {
      accessToken: token.accessToken,
      channelId: account.channelId,
      region: effectiveRegion(account.accountMetadata),
    };
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
      const { accessToken, channelId, region } = await context(accountId, ownerId);
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

      // The same quota gate that fences the provider write also fences the
      // provider CATALOG read made for this write. Otherwise a rejected write
      // could still spend a Google quota unit listing categories.
      if (!await writeGuard.authorizeWrite({ accountId, ownerId, channelId })) {
        throw new EditFailure("upstream_unavailable", "The write quota is exhausted. Try again later.");
      }
      const catalog = await categories.list(accessToken, { region, locale: "en" });
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

      // The binding is re-read again immediately before dispatch: a token
      // refresh or a channel relink between the catalog read and the plan must
      // not leave a stale write on the wire. A missing or failing gate refuses
      // the write; no unconditional fallback exists.
      if (!await writeGuard.stillBound({ accountId, ownerId, channelId, accessToken })) {
        throw new EditFailure("reconnect_required", "The channel binding changed before the write.");
      }
      const written = await provider.updateVideo(accessToken, { videoId, plan });
      if (!written.ok) throw new EditFailure(written.code, "The conditional write was refused.");
      const reread = await provider.getVideo(accessToken, { videoId, channelId });
      if (!reread.ok) throw new EditFailure("outcome_unknown", "The result could not be verified.");
      verifyEditResult({ responseId: written.id, reread: reread.value, expectedVideoId: videoId, plan });
      return { snapshot, verified: true };
    },
  };
}
