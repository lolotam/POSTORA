/**
 * Reconnect an existing social_accounts row IN PLACE.
 *
 * Every OAuth function persists a fresh connection with an upsert keyed on
 * (user_id, platform, platform_user_id). That replaces the row only while the
 * provider keeps handing back the same id. Providers with app-scoped ids
 * (Threads, LinkedIn) mint a new id after a Meta/LinkedIn app change, so the
 * upsert inserts a second row for the same account and the expired one keeps
 * its red "Reconnect" flag. This helper is the reconnect path that targets the
 * row the user clicked instead of whatever id the provider returns.
 *
 * Identity policy:
 *   - "platform_user_id": the provider id must match the stored one (Pinterest,
 *     TikTok, Twitter behaviour -- ids are stable there).
 *   - "username": a changed id is accepted when the handle matches the stored
 *     one; a different handle is still rejected so a user logged into another
 *     account cannot silently take the row over.
 *
 * When the id changes and a sibling row already holds the new id (an earlier
 * connect already duplicated the account), the sibling is RETIRED, never
 * deleted: twenty tables cascade on social_accounts.id. Retiring frees the
 * unique (user_id, platform, platform_user_id) slot and hides the row, since
 * every account query filters on is_active.
 */

export type ReconnectErrorCode =
  | "RECONNECT_ACCOUNT_NOT_FOUND"
  | "RECONNECT_FORBIDDEN"
  | "RECONNECT_PLATFORM_MISMATCH"
  | "RECONNECT_ACCOUNT_MISMATCH";

export class ReconnectError extends Error {
  readonly code: ReconnectErrorCode;
  constructor(code: ReconnectErrorCode) {
    super(code);
    this.name = "ReconnectError";
    this.code = code;
  }
}

export type ReconnectIdentityPolicy = "platform_user_id" | "username";

export interface ReconnectIdentity {
  platformUserId: string;
  platformUsername: string;
}

export interface ReconnectRequest {
  socialAccountId: string;
  userId: string;
  platform: string;
  identity: ReconnectIdentity;
  identityPolicy: ReconnectIdentityPolicy;
  /** Columns to write on the target row. `account_metadata` is merged over the stored blob. */
  patch: Record<string, unknown>;
}

export interface ReconnectResult {
  previousPlatformUserId: string;
  platformUserId: string;
  retiredSiblingId: string | null;
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

interface StoredIdentity {
  platform_user_id: string;
  platform_username: string | null;
}

/** Query param the OAuth callbacks put on the redirect when a reconnect fails. */
export function reconnectErrorParam(err: unknown, fallback: string): string {
  if (err instanceof ReconnectError) return err.code.toLowerCase();
  return fallback;
}

function normalizeHandle(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveReconnectIdentity(
  row: StoredIdentity,
  identity: ReconnectIdentity,
  policy: ReconnectIdentityPolicy,
): "same_id" | "id_changed" {
  if (String(row.platform_user_id) === String(identity.platformUserId)) return "same_id";
  if (policy === "username") {
    const stored = normalizeHandle(row.platform_username);
    if (stored && stored === normalizeHandle(identity.platformUsername)) return "id_changed";
  }
  throw new ReconnectError("RECONNECT_ACCOUNT_MISMATCH");
}

async function retireSiblingHoldingId(
  supabase: SupabaseClient,
  req: ReconnectRequest,
  targetId: string,
  now: string,
): Promise<string | null> {
  const { data: sibling, error } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("user_id", req.userId)
    .eq("platform", req.platform)
    .eq("platform_user_id", req.identity.platformUserId)
    .neq("id", targetId)
    .maybeSingle();
  if (error) throw new Error("Failed to look up duplicate social account");
  if (!sibling) return null;

  const { error: retireError } = await supabase
    .from("social_accounts")
    .update({
      platform_user_id: `retired_${sibling.id}`,
      is_active: false,
      updated_at: now,
    })
    .eq("id", sibling.id)
    .eq("user_id", req.userId);
  if (retireError) throw new Error("Failed to retire duplicate social account");

  console.log(JSON.stringify({
    event: "social_account_reconnect_retired_duplicate",
    platform: req.platform,
    user_id: req.userId,
    kept: targetId,
    retired: sibling.id,
  }));
  return sibling.id;
}

interface TargetRow {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string | null;
  account_metadata: Record<string, unknown> | null;
}

async function loadOwnedTarget(supabase: SupabaseClient, req: ReconnectRequest): Promise<TargetRow> {
  const { data: row, error } = await supabase
    .from("social_accounts")
    .select("id, user_id, platform, platform_user_id, platform_username, account_metadata")
    .eq("id", req.socialAccountId)
    .maybeSingle();

  if (error || !row) throw new ReconnectError("RECONNECT_ACCOUNT_NOT_FOUND");
  if (row.user_id !== req.userId) throw new ReconnectError("RECONNECT_FORBIDDEN");
  if (row.platform !== req.platform) throw new ReconnectError("RECONNECT_PLATFORM_MISMATCH");
  return row as TargetRow;
}

async function renewTargetRow(
  supabase: SupabaseClient,
  req: ReconnectRequest,
  row: TargetRow,
  now: string,
): Promise<void> {
  const { account_metadata: patchMetadata, ...columns } = req.patch;
  const { error } = await supabase
    .from("social_accounts")
    .update({
      ...columns,
      platform_user_id: req.identity.platformUserId,
      platform_username: req.identity.platformUsername,
      account_metadata: {
        ...(row.account_metadata ?? {}),
        ...((patchMetadata as Record<string, unknown> | undefined) ?? {}),
      },
      is_active: true,
      needs_reauth: false,
      failure_count: 0,
      last_refresh_error: null,
      updated_at: now,
    })
    .eq("id", row.id)
    .eq("user_id", req.userId);
  if (error) {
    console.error("Database error (reconnect):", error);
    throw new Error("Failed to update social account");
  }
}

export async function reconnectSocialAccountInPlace(
  supabase: SupabaseClient,
  req: ReconnectRequest,
): Promise<ReconnectResult> {
  const row = await loadOwnedTarget(supabase, req);
  const outcome = resolveReconnectIdentity(row, req.identity, req.identityPolicy);
  const previousPlatformUserId = String(row.platform_user_id);
  const now = new Date().toISOString();

  // The sibling must give the id up before the target adopts it, or the
  // unique (user_id, platform, platform_user_id) index rejects the update.
  const retiredSiblingId = outcome === "id_changed"
    ? await retireSiblingHoldingId(supabase, req, row.id, now)
    : null;

  await renewTargetRow(supabase, req, row, now);

  return {
    previousPlatformUserId,
    platformUserId: req.identity.platformUserId,
    retiredSiblingId,
  };
}
