# Spec A — Meta Token Refresh Hardening

Date: 2026-08-29 · Subsystem: Supabase Edge Functions · Follows PR #66 and #68.

## Why now

PR #66 removed a guard that had made `refreshFacebookToken`, `refreshInstagramBusinessToken` and
`refreshThreadsToken` unreachable. Those three adapters now run against live Meta endpoints for the
first time. They were written years ago, never exercised, and violate three rules the project
already documents:

- `ARCHITECTURE.md` §26 *External HTTP Rules* — "All provider/API calls must have: explicit timeout,
  bounded retry policy where safe, response validation, sanitized logging, stable error mapping."
- `ARCHITECTURE.md` line 507 — an Edge Function must not "perform network calls without explicit
  timeout/retry policy".
- `ARCHITECTURE.md` line 512 — must not "swallow provider errors without logging a sanitized
  operational event".

This spec closes all three, plus a token-disclosure defect confirmed in production code.

## Evidence

**1. Deno embeds the full request URL — token included — in network errors.** Measured, not assumed:

```
MESSAGE: error sending request for url
  (https://graph.facebook.invalid/v18.0/oauth/access_token?...&fb_exchange_token=SECRET_TOKEN_ABC123):
  client error (Connect): dns error
LEAKS_TOKEN: true
```

All three adapters end in `catch (error) { console.error('Error refreshing … token:', error); }`.
Every Meta call passes the credential in the query string. **Live tokens are being written to logs
today**, on a path PR #66 just made reachable.

Timeout errors do *not* leak (`TimeoutError — The operation was aborted due to timeout`), so the
timeout work in §1 is safe to log as-is.

**2. Meta accepts these exchanges as POST.** Measured against the live API:

| request | status | `error.type` | `error.code` | message |
|---|---|---|---|---|
| `POST graph.facebook.com/v18.0/oauth/access_token` | 400 | `OAuthException` | `101` | Missing client_id parameter |
| `POST graph.instagram.com/refresh_access_token` | 400 | `OAuthException` | `190` | Invalid OAuth access token |

Both parsed the credential out of the body. This also confirms the §2 design: Meta returns
`type` and `code` as **structured JSON fields**, not as substrings of prose.

**3. `isPermanentAuthError` is a pure substring matcher** (`refresh-tokens/index.ts:100-110`):

```ts
return PERMANENT_AUTH_ERRORS.some(e => lowerError.includes(e.toLowerCase()));
```

Every one of its 12 current entries is a distinctive phrase (`invalid_grant`,
`Token has been expired or revoked`, …). The list's contract is phrases.

**4. `markRefreshAttempt` is an unconditional write, not a claim** (`refresh-tokens/index.ts`):

```ts
await supabaseAdmin.from('social_accounts')
  .update({ last_refresh_attempt_at: new Date().toISOString() })
  .eq('id', accountId);
```

Two workers both "mark" and both proceed. The optimistic-concurrency guard elsewhere keys on
`refresh_token`, which Meta rows never have, so Meta refreshes have no concurrency protection at all.

## Non-goals

- Retry logic. §26 says "bounded retry **where safe**"; a token exchange is not obviously safe to
  retry and the cron already re-runs. Explicitly out of scope.
- The ~52-day window where a user-revoked token stays green until its refresh window opens. Real,
  pre-existing, and orthogonal — recorded, not fixed here.
- Non-Meta adapters. They have refresh tokens and a different failure model.

---

## §1 — Explicit timeouts

Add `AbortSignal.timeout(10_000)` to every Meta exchange in `_shared/social-auth.ts`.

**Why 10s and why this matters more than it looks:** the refresh loop is *sequential* over accounts
and the edge worker has a hard 60s ceiling. A single hanging provider call doesn't merely slow the
sweep — it strands it, and every account after the hung one is silently never refreshed. That is the
same shape as the bug PR #66 fixed: a failure that presents as "nothing happened".

A timeout surfaces as `TimeoutError` from `fetch`. It must be treated as **transient** (the account
gets a failure count, not `needs_reauth`), which the existing `catch → return` path already does
correctly once §2 changes the return shape.

## §2 — Structured error propagation

**The contract change is the work.** Today:

```ts
refreshFacebookToken(account): Promise<{ access_token: string; expires_in: number } | null>
```

`null` erases *why*. The caller substitutes the literal `'Could not refresh token'`, so
`isPermanentAuthError` can never recognise a Meta revocation and a dead account waits three cycles.

New shape, applied to all three Meta adapters:

```ts
export type MetaRefreshOutcome =
  | { ok: true; access_token: string; expires_in: number }
  | { ok: false; error: MetaProviderError };

export interface MetaProviderError {
  type?: string;          // "OAuthException"
  code?: number;          // 190
  error_subcode?: number; // 458 | 460 | 463 | 467
  message?: string;
  transient: boolean;     // timeout / network / 5xx
}
```

