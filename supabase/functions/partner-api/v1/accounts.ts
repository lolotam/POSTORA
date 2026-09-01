// GET /v1/accounts and GET /v1/accounts/{id} (deliverable 2.3).
//
// D7 risk class **A** — a bounded local read: Postora's own database, a set
// bounded by the key's binding, no outbound call. Class A proceeds when the
// limiter cannot resolve a budget, which is D7's deliberate asymmetry: a
// read that costs nothing and reaches nobody should not be collateral damage
// of a limiter outage, while the class-B and class-C paths fail closed.
// v1/accounts.test.ts pins that direction, because "reads keep working during
// an incident" is a promise that only holds while something checks it.
//
// This endpoint is the partner's map of the /v1 surface: every other read is
// scoped to these accounts, and `?account_id=` on a collection names one of
// them. It therefore lists exactly the binding — not the workspace's accounts,
// of which the binding may be a strict subset.

import { boundAccountIds, fetchBoundAccounts, type BoundAccount } from "./binding.ts";
import { decodeId, encodeId } from "./ids.ts";
import { v1ErrorResponse } from "./errors.ts";
import { v1Collection, v1JsonResponse } from "./respond.ts";
import type { V1AuthedContext } from "./authenticated.ts";

/**
 * The published shape of an account.
 *
 * Deliberately small. Under the 0.8 drift gate an added optional field is
 * free forever and a removed one is an R1 finding forever, so a field earns
 * its place by being something a partner acts on. `platform_user_id` is
 * named as the PROVIDER's id (§7.1: provider ids appear as clearly named
 * separate fields, never as the primary id) — it is the WhatsApp phone number
 * id a partner needs to reconcile against their own Meta tooling.
 */
function present(account: BoundAccount): Record<string, unknown> {
  return {
    id: encodeId("acc", account.id),
    platform: account.platform,
    platform_user_id: account.platformUserId,
    username: account.platformUsername,
    is_active: account.isActive,
    needs_reauth: account.needsReauth,
    connected_at: account.connectedAt,
  };
}

export async function listAccounts(
  _req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { requestId } = authed;

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;

  const accounts = await fetchBoundAccounts(authed, bound.ids);
  if (!accounts.ok) return accounts.res;

  // No cursor: the binding is already bounded by BOUND_ACCOUNT_FILTER_MAX,
  // which refuses rather than truncates, so this listing is complete by
  // construction. `next_cursor: null` states that positively — see
  // v1Collection.
  return v1Collection(accounts.accounts.map(present), null, requestId);
}

export async function getAccount(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { requestId } = authed;

  const accountId = decodeId("acc", params.id ?? "");
  // A malformed id answers exactly as an unknown one does. Returning early
  // also keeps a non-UUID out of the `.eq()` below, where PostgREST would
  // raise and turn a client typo into a Postora 500 — see ids.ts.
  if (accountId === null) return v1ErrorResponse("resource_not_found", requestId);

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  // D11's resource rule: outside the binding is `resource_not_found`, never
  // `resource_forbidden`. A distinct forbidden answer would confirm the
  // account exists, letting a stolen key enumerate the workspace it cannot
  // read.
  if (!bound.ids.includes(accountId)) {
    return v1ErrorResponse("resource_not_found", requestId);
  }

  const accounts = await fetchBoundAccounts(authed, [accountId]);
  if (!accounts.ok) return accounts.res;
  const account = accounts.accounts[0];
  // Bound but absent from social_accounts: the composite FKs make this
  // unreachable through normal writes, so it is a data defect rather than a
  // partner error. It still answers `resource_not_found` — the partner cannot
  // act on the difference, and inventing a 500 for it would turn a stale row
  // into a page of alerts.
  if (!account) return v1ErrorResponse("resource_not_found", requestId);

  return v1JsonResponse(present(account), requestId);
}
