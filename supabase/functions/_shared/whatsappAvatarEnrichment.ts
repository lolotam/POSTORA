// Best-effort Direct-QR participant avatars. Evolution's findChats/findContacts leave
// profilePicUrl null; the live picture is a separate fetch whose pps.whatsapp.net URL
// expires. cacheAvatarToCloudinary returns that original URL on upload failure, so a
// durable persist has to be a Cloudinary hostname that is not the source.
//
// checked_at is a negative cache for a confirmed miss (the contact hid their picture).
// A fetch or upload error must not stamp it, or a blip would block retries for 7 days.

export const AVATAR_NEGATIVE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
export const WEBHOOK_AVATAR_DEADLINE_MS = 8_000;
export const BACKFILL_MAX = 25;
export const BACKFILL_CONCURRENCY = 3;

export type CacheAvatarFn = (
  sourceUrl: string | null | undefined,
  userId: string,
  platform: string,
  platformUserId: string,
) => Promise<string | null>;

export interface WhatsAppAvatarEnrichmentDeps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  fetchProfilePictureUrl: (instanceName: string, number: string) => Promise<string | null>;
  cacheAvatar: CacheAvatarFn;
  nowMs?: number;
  deadlineAt?: number;
}

export interface WhatsAppAvatarTarget {
  userId: string;
  workspaceId: string;
  accountId: string;
  conversationId: string;
  instanceName: string;
  contactNumber: string;
}

export interface WhatsAppAvatarBackfillScope {
  userId: string;
  workspaceId: string;
  accountId: string;
  instanceName: string;
}