Every call site in `refresh-tokens/index.ts` currently branches on `if (refreshResult)`. All of them
must move to `if (outcome.ok)`. **This is the whole risk surface of the task** — it is a contract
change across eight `switch` arms, not a logging tweak.

### Permanent-failure classification

⚠️ **Do NOT add numeric codes to `PERMANENT_AUTH_ERRORS`.** It is a substring matcher. `190`, `458`,
`460`, `463`, `467` would match those digit sequences *anywhere* — a Meta message such as
`(#100) Object with ID '1190345' does not exist` contains `190`, and would latch a healthy account
to `needs_reauth = true` permanently. That is precisely the failure class PR #66 removed; adding it
back through a different door would undo the win.

Instead add a typed predicate beside the matcher:

```ts
const META_PERMANENT_SUBCODES = new Set([458, 460, 463, 467]);

export function isPermanentMetaError(error: MetaProviderError): boolean {
  if (error.transient) return false;
  if (error.type === 'OAuthException' && error.code === 190) return true;
  return error.error_subcode !== undefined && META_PERMANENT_SUBCODES.has(error.error_subcode);
}
```

Add exactly one phrase to `PERMANENT_AUTH_ERRORS`: `"Error validating access token"`. It is a real
phrase and safe for substring matching.

`handleRefreshFailure` gains an optional `providerError` argument; when present and
`isPermanentMetaError` returns true, it escalates immediately instead of waiting for
`MAX_FAILURES_BEFORE_REAUTH`.

**Placement decision:** `PERMANENT_AUTH_ERRORS` and `isPermanentAuthError` live in
`refresh-tokens/index.ts:89-110`, but the adapters live in `_shared/`. Move the classification into
`_shared/metaErrors.ts` so both can import it. `refresh-tokens` re-exports nothing; it imports.

## §3 — Eliminate the token-in-URL leak

Two layers, because either alone is insufficient:

1. **Move the credential into a POST body** for all three Meta exchanges (verified accepted above).
   This removes the leak at the source — no future logger, proxy, trace or error string can capture
   what is no longer in the URL. Sanitising log statements alone leaves a live landmine for the next
   person who adds a log line.
2. **Sanitise the catch blocks anyway**, as defence in depth. Log `error.name` plus a fixed message.
   Never log the caught error object, the URL, or the request init.

Sanitised operational logging (satisfying line 512) logs only `type`, `code`, `error_subcode` and
`message` from `data.error` — never the request.

## §4 — Atomic refresh claim

Replace `markRefreshAttempt`'s unconditional write with a conditional claim. No new column, no
migration:

```ts
const cutoff = new Date(Date.now() - REFRESH_ATTEMPT_COOLDOWN_MS).toISOString();
const { data } = await supabaseAdmin
  .from('social_accounts')
  .update({ last_refresh_attempt_at: new Date().toISOString() })
  .eq('id', accountId)
  .or(`last_refresh_attempt_at.is.null,last_refresh_attempt_at.lt.${cutoff}`)
  .select('id');

return (data?.length ?? 0) > 0;   // false = another worker owns this account
```

A caller that fails to claim records `status: 'cooldown'` and moves on.

**Interaction with the admin path — decide deliberately.** `adminTriggered` currently bypasses the
cooldown on purpose (PR #66 ported that behaviour from production). The claim must *not* be bypassed,
or it protects nothing. Resolution: the admin path keeps bypassing the **refresh-window** check but
respects the **claim**. An admin pressing Refresh twice in five minutes gets `cooldown` on the second
press — correct, and the intent of the hotfix (reach every account regardless of expiry) is preserved.

## Testing

New `_shared/metaErrors.test.ts`:

- `OAuthException` + code 190 → permanent
- each of subcodes 458 / 460 / 463 / 467 → permanent
- **a message containing an unrelated ID (`"Object with ID '1190345' does not exist"`) → NOT
  permanent.** This is the regression test for the substring trap; it must exist.
- a transient outcome is never permanent, whatever its code
- `"Error validating access token"` matches via the phrase list

Adapter tests with a stubbed `fetch`: success; revoked (190); malformed 200 with no `access_token`;
timeout → transient. Assert the request body carries the credential and the URL does not.

Claim test: second claim inside the cooldown returns false.

## Gates

`deno test supabase/functions/_shared/` (currently 493 passing) · `deno test
supabase/functions/refresh-tokens/` · `npx tsc -b --noEmit` · `bun run test` · `bun run build`.

Deploy is manual per `docs/runbooks/deploy-edge-function.md`; verify volume SHA256 against the branch
and restart — **never** `up -d`. Diff the volume against the repo before deploying: `refresh-tokens`
has drifted ahead of git before.
