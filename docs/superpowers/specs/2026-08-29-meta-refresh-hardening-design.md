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
| `POST graph.threads.net/refresh_access_token` | 400 | `OAuthException` | `190` | Invalid OAuth access token |

All three parsed the credential out of the body. Threads was checked against both POST and the
current GET-with-query form and answered **identically**, so the migration is safe on the least
documented of the three endpoints. This also confirms the §2 design: Meta returns
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
gets a failure count and never the latch — see §2), which the existing `catch → return` path already
does correctly once §2 changes the return shape.

### A per-request timeout does not bound the sweep

Do the arithmetic the first draft skipped: **57 accounts × 10s = 570s against a 60s ceiling.** Six
consecutive timeouts exhaust the entire worker budget before any database or logging overhead. A
per-request bound stops one call hanging forever; it does nothing about the loop.

So the sweep needs its own deadline, not just its calls:

```ts
const SWEEP_BUDGET_MS = 45_000;          // leaves ~15s of the 60s ceiling to persist results
const startedAt = Date.now();
…
  if (Date.now() - startedAt > SWEEP_BUDGET_MS) {
    console.log(`[refresh-budget] stopping after ${processed} accounts; ${remaining} deferred to the next run`);
    break;                                // deferred, not failed — record status 'skipped'
  }
```

Deferred accounts must be reported as `skipped`, never `failed`: they were never attempted, so they
must not accrue a `failure_count`. The cron runs again, and because the loop always processes in the
same order, a persistent early hang would starve the tail — so accounts are ordered by
`last_refresh_attempt_at` ascending (nulls first), which naturally rotates the window.

With a 45s budget, the per-request timeout is set to **8s**: five consecutive worst-case hangs still
leave room to record results.

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

### 🔴 A transient failure must never latch the account

The first draft of this spec kept the generic `failureCount >= MAX_FAILURES_BEFORE_REAUTH` ceiling
unconditional. That is a rediscovery of the PR #66 outage:

> healthy Meta token → three DNS blips or timeouts → `failure_count = 3` → `needs_reauth = true` →
> the cron's `.or('needs_reauth.is.null,needs_reauth.eq.false')` filter excludes the row forever.

Three ordinary network failures would permanently retire a working account. The ceiling exists to
catch *repeated provider rejections*, not infrastructure noise, so a known-transient failure must
short-circuit before it:

```ts
if (providerError?.transient) return false;   // never latch on a timeout or network error
```

An account behind a persistently unreachable provider then simply keeps being retried, which is
correct — an unreachable provider is not evidence that a grant is dead. Platforms that pass no
`providerError` (every non-Meta adapter) are unaffected and keep the existing ceiling.

**The governing rule for this whole spec:** infrastructure failure adjusts *retry scheduling*; only a
provider-confirmed dead grant may operate the one-way reauth latch.

**Placement decision:** `PERMANENT_AUTH_ERRORS` and `isPermanentAuthError` live in
`refresh-tokens/index.ts:89-110`, but the adapters live in `_shared/`. Move the classification into
`_shared/metaErrors.ts` so both can import it. `refresh-tokens` re-exports nothing; it imports.

## §3 — Reduce the token-in-URL leak, per endpoint

The first draft proposed moving all three exchanges to POST. **Canary tests with real, valid
production tokens refuted that for two of the three** — the earlier malformed-body probes were
misleading, because a 400 that *looks* parsed is not proof the endpoint supports the method:

| endpoint | POST with a **valid** token | decision |
|---|---|---|
| `graph.facebook.com/v18.0/oauth/access_token` | ✅ returned a working token (verified against `/me`) | **migrate to POST** |
| `graph.instagram.com/refresh_access_token` | ❌ `Unsupported post request. Object with ID 'refresh_access_token' does not exist` | **keep GET** |
| `graph.threads.net/refresh_access_token` | ⚠️ unproven — both methods return the same `threads_basic` permission error, which masks method support | **keep GET** |

Had Instagram been migrated blind, all 21 business-login accounts would have failed every refresh
and — with the new code-190 classifier — latched red immediately. That is the #66 outage again, at
scale. Do not migrate an endpoint on the strength of an invalid-token probe; require a successful
exchange with a real credential.

Consequences:

