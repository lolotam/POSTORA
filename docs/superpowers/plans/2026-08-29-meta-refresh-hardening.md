# Meta Token Refresh Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three Meta token-exchange adapters — reachable in production for the first time since PR #66 — comply with `ARCHITECTURE.md` §26: explicit timeouts, structured error propagation, sanitized logging, and a real concurrency claim.

**Architecture:** A new `_shared/metaErrors.ts` owns the Meta error shape and the permanent/transient classification, so both the adapters (`_shared/`) and the escalation logic (`refresh-tokens/`) can import it without a circular dependency. The three adapters change return type from `… | null` to a discriminated `MetaRefreshOutcome`, which is the task's whole risk surface — seven adapter invocations inside `refresh-tokens/index.ts` plus one in `process-scheduled-posts/index.ts` branch on the old shape, and they must all move in a single commit. The credential moves from the query string into a POST body, which removes the token-disclosure class outright rather than sanitizing around it.

**Tech Stack:** Deno edge functions (Supabase self-hosted), `deno test`, PostgREST via `@supabase/supabase-js`.

**Spec:** `docs/superpowers/specs/2026-08-29-meta-refresh-hardening-design.md`

## Global Constraints

- **NEVER log a caught fetch error object, a request URL, or a request init.** Deno embeds the full URL — token included — in network error messages; this is measured, not theoretical. Log `error.name` plus a fixed string, or sanitized `data.error` fields only.
- **NEVER add numeric codes to `PERMANENT_AUTH_ERRORS`.** It is a substring matcher (`refresh-tokens/index.ts:100-110`). `190` would match `"Object with ID '1190345'"` and latch a healthy account red — the exact bug class PR #66 removed.
- A timeout is **transient**, never permanent. It must never produce `needs_reauth` — **including via the `failureCount >= MAX_FAILURES_BEFORE_REAUTH` ceiling.** Three DNS blips must not retire a healthy account; that is the PR #66 outage rediscovered. Infrastructure failure adjusts retry scheduling; only a provider-confirmed dead grant operates the latch.
- **Tasks 2 and 3 are ONE commit.** The adapters' return type and every consumer change together. Committing the contract change alone leaves a tree where `{ok:false}` is truthy to existing callers — actively worse than before.
- **Facebook migrates to POST; Instagram and Threads stay on GET.** Verified with real tokens: IG answers `Unsupported post request`, and Threads is unproven behind a permission error. Migrating them blind would fail every refresh and, with the new classifier, latch 21+ accounts red.
- Only `handleRefreshSuccess` may clear `needs_reauth` / `failure_count` / `last_refresh_error`. Never pre-clear before proving a refresh worked (regression fixed in PR #66).
- Out of scope: retry logic; the ~52-day revoked-token window; non-Meta adapters.
- Gates: `deno test supabase/functions/_shared/` (493 passing today), `deno test supabase/functions/refresh-tokens/`, `npx tsc -b --noEmit`, `bun run test`, `bun run build`.
- Work in the worktree `F:/Postora_wt/reauth-fix`. Never edit `F:/Postora_new` — another agent drives that checkout's HEAD.
- Read `ARCHITECTURE.md` §26 and the anti-pattern list at line 507 before touching code.

---

### Task 1: Meta error classification

**Files:**
- Create: `supabase/functions/_shared/metaErrors.ts`
- Create: `supabase/functions/_shared/metaErrors.test.ts`

**Interfaces:**
- Produces: `MetaProviderError`, `MetaRefreshOutcome`, `isPermanentMetaError(error: MetaProviderError): boolean`, `parseMetaError(status: number, body: unknown): MetaProviderError` — all consumed by Tasks 2, 3 and 4.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/metaErrors.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isPermanentMetaError, parseMetaError } from "./metaErrors.ts";

Deno.test("OAuthException code 190 is a permanent auth failure", () => {
  assertEquals(
    isPermanentMetaError({ type: "OAuthException", code: 190, transient: false }),
    true,
  );
});

Deno.test("each documented permanent subcode escalates", () => {
  for (const sub of [458, 460, 463, 467]) {
    assertEquals(
      isPermanentMetaError({ type: "OAuthException", code: 200, error_subcode: sub, transient: false }),
      true,
      `subcode ${sub} should be permanent`,
    );
  }
});

Deno.test("an unrelated ID containing 190 is NOT permanent", () => {
  // The regression guard for the substring trap: PERMANENT_AUTH_ERRORS matches
  // substrings, so a numeric code in that list would match this message and latch
  // a healthy account to needs_reauth forever.
  assertEquals(
    isPermanentMetaError({
      type: "OAuthException",
      code: 100,
      message: "(#100) Object with ID '1190345' does not exist",
      transient: false,
    }),
    false,
  );
});

