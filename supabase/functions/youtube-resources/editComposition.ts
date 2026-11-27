/**
 * Production composition of the published-edit domain logic.
 *
 * Activated for Phase 4A (title, description, tags, category) after the
 * live If-Match conditional-write rehearsal and OD-1 activation decision:
 * - docs/reports/2026-11-27-youtube-if-match-rehearsal.md
 * - docs/decisions/2026-11-27-youtube-phase4a-if-match-and-edit-activation.md
 *
 * Tests can still construct the composition with `enabled: false` or with a
 * synthetic provider to verify both gated and connected behavior offline.
 */

import {
  createEditSnapshot,
  EditFailure,
  planEditUpdate,
  validateEditChanges,
  verifyEditResult,
  type EditFailureCode,
  type EditSnapshot,
} from "./editLifecycle.ts";
import type { YouTubeEditPort } from "./handler.ts";
import type { YouTubeEditProvider } from "./editProvider.ts";
import type { YouTubeCategoryClient } from "./categoryClient.ts";

export const PUBLISHED_EDIT_WRITE_ENABLED = true as const;

export type EditWriteAuthorizationResult =
  | { ok: true }
  | { ok: false; code: "rate_limited" | "quota_exceeded" | "upstream_unavailable"; retryAfterSeconds?: number };

/**
 * The two fail-closed checks that stand between a validated plan and a
 * provider write. Both are ports so the offline composition can prove they
 * are consulted before any category catalog read or provider write.
 */
export interface EditWriteGuard {
  /** Fail-closed per-owner mutation rate/quota gate. */
  authorizeWrite(input: {
    accountId: string;
    ownerId: string;
    channelId: string;
  }): Promise<EditWriteAuthorizationResult>;
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

function toRetryAfterSeconds(error: unknown): number | undefined {
  return error instanceof EditFailure ? error.retryAfterSeconds : undefined;
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
    retryAfterSeconds: toRetryAfterSeconds,
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
      // Validate shape, bounds, and privacy confirmation BEFORE debiting the
      // per-user write counters or the project-wide 50-unit write budget.
      validateEditChanges(changes, snapshot);
      if (snapshot.restrictions.unknownFieldsBlocked) {
        throw new EditFailure("provider_unsupported", "A writable sibling is not yet understood.");
      }
      if (changes.privacyStatus !== undefined && (!privacyConfirmation || privacyConfirmation.to !== changes.privacyStatus)) {
        throw new EditFailure("invalid_request", "The privacy change was not confirmed.");
      }

      // The same quota gate that fences the provider write also fences the
      // provider CATALOG read made for this write. Otherwise a rejected write
      // could still spend a Google quota unit listing categories.
      const authResult = await writeGuard.authorizeWrite({ accountId, ownerId, channelId });
      if (!authResult.ok) {
        throw new EditFailure(
          authResult.code,
          "The write quota is exhausted. Try again later.",
          { retryAfterSeconds: authResult.retryAfterSeconds },
        );
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
      const verifiedSnapshot = await createEditSnapshot({
        video: reread.value,
        ownerId,
        accountId,
        expectedChannelId: channelId,
        fetchedAt: clock.now().toISOString(),
      });
      return { snapshot: verifiedSnapshot, verified: true };
    },
  };
}
