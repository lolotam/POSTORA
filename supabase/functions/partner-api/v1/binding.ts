// The set of accounts a key may read (spec D4 + D11, deliverable 2.5).
//
// THE ANCHOR IS THE JOIN TABLE, NOT partner_api_keys.social_account_id
// --------------------------------------------------------------------
// Those two are the same value today, because the D4 migration seeded one
// binding row per existing key from that column. They are not the same
// CONCEPT, and every /v1 read must anchor on the join table:
//
//   partner_api_keys.social_account_id  is the PRIMARY account — the one the
//     frozen alias uses, because its request body has no way to name an
//     account (D11's last row). It survives only until alias sunset.
//   partner_api_key_accounts            is what the key may reach.
//
// Read the primary column instead and the day a key is bound to a second
// account, /v1 keeps answering about the first — a wrong-account read that
// looks exactly like a working endpoint. Read it as a FALLBACK when the join
// table is empty and it is worse: a key whose bindings were deliberately
// revoked silently keeps its old access. There is therefore no fallback here.
// An unbound key reads nothing, which is the fail-closed direction.
//
// TENANCY IS PROVEN TWICE
// -----------------------
// The join table's two composite FKs already make a cross-workspace binding
// unrepresentable, so filtering by key_id alone would be sound. Every query
// below ALSO filters `workspace_id = record.workspaceId`. That is not
// distrust of the constraints — it is what keeps a future administrative
// path, a restored backup, or a hand-written row from turning a data defect
// into a cross-tenant read. It costs one predicate and it uses the index.

import { v1ErrorResponse } from "./errors.ts";
import type { V1AuthedContext } from "./authenticated.ts";

/**
 * The largest bound set an UNFILTERED collection read will serve.
 *
 * Not a page size — collection reads are paginated independently. This bounds
 * the `social_account_id IN (…)` filter itself: past a few hundred ids the
 * PostgREST request line stops fitting in a URL, and the failure mode is a
 * gateway 414 that reads to a partner as "the API is broken".
 *
 * Exceeding it REFUSES rather than truncating. Truncating would drop accounts
 * from the tenancy filter silently, and the partner's only symptom would be
 * conversations that exist in the Postora UI and not in the API — a bug
 * report nobody can reproduce. No key binds anything near this today.
 */
export const BOUND_ACCOUNT_FILTER_MAX = 200;

export interface BoundAccount {
  id: string;
  platform: string;
  platformUserId: string | null;
  platformUsername: string | null;
  isActive: boolean;
  needsReauth: boolean;
  connectedAt: string | null;
}

/** The ids a key is bound to, in a stable order. */
export async function boundAccountIds(
  authed: V1AuthedContext,
): Promise<{ ok: true; ids: string[] } | { ok: false; res: Response }> {
  const { admin, record, requestId } = authed;
  const { data, error } = await admin
    .from("partner_api_key_accounts")
    .select("social_account_id")
    .eq("key_id", record.id)
    .eq("workspace_id", record.workspaceId)
    .order("social_account_id", { ascending: true });

  if (error) {
    console.error(`[partner-api] v1 binding lookup failed (request ${requestId}):`, error);
    return { ok: false, res: v1ErrorResponse("internal_error", requestId) };
  }

  const ids = (data ?? []).map((row: { social_account_id: string }) => row.social_account_id);
  if (ids.length > BOUND_ACCOUNT_FILTER_MAX) {
    return {
      ok: false,
      res: v1ErrorResponse("invalid_request", requestId, {
        message: "This key binds too many accounts for an unfiltered listing; " +
          "pass account_id to select one",
      }),
    };
  }
  return { ok: true, ids };
}

/**
 * Resolve the accounts a collection read covers, honouring `?account_id=`.
 *
 * D11's collection rule: the default is ALL bound accounts with each row
 * labelled by `account_id` — never an implicit single-account default, which
 * would change meaning the day a second account is bound.
 *
 * An `account_id` naming an account this key is not bound to answers
 * `resource_not_found`, matching D11's resource-read rule and the key-auth
 * precedent: the partner learns nothing about whether that account exists at
 * all. `resource_forbidden` would confirm it does.
 *
 * `accountId` is the already-decoded UUID (see ids.ts) or null.
 */
export function selectBoundAccounts(
  ids: string[],
  accountId: string | null,
  requestId: string,
): { ok: true; ids: string[] } | { ok: false; res: Response } {
  if (accountId === null) return { ok: true, ids };
  if (!ids.includes(accountId)) {
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }
  return { ok: true, ids: [accountId] };
}

/** Hydrate bound ids into account rows. Bounded by the caller's page, and
 *  filtered by workspace again for the reason at the top of this file. */
export async function fetchBoundAccounts(
  authed: V1AuthedContext,
  ids: string[],
): Promise<{ ok: true; accounts: BoundAccount[] } | { ok: false; res: Response }> {
  const { admin, record, requestId } = authed;
  if (ids.length === 0) return { ok: true, accounts: [] };

  const { data, error } = await admin
    .from("social_accounts")
    .select(
      "id, platform, platform_user_id, platform_username, " +
        "is_active, needs_reauth, connected_at",
    )
    .in("id", ids)
    .eq("workspace_id", record.workspaceId)
    .order("connected_at", { ascending: false });

  if (error) {
    console.error(`[partner-api] v1 account fetch failed (request ${requestId}):`, error);
    return { ok: false, res: v1ErrorResponse("internal_error", requestId) };
  }

  // deno-lint-ignore no-explicit-any
  const accounts = (data ?? []).map((row: any): BoundAccount => ({
    id: row.id,
    platform: row.platform,
    platformUserId: row.platform_user_id ?? null,
    platformUsername: row.platform_username ?? null,
    isActive: row.is_active === true,
    needsReauth: row.needs_reauth === true,
    connectedAt: row.connected_at ?? null,
  }));
  return { ok: true, accounts };
}