Deno.test("a transient failure is never permanent, whatever its code", () => {
  assertEquals(isPermanentMetaError({ type: "OAuthException", code: 190, transient: true }), false);
});

Deno.test("parseMetaError extracts the sanitized fields and marks 5xx transient", () => {
  const permanent = parseMetaError(400, {
    error: { type: "OAuthException", code: 190, error_subcode: 463, message: "Session expired" },
  });
  assertEquals(permanent.type, "OAuthException");
  assertEquals(permanent.code, 190);
  assertEquals(permanent.error_subcode, 463);
  assertEquals(permanent.transient, false);

  assertEquals(parseMetaError(503, { error: { message: "upstream" } }).transient, true);
});

Deno.test("a rate limit is transient, so three of them cannot latch an account", () => {
  // 429 is not >= 500. Without explicit handling this reads as a hard failure and, after
  // three, crosses the ceiling and retires a healthy account.
  for (const code of [4, 17, 32, 613]) {
    assertEquals(
      parseMetaError(429, { error: { type: "OAuthException", code, message: "rate limited" } }).transient,
      true,
      `code ${code} is a rate limit and must be transient`,
    );
  }
});

Deno.test("structured permanent evidence outranks a 5xx status", () => {
  // A revoked grant reported alongside a server error must not be retried forever.
  assertEquals(
    parseMetaError(500, {
      error: { type: "OAuthException", code: 190, error_subcode: 463, message: "Session expired" },
    }).transient,
    false,
  );
});

