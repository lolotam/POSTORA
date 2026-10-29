/**
 * Per-account cutover to the protected Meta credential authority.
 *
 * WHY THIS EXISTS
 *
 *   `credential_facebook_user_mode` is one global switch. Flipping it to
 *   `protected` moves every Facebook and Instagram account at once, and an
 *   account that has never reconnected has no protected credential: its
 *   refresh is refused, it leaves the health population, and its token runs
 *   out silently. A reconnect cannot fix that ahead of time either, because
 *   while the mode is `legacy` the OAuth `authorize` step always takes the
 *   legacy branch and never begins a protected attempt.
 *
 *   This module lets an account move on its own while the global mode stays
 *   `legacy`:
 *
 *     - an ACCOUNT runs protected when it already holds a protected authority
 *       (a Facebook User credential binding, or a direct Instagram
 *       credential) owned by the same user. Every other account stays legacy;
 *     - a USER listed in `credential_facebook_user_protected_pilot_user_ids`
 *       starts OAuth `authorize` on the protected branch, which is the only
 *       way an account gets a protected authority in the first place.
 *
 *   With the global mode set to `protected`, both answers are `protected`, as
 *   before. Nothing here can move an account from protected back to legacy.
 *
 * WHAT IS READ
 *
 *   Existence only: `social_account_id` and `user_id` of the two authority
 *   tables. No token column is ever selected.
 */

import {
  CredentialConfigurationError,
  type AppSettingLookup,
  type FacebookCredentialMode,
} from "./facebookCredentialMode.ts";

export const PROTECTED_PILOT_USERS_SETTING_KEY =
  "credential_facebook_user_protected_pilot_user_ids";

/**
 * The subset of a PostgREST client the authority read needs.
 *
 * `from` returns `unknown` on purpose: the generated Supabase client type is
 * too deep to check against a structural query type (TS2589). The narrow
 * query shape below is applied inside this module instead.
 */
export interface AuthorityReaderClient {
  from(table: string): unknown;
}

interface AuthorityQuery extends PromiseLike<{ data?: unknown; error?: unknown }> {
  in(column: string, values: string[]): AuthorityQuery;
}

interface AuthorityTable {
  select(columns: string): AuthorityQuery;
}

export interface CutoverAccount {
  id: string;
  userId: string;
  /**
   * Omit only when the caller knows the owned account id but not its row.
   * The authority tables hold Facebook and Instagram accounts only, so an
   * account without an authority row is legacy either way.
   */
  platform?: string;
}

/** Accounts that hold a protected authority, keyed by account and owner. */
export interface ProtectedAuthoritySet {
  has(account: { id: string; userId: string }): boolean;
}

const AUTHORITY_TABLES = [
  "facebook_user_credential_bindings",
  "instagram_account_credentials",
] as const;

const META_PLATFORMS = new Set(["facebook", "instagram"]);

function authorityKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function logAuthorityReadFailure(table: string): void {
  console.error("[protected-cutover] authority read failed", {
    event: "protected_authority_read_failed",
    table,
  });
}

/**
 * Reads which accounts hold a protected authority.
 *
 * `accountIds` narrows the read to the accounts a request is about. Without
 * it, every authority row is read, which the refresh sweep needs. A failed or
 * malformed read throws `CredentialConfigurationError`: an unknown answer is
 * never read as "legacy", because a protected account written through the
 * legacy path would contradict the protected fences.
 */
export async function readProtectedAuthorities(
  client: AuthorityReaderClient,
  accountIds?: readonly string[],
): Promise<ProtectedAuthoritySet> {
  const keys = new Set<string>();
  if (accountIds && accountIds.length === 0) return { has: () => false };

  for (const table of AUTHORITY_TABLES) {
    let query = (client.from(table) as AuthorityTable).select("social_account_id, user_id");
    if (accountIds) query = query.in("social_account_id", [...accountIds]);

    let response: { data?: unknown; error?: unknown };
    try {
      response = await query;
    } catch {
      logAuthorityReadFailure(table);
      throw new CredentialConfigurationError();
    }
    if (!response || response.error || !Array.isArray(response.data)) {
      logAuthorityReadFailure(table);
      throw new CredentialConfigurationError();
    }

    for (const row of response.data as Array<Record<string, unknown>>) {
      if (typeof row?.social_account_id !== "string" || typeof row?.user_id !== "string") {
        logAuthorityReadFailure(table);
        throw new CredentialConfigurationError();
      }
      keys.add(authorityKey(row.social_account_id, row.user_id));
    }
  }

  return { has: (account) => keys.has(authorityKey(account.id, account.userId)) };
}

/**
 * The credential mode one account runs in.
 *
 * Only Facebook and Instagram accounts are ever protected. A global
 * `protected` keeps today's behaviour for every Meta account. Under a global
 * `legacy`, a Meta account is protected exactly when it holds an authority
 * owned by the same user.
 */
export function accountCredentialMode(
  globalMode: FacebookCredentialMode,
  authorities: ProtectedAuthoritySet,
  account: CutoverAccount,
): FacebookCredentialMode {
  if (account.platform !== undefined && !META_PLATFORMS.has(account.platform)) return "legacy";
  if (globalMode === "protected") return "protected";
  return authorities.has(account) ? "protected" : "legacy";
}

/** One account, one narrowed read. Skips the read when the answer is fixed. */
export async function resolveAccountCredentialMode(
  globalMode: FacebookCredentialMode,
  client: AuthorityReaderClient,
  account: CutoverAccount,
): Promise<FacebookCredentialMode> {
  if (account.platform !== undefined && !META_PLATFORMS.has(account.platform)) return "legacy";
  if (globalMode === "protected") return "protected";
  // An id that is not a UUID can hold no authority row. Reading it would only
  // turn a caller's bad input into a configuration failure.
  if (typeof account.id !== "string" || !UUID_PATTERN.test(account.id.toLowerCase())) {
    return "legacy";
  }
  const authorities = await readProtectedAuthorities(client, [account.id]);
  return accountCredentialMode(globalMode, authorities, account);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parses the pilot list. Absent means nobody.
 *
 * Unlike the mode itself, an invalid list is NOT a refusal: the list only ever
 * widens the protected branch, so the safe reading of a typo is "nobody",
 * which is today's legacy behaviour. Refusing instead would block every
 * user's Meta connect over one bad admin edit.
 */
export function parseProtectedPilotUserIds(raw: unknown): ReadonlySet<string> | null {
  if (raw === null || raw === undefined) return new Set();
  if (!Array.isArray(raw)) return null;
  const ids = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") return null;
    const id = value.trim().toLowerCase();
    if (!UUID_PATTERN.test(id)) return null;
    ids.add(id);
  }
  return ids;
}

/**
 * Whether this user starts OAuth `authorize` on the protected branch while the
 * global mode is `legacy`. A failed read or an invalid list answers `false`.
 */
export async function isProtectedPilotUser(
  lookup: AppSettingLookup,
  userId: string,
): Promise<boolean> {
  let raw: unknown;
  try {
    const result = await lookup(PROTECTED_PILOT_USERS_SETTING_KEY);
    raw = result.found ? result.value : null;
  } catch {
    console.error("[protected-cutover] pilot list unavailable", {
      event: "protected_pilot_list_unavailable",
    });
    return false;
  }

  const ids = parseProtectedPilotUserIds(raw);
  if (ids === null) {
    console.error("[protected-cutover] pilot list invalid", {
      event: "protected_pilot_list_invalid",
    });
    return false;
  }
  return ids.has(userId.trim().toLowerCase());
}