export async function enrichWhatsAppParticipantAvatar(
  deps: WhatsAppAvatarEnrichmentDeps,
  target: WhatsAppAvatarTarget,
): Promise<void> {
  try {
    await enrichOnce(deps, target);
  } catch (error) {
    // Name only: Evolution and Cloudinary errors embed URLs (and sometimes numbers).
    console.error(
      "[whatsapp-avatar] enrichment failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}

export async function backfillWhatsAppParticipantAvatars(
  deps: WhatsAppAvatarEnrichmentDeps,
  scope: WhatsAppAvatarBackfillScope,
): Promise<void> {
  try {
    await backfillOrThrow(deps, scope);
  } catch (error) {
    console.error(
      "[whatsapp-avatar] backfill failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}

async function backfillOrThrow(
  deps: WhatsAppAvatarEnrichmentDeps,
  scope: WhatsAppAvatarBackfillScope,
): Promise<void> {
  const nowMs = deps.nowMs ?? Date.now();
  if (deadlinePassed(deps.deadlineAt, nowMs)) return;

  const { data, error } = await deps.admin
    .from("messaging_cache")
    .select("conversation_id, participant_avatar, participant_avatar_checked_at")
    .eq("user_id", scope.userId)
    .eq("workspace_id", scope.workspaceId)
    .eq("social_account_id", scope.accountId)
    .eq("platform", "whatsapp")
    .is("participant_avatar", null)
    .limit(BACKFILL_MAX);

  // A failed read must not look like "nothing to do": that would skip a live miss forever.
  if (error) {
    console.error("[whatsapp-avatar] backfill read failed:", error.message ?? error);
    return;
  }

  const rows = Array.isArray(data) ? data : [];
  const targets: WhatsAppAvatarTarget[] = [];
  for (const row of rows) {
    if (targets.length >= BACKFILL_MAX) break;
    const conversationId = typeof row?.conversation_id === "string" ? row.conversation_id : "";
    const contactNumber = contactNumberFromConversationId(conversationId);
    if (!contactNumber) continue;
    if (typeof row?.participant_avatar === "string" && row.participant_avatar.length > 0) continue;
    if (isFreshNegativeCache(row?.participant_avatar_checked_at, nowMs)) continue;
    targets.push({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      accountId: scope.accountId,
      conversationId,
      instanceName: scope.instanceName,
      contactNumber,
    });
  }

  for (let index = 0; index < targets.length; index += BACKFILL_CONCURRENCY) {
    if (deadlinePassed(deps.deadlineAt, Date.now())) return;
    await Promise.all(
      targets.slice(index, index + BACKFILL_CONCURRENCY).map((target) =>
        enrichWhatsAppParticipantAvatar(deps, target)
      ),
    );
  }
}

async function enrichOnce(
  deps: WhatsAppAvatarEnrichmentDeps,
  target: WhatsAppAvatarTarget,
): Promise<void> {
  const nowMs = deps.nowMs ?? Date.now();
  if (deadlinePassed(deps.deadlineAt, nowMs)) return;
  if (!target.contactNumber) return;

  const { data, error } = await deps.admin
    .from("messaging_cache")
    .select("participant_avatar, participant_avatar_checked_at")
    .eq("user_id", target.userId)
    .eq("workspace_id", target.workspaceId)
    .eq("conversation_id", target.conversationId)
    .maybeSingle();

  if (error) {
    console.error("[whatsapp-avatar] cache read failed:", error.message ?? error);
    return;
  }
  if (!data) return;
  if (typeof data.participant_avatar === "string" && data.participant_avatar.length > 0) return;
  if (isFreshNegativeCache(data.participant_avatar_checked_at, nowMs)) return;

  const sourceUrl = await withDeadline(
    deps.fetchProfilePictureUrl(target.instanceName, target.contactNumber),
    deps.deadlineAt,
  );
  if (sourceUrl === DEADLINE) return;
  if (sourceUrl === null) {
    await stampCheckedAt(deps, target, nowMs);
    return;
  }

  const opaqueId = await opaqueCloudinaryId(
    target.workspaceId,
    target.accountId,
    target.conversationId,
  );
  const cached = await withDeadline(
    deps.cacheAvatar(sourceUrl, target.userId, "whatsapp", opaqueId),
    deps.deadlineAt,
  );
  if (cached === DEADLINE || cached == null) return;
  if (!isDurableCloudinaryUrl(cached, sourceUrl)) return;

  await updateCache(deps, target, { participant_avatar: cached });
}

const DEADLINE = Symbol("deadline");

async function withDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number | undefined,
): Promise<T | typeof DEADLINE> {
  if (deadlineAt === undefined) return await promise;
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return DEADLINE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stampCheckedAt(
  deps: WhatsAppAvatarEnrichmentDeps,
  target: WhatsAppAvatarTarget,
  nowMs: number,
): Promise<void> {
  await updateCache(deps, target, {
    participant_avatar_checked_at: new Date(nowMs).toISOString(),
  });
}

async function updateCache(
  deps: WhatsAppAvatarEnrichmentDeps,
  target: WhatsAppAvatarTarget,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await deps.admin
    .from("messaging_cache")
    .update(patch)
    .eq("user_id", target.userId)
    .eq("workspace_id", target.workspaceId)
    .eq("conversation_id", target.conversationId);
  if (error) {
    console.error("[whatsapp-avatar] cache update failed:", error.message ?? error);
  }
}

function deadlinePassed(deadlineAt: number | undefined, nowMs: number): boolean {
  return deadlineAt !== undefined && nowMs >= deadlineAt;
}

function isFreshNegativeCache(checkedAt: unknown, nowMs: number): boolean {
  if (typeof checkedAt !== "string" || checkedAt.length === 0) return false;
  const at = Date.parse(checkedAt);
  if (!Number.isFinite(at)) return false;
  return nowMs - at < AVATAR_NEGATIVE_CACHE_MS;
}

export function contactNumberFromConversationId(conversationId: string): string | null {
  const last = conversationId.split("_").pop() ?? "";
  return /^\d+$/.test(last) ? last : null;
}

export function isDurableCloudinaryUrl(url: string, sourceUrl: string): boolean {
  if (url === sourceUrl) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "res.cloudinary.com" || host.endsWith(".cloudinary.com");
  } catch {
    return false;
  }
}

async function opaqueCloudinaryId(
  workspaceId: string,
  accountId: string,
  conversationId: string,
): Promise<string> {
  // Phone numbers collide across accounts of one user; the Cloudinary public id is
  // overwritten deterministically, so the key has to be scoped and not the number.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${workspaceId}:${accountId}:${conversationId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