Deno.test("parseMetaError survives a body with no error object", () => {
  const e = parseMetaError(200, { nonsense: true });
  assertEquals(e.transient, false);
  assertEquals(e.code, undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/_shared/metaErrors.test.ts`
Expected: FAIL — module `./metaErrors.ts` not found.

- [ ] **Step 3: Implement**

Create `supabase/functions/_shared/metaErrors.ts`:

```ts
/**
 * Meta's structured error payload, reduced to the fields that are safe to log.
 *
 * Never widen this to carry the request URL or the raw fetch error: Meta passes the
 * credential in the request, and Deno embeds the full URL in network error messages.
 */
export interface MetaProviderError {
  type?: string;
  code?: number;
  error_subcode?: number;
  message?: string;
  /** Timeout, network failure or 5xx — retryable, and never a reason to force reauth. */
  transient: boolean;
}

export type MetaRefreshOutcome =
  | { ok: true; access_token: string; expires_in: number }
  | { ok: false; error: MetaProviderError };

/** Subcodes Meta documents as "the user must re-authorize". */
const META_PERMANENT_SUBCODES = new Set([458, 460, 463, 467]);

/**
 * Whether this failure means the grant is dead and no retry will help.
 *
 * Deliberately typed, not string-matched: PERMANENT_AUTH_ERRORS in refresh-tokens is a
 * substring matcher, and putting a bare `190` in it would match any message containing
 * those digits — an object id, a timestamp — and permanently flag a healthy account.
 */
export function isPermanentMetaError(error: MetaProviderError): boolean {
  if (error.transient) return false;
  if (error.type === "OAuthException" && error.code === 190) return true;
  return error.error_subcode !== undefined && META_PERMANENT_SUBCODES.has(error.error_subcode);
}

/**
 * Meta rate-limit codes. Not invented here — `_shared/threads-debug.ts:331-333` already
 * classifies exactly these, and duplicating that knowledge incompletely is how a rate
 * limit ends up counted as an auth failure.
 */
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** HTTP statuses that mean "ask again later", not "this grant is dead". */
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

/**
 * Reduce a Meta response to the sanitized fields worth logging, and decide whether the
 * failure is retryable.
 *
 * `transient` is NOT simply `status >= 500`. That naive rule is wrong in both directions:
 *   - HTTP 429 with code 4/17/32/613 is a rate limit, but would read as non-transient and,
 *     after three of them, latch a perfectly healthy account red.
 *   - HTTP 500 carrying {type:"OAuthException", code:190} is definitive evidence the grant
 *     is dead, but would read as transient and be retried forever.
 * Structured provider evidence therefore wins over the HTTP status.
 */
export function parseMetaError(status: number, body: unknown): MetaProviderError {
  const raw = (body as { error?: Record<string, unknown> } | null)?.error;
  const code = typeof raw?.code === "number" ? raw.code : undefined;
  const subcode = typeof raw?.error_subcode === "number" ? raw.error_subcode : undefined;
  const type = typeof raw?.type === "string" ? raw.type : undefined;

  // 1. A structured permanent code outranks any status.
  const structurallyPermanent =
    (type === "OAuthException" && code === 190) ||
    (subcode !== undefined && META_PERMANENT_SUBCODES.has(subcode));

  // 2. A structured rate limit is retryable however the status reads.
  const structurallyRetryable =
    (code !== undefined && META_RATE_LIMIT_CODES.has(code)) ||
    raw?.is_transient === true;

  const transient = structurallyPermanent
    ? false
    : structurallyRetryable || RETRYABLE_STATUSES.has(status) || status >= 500;

  return {
    type,
    code,
    error_subcode: subcode,
    message: typeof raw?.message === "string" ? raw.message : undefined,
    transient,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-env supabase/functions/_shared/metaErrors.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/metaErrors.ts supabase/functions/_shared/metaErrors.test.ts
git commit -m "feat(meta): classify Meta provider errors by typed code, not substring"
```

---

### Task 2: Adapters — POST body, timeout, structured outcome

**Files:**
- Modify: `supabase/functions/_shared/social-auth.ts` (`refreshFacebookToken`, `refreshInstagramBusinessToken`, `refreshThreadsToken`)
- Create: `supabase/functions/_shared/metaAdapters.test.ts`

**Interfaces:**
- Consumes: `MetaRefreshOutcome`, `parseMetaError` (Task 1).
- Produces: all three adapters return `Promise<MetaRefreshOutcome>` — consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/metaAdapters.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { refreshFacebookToken } from "./social-auth.ts";

const account = {
  id: "a1", platform: "facebook", access_token: "SECRET_TOKEN",
  refresh_token: null, token_expires_at: null, platform_user_id: "p1", user_id: "u1",
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

Deno.test("the credential travels in the POST body, never the URL", async () => {
  let seenUrl = ""; let seenBody = "";
  const restore = stubFetch((url, init) => {
    seenUrl = url; seenBody = String(init?.body);
    return new Response(JSON.stringify({ access_token: "new", expires_in: 5184000 }), { status: 200 });
  });
  try {
    const outcome = await refreshFacebookToken(account);
    assertEquals(outcome.ok, true);
    assertEquals(seenUrl.includes("SECRET_TOKEN"), false);
    assertEquals(seenBody.includes("SECRET_TOKEN"), true);
  } finally { restore(); }
});

Deno.test("a revoked token comes back as a permanent structured error", async () => {
  const restore = stubFetch(() =>
    new Response(JSON.stringify({
      error: { type: "OAuthException", code: 190, error_subcode: 463, message: "Session expired" },
    }), { status: 400 }));
  try {
    const outcome = await refreshFacebookToken(account);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.code, 190);
      assertEquals(outcome.error.error_subcode, 463);
      assertEquals(outcome.error.transient, false);
    }
  } finally { restore(); }
});

Deno.test("a 200 with no access_token is a failure, not a success", async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
  try {
    assertEquals((await refreshFacebookToken(account)).ok, false);
  } finally { restore(); }
});

Deno.test("a network failure is transient", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("error sending request for url (https://x?access_token=SECRET_TOKEN)"))) as typeof fetch;
  try {
    const outcome = await refreshFacebookToken(account);
    assertEquals(outcome.ok, false);
    if (!outcome.ok) assertEquals(outcome.error.transient, true);
  } finally { globalThis.fetch = original; }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env --allow-net supabase/functions/_shared/metaAdapters.test.ts`
Expected: FAIL — the adapter still returns `null` / passes the token in the URL.

- [ ] **Step 3: Implement `refreshFacebookToken`**

Replace the body of `refreshFacebookToken` in `supabase/functions/_shared/social-auth.ts`:

```ts
export async function refreshFacebookToken(account: SocialAccount): Promise<MetaRefreshOutcome> {
    // POST, not a query string: Meta accepts the credential in the body, and keeping it
    // out of the URL means no logger, proxy or fetch error can ever capture it.
    try {
        const response = await fetch("https://graph.facebook.com/v18.0/oauth/access_token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "fb_exchange_token",
                client_id: Deno.env.get("FACEBOOK_APP_ID") ?? "",
                client_secret: Deno.env.get("FACEBOOK_APP_SECRET") ?? "",
                fb_exchange_token: account.access_token,
            }),
            signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
        });

        const data = await response.json();

        if (!response.ok || data.error || !data.access_token) {
            const error = parseMetaError(response.status, data);
            console.error("[meta-refresh] facebook exchange failed", {
                type: error.type, code: error.code, error_subcode: error.error_subcode, message: error.message,
            });
            return { ok: false, error };
        }

        return { ok: true, access_token: data.access_token, expires_in: data.expires_in || 5184000 };
    } catch (error) {
        // Never log the error object: Deno puts the full request URL in network error
        // messages, and that URL would carry the token if it were ever moved back.
        const name = error instanceof Error ? error.name : "UnknownError";
        console.error(`[meta-refresh] facebook exchange threw: ${name}`);
        return { ok: false, error: { type: name, message: "network or timeout failure", transient: true } };
    }
}
```

Add near the top of the file:

```ts
import { type MetaRefreshOutcome, parseMetaError } from "./metaErrors.ts";

/** Provider calls must be bounded (ARCHITECTURE.md §26). The refresh loop is sequential
 *  and the edge worker dies at 60s, so one hang strands every account after it.
 *  8s, not 10s: with the 45s sweep budget in Task 5, five consecutive worst-case hangs
 *  must still leave room to persist results. */
const META_FETCH_TIMEOUT_MS = 8_000;
```

- [ ] **Step 4: Implement the other two adapters — ⚠️ THEY STAY ON GET**

🔴 Do **not** convert these to POST. Canary tests against the live API with real production tokens
proved it breaks them:

| endpoint | POST with a valid token |
|---|---|
| `graph.instagram.com/refresh_access_token` | `Unsupported post request. Object with ID 'refresh_access_token' does not exist` |
| `graph.threads.net/refresh_access_token` | unproven — both methods return the same `threads_basic` permission error |

Migrating Instagram would fail every refresh for the 21 business-login accounts and, with the new
code-190 classifier, latch them all red immediately.

So `refreshInstagramBusinessToken` and `refreshThreadsToken` keep their existing
**GET-with-query-string** request shape, unchanged. What they gain is only:

- `signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS)` on the existing `fetch`
- the `!response.ok || data.error || !data.access_token` check
- `return { ok: false, error: parseMetaError(response.status, data) }` instead of `null`
- the sanitized `console.error` shape, and a `catch` that logs **only** `error.name`

⚠️ For these two the sanitized catch is **load-bearing, not defence in depth** — the credential is
still in the URL, and Deno embeds the URL in network errors. Logging the caught error object here
leaks a live token.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test --allow-env --allow-net supabase/functions/_shared/metaAdapters.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Prove no adapter puts a token in a URL**

```bash
grep -n "access_token=\${\|fb_exchange_token=\${" supabase/functions/_shared/social-auth.ts
```
Expected: **no hit inside `refreshFacebookToken`** (it now POSTs). Hits inside
`refreshInstagramBusinessToken` and `refreshThreadsToken` are **correct and required** — those
endpoints reject POST. Confirm each remaining Meta hit is one of those two.

Then confirm no adapter logs a raw error object:

```bash
grep -n "console.error(.*, *error)" supabase/functions/_shared/social-auth.ts
```
Expected: no output. Every catch logs `error.name` only.

- [ ] **Step 7: DO NOT COMMIT YET**

🔴 The adapters' new return type and **every** consumer must land in one commit. Between the two,
existing callers treat `{ ok: false }` as truthy and would write `access_token: undefined` over live
credentials — a tree that is actively worse than before the change. Leave this work staged and
continue straight into Task 3; the commit at the end of Task 3 covers both.

Run the adapter tests now to confirm this half is right, then move on without committing:

```bash
deno test --allow-env --allow-net supabase/functions/_shared/metaAdapters.test.ts
```

---

### Task 3: Escalate permanent Meta failures immediately

**Files:**
- Modify: `supabase/functions/refresh-tokens/index.ts` — `handleRefreshFailure`, `PERMANENT_AUTH_ERRORS`, and every `case` that calls a Meta adapter
- Modify: `supabase/functions/process-scheduled-posts/index.ts:106-150` — **a second consumer outside `refresh-tokens/`**
- Create: `supabase/functions/refresh-tokens/escalation.test.ts`

**Interfaces:**
- Consumes: `MetaRefreshOutcome`, `isPermanentMetaError` (Task 1); the adapters' new return type (Task 2).
- Produces: `handleRefreshFailure(supabaseAdmin, account, errorMessage, providerError?)`.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/refresh-tokens/escalation.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldEscalateToReauth } from "./escalation.ts";

const MAX = 3;

Deno.test("a permanent Meta error escalates on the first failure", () => {
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 1, maxFailures: MAX, isPermanentMessage: false,
      canAttemptRefresh: true,
      providerError: { type: "OAuthException", code: 190, transient: false },
    }),
    true,
  );
});

Deno.test("a transient Meta error does not escalate early", () => {
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 1, maxFailures: MAX, isPermanentMessage: false,
      canAttemptRefresh: true,
      providerError: { type: "TimeoutError", transient: true },
    }),
    false,
  );
});