1. **Facebook** moves to a POST body, removing the leak at the source for that endpoint.
2. **Instagram and Threads keep the credential in the query string.** Sanitised logging is therefore
   **load-bearing for them, not defence in depth** — it is the only thing standing between a network
   error and a leaked token.
3. **Every catch block is sanitised regardless of method.** Log `error.name` plus a fixed message.
   Never log the caught error object, the URL, or the request init.

Sanitised operational logging (satisfying line 512) logs only `type`, `code`, `error_subcode` and
`message` from `data.error` — never the request.

Re-canary Threads once an account holds a token with `threads_basic`; migrate it only then.

## §4 — Concurrency: deferred, deliberately

**Pulled from this spec on 2026-08-29 after review round 2.** It was scoped as a conditional UPDATE
with no new column; review showed that is not achievable correctly.

A per-caller expiry on a single timestamp is an asymmetric lease, not mutual exclusion: a cron worker
that claims at 12:00:00 and stalls is overtaken at 12:00:31 by an admin whose window is shorter, and
nothing stops the first worker committing afterwards. Making it correct requires an owner or fencing
token — the column the design existed to avoid — plus explicit release, plus a contention policy for
the JIT publisher, where losing a claim means the token is being changed *right now* and publishing
with the current one is the unsafe branch rather than the safe fallback.

Observed exposure is two admin tabs; the cron already has a five-minute cooldown. It does not earn
that complexity in this batch. `markRefreshAttempt` stays an unconditional fairness marker, and this
spec does not claim it is a lock.

What replaces it here is the work that *is* bounded and does earn its place: a sweep-wide budget, and
timeouts plus sanitized logging on the avatar path, which runs after every successful exchange and
today has neither — its fetchers put the token in the URL and log raw error objects, so the adapter
sanitization in §3 would otherwise be undone on the very next call.

## Testing

New `_shared/metaErrors.test.ts`:

- `OAuthException` + code 190 → permanent
- each of subcodes 458 / 460 / 463 / 467 → permanent
- **a message containing an unrelated ID (`"Object with ID '1190345' does not exist"`) → NOT
  permanent.** This is the regression test for the substring trap; it must exist.
- a transient outcome is never permanent, whatever its code
- `"Error validating access token"` matches via the phrase list

Escalation tests — the rule that has been wrong twice:

- a permanent provider error escalates on failure #1
- **three consecutive transient failures do NOT escalate** (the regression guard for the latch)
- a non-Meta platform with no `providerError` still escalates at the ceiling
- a platform that cannot refresh at all escalates immediately

Adapter tests with a stubbed `fetch`, **for all three adapters, not just Facebook**: success; revoked
(190); malformed 200 with no `access_token`; timeout → transient. For Facebook assert the credential
is in the body and absent from the URL; for Instagram and Threads assert the request is still a GET,
so a future well-meaning migration trips a test rather than production.

The timeout test must prove the signal is actually attached — stub `fetch` to reject with a
`DOMException("…", "TimeoutError")` and assert the outcome is transient. A plain immediate rejection
proves only that rejections are caught.

Claim tests: a second claim inside the window returns false; an admin claim out-waits 30s rather than
five minutes; a query error is reported as an error, not as a lost race.

Budget test: a sweep that exceeds `SWEEP_BUDGET_MS` stops and reports the remainder as `skipped`,
and those accounts' `failure_count` is untouched.

## Gates

`deno test supabase/functions/_shared/` (493 passing today) · `deno test
supabase/functions/refresh-tokens/` · `npx tsc -b --noEmit` · `bun run test` · `bun run build`.

Edge-function tests **are** now gated in CI — `origin/main` commit `6b20b0b6` *"ci: let the
edge-function tests actually gate a merge"* landed after this branch was cut, so rebase onto current
`main` before opening the PR and do not assume the pre-#68 CI shape.

Do **not** use `count(*) where needs_reauth and token_expires_at > now() = 0` as an acceptance gate.
It was a valid invariant before this change and is not after: a revoked grant keeps a future
`token_expires_at`, and marking exactly those rows red is the *purpose* of the code-190 classifier.
That gate would roll back a correct implementation. Verify instead that no account is red whose most
recent `token_refresh_history` row is a **transient** failure.

Deploy is manual per `docs/runbooks/deploy-edge-function.md`; verify volume SHA256 against the branch
and restart — **never** `up -d`. Diff the volume against the repo before deploying: `refresh-tokens`
has drifted ahead of git before.