Deno.test("three transient failures do NOT latch a healthy account", () => {
  // The regression guard. The ceiling exists for repeated provider REJECTIONS, not for
  // infrastructure noise: three DNS blips must never retire a working account, because
  // the cron then excludes it forever (`needs_reauth.is.null,needs_reauth.eq.false`).
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 3, maxFailures: MAX, isPermanentMessage: false,
      canAttemptRefresh: true,
      providerError: { type: "TimeoutError", transient: true },
    }),
    false,
  );
});

Deno.test("a non-Meta failure with no provider error still escalates at the ceiling", () => {
  // Unchanged behaviour for every adapter that reports no structured error.
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 3, maxFailures: MAX, isPermanentMessage: false, canAttemptRefresh: true,
    }),
    true,
  );
});

Deno.test("a platform that cannot refresh at all escalates immediately", () => {
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 1, maxFailures: MAX, isPermanentMessage: false, canAttemptRefresh: false,
    }),
    true,
  );
});

Deno.test("a permanent message escalates with no provider error present", () => {
  assertEquals(
    shouldEscalateToReauth({
      failureCount: 1, maxFailures: MAX, isPermanentMessage: true, canAttemptRefresh: true,
    }),
    true,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/refresh-tokens/escalation.test.ts`
Expected: FAIL — module `./escalation.ts` not found.

- [ ] **Step 3: Implement the pure decision**

Create `supabase/functions/refresh-tokens/escalation.ts`:

```ts
import { isPermanentMetaError, type MetaProviderError } from "../_shared/metaErrors.ts";

/**
 * Should this failure flip the account to needs_reauth now, rather than after
 * MAX_FAILURES_BEFORE_REAUTH attempts?
 *
 * Extracted as a pure function so the decision is testable without a database: it is
 * the rule that decides whether a working account goes red, and it has been wrong twice.
 */
export function shouldEscalateToReauth(input: {
  failureCount: number;
  maxFailures: number;
  isPermanentMessage: boolean;
  canAttemptRefresh: boolean;
  providerError?: MetaProviderError;
}): boolean {
  if (input.isPermanentMessage) return true;
  if (!input.canAttemptRefresh) return true;
  if (input.providerError && isPermanentMetaError(input.providerError)) return true;

  // A known-transient failure never latches, at any count. An unreachable provider is
  // not evidence that a grant is dead, and the latch is one-way: the cron filters
  // flagged rows out, so a wrongly-latched account is never retried again.
  if (input.providerError?.transient) return false;

  return input.failureCount >= input.maxFailures;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-env supabase/functions/refresh-tokens/escalation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Use it in `handleRefreshFailure`**

Add the optional parameter and replace the inline boolean:

```ts
async function handleRefreshFailure(
  supabaseAdmin: AnySupabase,
  account: SocialAccountWithDetails,
  errorMessage: string,
  providerError?: MetaProviderError,
): Promise<{ needsReauth: boolean; shouldAlert: boolean }> {
  const currentFailureCount = (account.failure_count || 0) + 1;
  const isPermanentError = isPermanentAuthError(errorMessage) || errorMessage.includes('Token limit exceeded');
  const needsReauth = shouldEscalateToReauth({
    failureCount: currentFailureCount,
    maxFailures: MAX_FAILURES_BEFORE_REAUTH,
    isPermanentMessage: isPermanentError,
    canAttemptRefresh: accountCanAttemptRefresh(account),
    providerError,
  });
```

Leave the rest of the function unchanged — in particular it must still only ever *set*
`needs_reauth = true`, never clear it.

- [ ] **Step 6: Add the one safe phrase**

In `PERMANENT_AUTH_ERRORS` (`refresh-tokens/index.ts:89`), append:

```ts
  // Meta's revoked-grant phrase. Codes and subcodes are handled by isPermanentMetaError —
  // never put a bare number in this list, it is matched as a substring.
  'Error validating access token',
```

- [ ] **Step 7: Update every Meta call site to the outcome shape**

In both the `refreshSingleAccount` switch and the bulk-loop switch, the Meta arms change from
`if (refreshResult)` to the discriminated form. Facebook/Instagram, bulk loop:

```ts
          case 'facebook':
          case 'instagram': {
            const outcome = metaRefreshStrategy(account) === 'ig_refresh'
              ? await refreshInstagramBusinessToken(account)
              : await refreshFacebookToken(account);

            if (outcome.ok) {
              const expiresAt = new Date();
              expiresAt.setSeconds(expiresAt.getSeconds() + outcome.expires_in);
              const { updated } = await handleRefreshSuccess(supabaseAdmin, account.id, oldRefreshToken, outcome.access_token, expiresAt.toISOString());
              if (updated) {
                const avatarRefreshed = await refreshAndCacheAvatar(account, outcome.access_token, supabaseAdmin);
                results.push({ id: account.id, platform: account.platform, status: 'refreshed', avatarRefreshed });
              } else {
                results.push({ id: account.id, platform: account.platform, status: 'already_refreshed' });
              }
            } else {
              const message = outcome.error.message || 'Could not refresh token';
              const { needsReauth, shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, message, outcome.error);
              results.push({ id: account.id, platform: account.platform, status: needsReauth ? 'needs_reauth' : 'failed', error: message });
              if (shouldAlert) accountsToAlert.push(account);
            }
            break;
          }
```

Apply the same transformation to the `threads` arm in both switches, and to the
`facebook`/`instagram`/`threads` arms inside `refreshSingleAccount` (which `return`s instead of
pushing to `results`).

- [ ] **Step 8: Fix the second consumer — `process-scheduled-posts` (DO NOT SKIP)**

🔴 `supabase/functions/process-scheduled-posts/index.ts` also calls `refreshFacebookToken`, in the
just-in-time refresh before publishing a scheduled post. It is the highest-consequence call site in
the repo and it is **not** in `refresh-tokens/`.

Today (`:106-150`):

```ts
let refreshResult = null;
…
    refreshResult = await refreshFacebookToken(account);   // :112
…
if (refreshResult) {                                        // :129
  const updates: any = {
    access_token: refreshResult.access_token,
    token_expires_at: expiresAt.toISOString(),
  };
  await supabaseAdmin.from('social_accounts').update(updates).eq('id', account.id);
}
```

After the contract change a **failed** refresh returns `{ ok: false, error }`, which is **truthy**.
`if (refreshResult)` would pass, and the function would write `access_token: undefined` and an
Invalid Date over a working token — destroying credentials moments before publishing. Rewrite that
arm to the outcome shape:

```ts
                    case 'facebook':
                    case 'instagram': {
                      // Route by ig_auth_type, exactly as refresh-tokens does. This file
                      // still sends every Instagram account to the Facebook exchange —
                      // the same defect PR #66 fixed on the other path but never here, so
                      // Business Login accounts (21 of 27) hit the wrong endpoint.
                      const outcome = metaRefreshStrategy(account) === 'ig_refresh'
                        ? await refreshInstagramBusinessToken(account)
                        : await refreshFacebookToken(account);
                      refreshResult = outcome.ok
                        ? { access_token: outcome.access_token, expires_in: outcome.expires_in }
                        : null;
                      break;
                    }
```

Import `metaRefreshStrategy` from `../refresh-tokens/refreshEligibility.ts` and
`refreshInstagramBusinessToken` from `../_shared/social-auth.ts`. If importing across function
directories is undesirable, move `metaRefreshStrategy` into `_shared/` first — check
`ARCHITECTURE.md` for the rule before choosing.

Adapting at the boundary keeps the surrounding `if (refreshResult)` block — and the three non-Meta
adapters that still return the old shape — working unchanged. That is deliberately the smaller
change: this file publishes posts, and is not where a broader refactor belongs.

⚠️ It must also claim the account before refreshing (Task 4), or a scheduled publish can race a cron
sweep on the same row. On a failed claim, skip the JIT refresh and publish with the existing token —
which is already what this file does when a refresh fails, so no new failure path is introduced.

- [ ] **Step 9: Prove no call site still uses the old shape**

```bash
grep -rn "refreshFacebookToken\|refreshInstagramBusinessToken\|refreshThreadsToken" supabase/functions/ --include=*.ts | grep -v "_shared/social-auth.ts"
```
Check **every** hit across the whole `supabase/functions/` tree, not just `refresh-tokens/`. Each
must consume `outcome.ok`, or adapt to `null` at the boundary as in Step 8.

⚠️ **Do not rely on `deno check` to catch a missed site.** `deno check
supabase/functions/process-scheduled-posts/index.ts` **already fails today** with a pre-existing
`TS18046: 'refreshError' is of type 'unknown'` at `:125`, so a new error there would be lost in
existing noise — and `refreshResult` is declared `let refreshResult = null`, which widens, so the
truthiness bug may not surface as a type error at all. The grep above is the real gate.

- [ ] **Step 10: Run the gates and commit**

```bash
deno test --allow-env --allow-read --allow-net supabase/functions/_shared/ supabase/functions/refresh-tokens/
npx tsc -b --noEmit
git add supabase/functions/refresh-tokens/ supabase/functions/_shared/ supabase/functions/process-scheduled-posts/
git commit -m "fix(meta): return a structured refresh outcome and escalate revoked grants at once

Adapters, refresh-tokens and process-scheduled-posts move together: a partial
migration leaves {ok:false} truthy to old callers, which would write an undefined
access_token over a working credential."
```

This single commit contains Task 2 and Task 3 in full.

---

### Task 4: Bound the whole sweep, and close the second leak

The per-request timeout in Task 2 bounds one call. It does **not** bound the sweep, and it does not
touch the other unbounded provider work on the same path.

**Files:**
- Modify: `supabase/functions/refresh-tokens/index.ts` — the bulk loop
- Modify: `supabase/functions/_shared/avatar-cache.ts` — timeouts and sanitized logging

- [ ] **Step 1: Do the arithmetic that justifies this task**

57 accounts × 8s = 456s against a 60s worker ceiling. Seven consecutive slow calls exhaust the
budget. A per-request timeout cannot fix that; only a sweep-wide deadline can.

- [ ] **Step 2: Add the budget to the bulk loop**

```ts
/** Leaves ~15s of the 60s worker ceiling to persist results and log. */
const SWEEP_BUDGET_MS = 45_000;
const sweepStartedAt = Date.now();
```

At the top of the per-account loop:

```ts
      if (Date.now() - sweepStartedAt > SWEEP_BUDGET_MS) {
        console.log(`[refresh-budget] budget spent; deferring ${accountsNeedingRefresh.length - processed} accounts to the next run`);
        for (const deferred of accountsNeedingRefresh.slice(processed)) {
          results.push({ id: deferred.id, platform: deferred.platform, status: 'skipped', error: 'Deferred: sweep budget spent' });
        }
        break;
      }
```

⚠️ Deferred accounts are `skipped`, never `failed`. They were never attempted, so
`handleRefreshFailure` must not run for them — otherwise the budget itself would increment
`failure_count` and, three sweeps later, latch healthy accounts.

- [ ] **Step 3: Order the selection so the tail cannot starve**

Add `.order('last_refresh_attempt_at', { ascending: true, nullsFirst: true })` to the account query.
Never-attempted accounts lead; an account just attempted sorts last. Because the sweep always stops
at the same budget, without this the same head-of-list accounts would be refreshed every run and the
tail never reached.

- [ ] **Step 4: Bound and sanitize the avatar path — it is the second token leak**

`refreshAndCacheAvatar` runs after every successful exchange, and `_shared/avatar-cache.ts` has
**zero** timeouts (`grep -c "AbortSignal\|signal:"` → 0) while logging raw error objects:

```ts
console.error("[avatar-cache] Error fetching Facebook avatar:", error);   // :114
console.error("[avatar-cache] Error fetching Instagram avatar:", error);  // :127
```

Those fetchers put the access token in the URL, and Deno embeds the URL in network errors — so
sanitizing the adapters achieves nothing if the very next call on the same execution leaks the same
credential. Add `signal: AbortSignal.timeout(8_000)` to every `fetch` in the file, and change every
`console.error(..., error)` to log `error instanceof Error ? error.name : "UnknownError"`.

- [ ] **Step 5: Verify and commit**

```bash
grep -c "AbortSignal.timeout" supabase/functions/_shared/avatar-cache.ts     # one per fetch
grep -n "console.error(.*, *error)" supabase/functions/_shared/avatar-cache.ts   # expect no output
deno test --allow-env --allow-read --allow-net supabase/functions/_shared/ supabase/functions/refresh-tokens/
npx tsc -b --noEmit
git add supabase/functions/refresh-tokens/ supabase/functions/_shared/avatar-cache.ts
git commit -m "fix(refresh-tokens): bound the whole sweep, and stop the avatar path leaking tokens"
```

---

### Task 5 (DEFERRED — do not implement in this batch): the concurrency claim

**Status: pulled from this plan on 2026-08-29, after adversarial review round 2.**

The claim was scoped as "small and self-contained: a conditional UPDATE, no new column." Two review
rounds showed it is not. Every attempt to make it correct grew it:

- **A per-caller window is not mutual exclusion.** Cron claims at 12:00:00 and stalls; the admin's
  30s window expires at 12:00:31 and a second worker claims the same row. Both proceed, and Meta
  rows have no `refresh_token` compare-and-set guard to stop the loser writing last. One timestamp
  cannot express both "be fair" and "I own this" once callers read it with different expiries.
- **Correctness needs a fencing token or an owner id** — i.e. the new column the design was
  specifically trying to avoid.
- **The JIT publisher makes a lost claim dangerous, not safe.** "Publish with the existing token" is
  fine when *we* failed to refresh, but a lost claim means someone else is mid-exchange: the post
  then publishes with a token that is expired precisely because the refresh it needed is still in
  flight (`process-scheduled-posts:171` → `process-post:1363`).

Weighed against that: the observed exposure is two admin tabs, and the cron already has a five-minute
cooldown. **The cost/benefit no longer favours doing it now**, and bolting a half-correct lease onto
the token path is exactly the kind of change that produced the outage this whole effort came from.

If it is picked up later it needs its own spec covering: a single lease duration exceeding bounded
per-account work, an owner/fencing token, explicit release on completion, and the JIT publisher's
contention behaviour (wait-and-refetch, or defer the post — never publish into a race).

The `markRefreshAttempt` unconditional write stays as it is for now. It is a fairness marker, and
this plan does not pretend it is a lock.

---

### Task 6: Deploy and verify against production

**Files:** none modified.

- [ ] **Step 1: Diff the volume against the branch before deploying**

`refresh-tokens` has drifted ahead of git before — a repo-first deploy silently reverted a
production hotfix once already.

```bash
scp root@86.48.2.205:/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/refresh-tokens/index.ts /tmp/vol-rt.ts
tr -d '\r' < supabase/functions/refresh-tokens/index.ts > /tmp/repo-rt.ts
diff -u /tmp/repo-rt.ts /tmp/vol-rt.ts
```
Expected: only this branch's changes. Any *other* difference is production-only work that must be
ported into the repo before deploying.

- [ ] **Step 2: Back up, upload, verify hashes**

```bash
ssh root@86.48.2.205 'mkdir -p /root/fn-backup-$(date +%Y%m%d) && cp -r /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/{refresh-tokens,_shared} /root/fn-backup-$(date +%Y%m%d)/'
```

Upload `refresh-tokens/{index.ts,escalation.ts}` and
`_shared/{social-auth.ts,metaErrors.ts,avatar-cache.ts}`, then compare `sha256sum` on both sides.
Every hash must match before restarting.

- [ ] **Step 3: Restart and confirm the worker booted**

```bash
ssh root@86.48.2.205 'docker restart postorasupabase-supabase-j8axyh-supabase-edge-functions'
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.postora.cloud/functions/v1/refresh-tokens -H "Content-Type: application/json" -d '{}'
```
Expected: `401` — the function is up and rejecting unauthenticated calls. Use `restart`, never
`up -d`, which silently serves the old code.

- [ ] **Step 4: Prove all three behaviours on real accounts**

With `CRON_SECRET` from the edge container, force-refresh one account of each kind and check
`needs_reauth` / `failure_count` before and after:

| account | expected `status` | expected DB effect |
|---|---|---|
| healthy Facebook Page | `refreshed` | stays green, `failure_count` 0 |
| genuinely expired token | `failed` | stays red, `failure_count` increments |
| same account pressed twice inside 5 min | `cooldown` on the second | no second failure recorded |

- [ ] **Step 5: Confirm no false positives were introduced**

⚠️ Do **not** reuse the post-#66 gate `needs_reauth AND token_expires_at > now() = 0`. It was a valid
invariant before this change and is invalid after it: a revoked grant keeps a future
`token_expires_at`, and flagging exactly those rows is what the new code-190 classifier is *for*.
That gate would roll back a correct implementation.

Use the invariant that still holds — **no account is red because of a transient failure**:

```sql
select sa.platform, sa.platform_username, h.status, h.error_message
from social_accounts sa
join lateral (
  select status, error_message from token_refresh_history
   where account_id = sa.id order by created_at desc limit 1
) h on true
where sa.is_active and sa.needs_reauth
  and sa.platform in ('facebook','instagram','threads')
  and (h.error_message ilike '%timeout%' or h.error_message ilike '%network%');
```
Expected: **no rows.** Any row here is a healthy account latched by infrastructure noise — the exact
regression this revision exists to prevent. Roll back from the Step 2 backup.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin <branch>
gh pr create --title "fix(meta): bound, sanitize and correctly classify Meta token refreshes" --body "…"
```
Address CodeRabbit and Codex findings, capped at two rounds, then merge.
