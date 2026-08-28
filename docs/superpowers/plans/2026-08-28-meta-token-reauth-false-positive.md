# Meta-Platform `needs_reauth` False Positive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `refresh-tokens` from flagging Facebook / Instagram / Threads accounts as
`needs_reauth` merely because those platforms do not issue an OAuth `refresh_token`, and make a
Facebook reconnect actually clear the health flags — so the red "Action Required: Reconnect"
button turns green.

**Architecture:** Meta platforms use a *long-lived access token that is exchanged* (`fb_exchange_token`
/ `th_refresh_token`) rather than an OAuth refresh token. The existing exchange helpers
(`refreshFacebookToken`, `refreshThreadsToken`) already work off `account.access_token` alone but are
unreachable behind a `if (!account.refresh_token) → mark needs_reauth` guard. We make "does this
platform use a refresh token" an explicit property on the existing `PLATFORM_REFRESH_CONFIG`, gate
the guard on it, add the already-established health-reset fields to the two Facebook Page upserts
that lack them, forward the dropped reconnect options in the frontend, and backfill the rows that
the bug already corrupted.

**Tech Stack:** Deno edge functions (Supabase self-hosted), React 18 + TypeScript + Vite frontend,
Vitest (frontend), `deno test` (edge), PostgreSQL migrations.

**Spec:** `docs/superpowers/plans/2026-08-28-meta-token-reauth-false-positive-findings.md`
(the investigation report — root causes, DB evidence, falsification criteria).

## Global Constraints

- **Do NOT weaken genuine reauth detection.** An account whose token is actually revoked must still
  end up `needs_reauth = true`. The discriminator is the *result of the exchange call*, never the
  absence of a `refresh_token` column.
- **`refresh-tokens/index.ts` in this repo is BEHIND production.** The deployed copy at
  `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/refresh-tokens/index.ts`
  carries an admin-auth hotfix (`authorizeRefreshRequest`, `manual` / `adminTriggered`) that the repo
  lacks. Task 1 ports it. Do not deploy this function before Task 1 lands or production regresses.
- Project gate commands (from `.github/workflows/test.yml`): `npx tsc -b --noEmit`,
  `bun run lint`, `bun run test` (= `vitest run`), `bun run build`.
  Edge tests are not in CI; run them locally with
  `deno test --allow-env --allow-net supabase/functions/<dir>/`.
- Edge functions deploy manually (see `docs/runbooks/deploy-edge-function.md`); the frontend
  auto-deploys on merge to `main`. Deploy edge functions and run the backfill **before** merging.
- Follow `ARCHITECTURE.md` for layering and Edge Function shape.
- Work happens in the worktree `F:/Postora_wt/reauth-fix` on branch
  `fix/meta-token-reauth-false-positive`. Never edit `F:/Postora_new` directly — another agent
  drives that checkout's HEAD.

---

### Task 1: Port the production admin-auth hotfix into the repo

Production's `refresh-tokens` has drifted ahead of git. Porting it first makes the repo the source
of truth again so the Task 2 deploy cannot regress it.

**Files:**
- Modify: `supabase/functions/refresh-tokens/index.ts`

**Interfaces:**
- Consumes: `verifyCronAuth` from `_shared/cron-auth.ts`, `errorResponse` from `_shared/cors.ts`.
- Produces: `authorizeRefreshRequest(req: Request): Promise<{ok: true; mode: "cron" | "admin"} | {ok: false; response: Response}>`
  and a local `adminTriggered: boolean` used by Task 2.

- [ ] **Step 1: Add the authorization helper**

Insert immediately above `Deno.serve(` in `supabase/functions/refresh-tokens/index.ts`
(currently line 605). This is the deployed logic, reformatted to repo style — behaviour must
stay byte-equivalent:

```ts
/**
 * Authorize a refresh-tokens request.
 *
 * Two accepted callers:
 *  - the cron job, via CRON_SECRET (or, when CRON_SECRET is unset, the service-role key as a
 *    bearer token — the self-hosted stack has shipped without CRON_SECRET before);
 *  - a signed-in admin, via their Supabase JWT, for the admin "Refresh tokens" button.
 */
async function authorizeRefreshRequest(
  req: Request,
): Promise<{ ok: true; mode: "cron" | "admin" } | { ok: false; response: Response }> {
  if (Deno.env.get("CRON_SECRET")) {
    const cron = verifyCronAuth(req);
    if (cron.ok) return { ok: true, mode: "cron" };
  } else {
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const header = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (serviceKey && bearer && bearer === serviceKey) return { ok: true, mode: "cron" };
  }

  const authHeader = req.headers.get("Authorization") || req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: errorResponse("Unauthorized", 401) };
  }

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) return { ok: false, response: errorResponse("Unauthorized", 401) };

    const { data: roleData } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleData) return { ok: false, response: errorResponse("Admin access required", 403) };

    console.log(`refresh-tokens authorized via admin JWT: ${user.id}`);
    return { ok: true, mode: "admin" };
  } catch (e) {
    console.error(e);
    return { ok: false, response: errorResponse("Unauthorized", 401) };
  }
}
```

- [ ] **Step 2: Use it in the handler**

Replace, inside `Deno.serve`:

```ts
  const __cronAuth = verifyCronAuth(req);
  if (!__cronAuth.ok) return __cronAuth.response;
```

with:

```ts
  const auth = await authorizeRefreshRequest(req);
  if (!auth.ok) return auth.response;
```

- [ ] **Step 3: Add the `manual` / `adminTriggered` flags**

In the body-parsing block, add `let manual = false;` beside `let force = false;`, add
`manual = body.manual === true;` beside `force = body.force === true;`, and after the
`try { … } catch { … }` block add:

```ts
    const adminTriggered = force || manual;
```

- [ ] **Step 4: Apply `adminTriggered` at its three use sites**

Replace the account filter:

```ts
    const isForceOrManual = force || platforms.length > 0;
    const accountsNeedingRefresh = allAccounts.filter((account: SocialAccountWithDetails) => {
      // Skip YouTube (and other cron-excluded platforms) in automatic cron cycles
      // They only refresh via force/manual trigger or when explicitly requested by platform filter
      if (!isForceOrManual && isCronExcludedPlatform(account.platform)) {
        console.log(`[cron-skip] Skipping ${account.platform} account ${account.id} — cron-excluded (JIT refresh only)`);
        return false;
      }
      return tokenNeedsRefresh(account.platform, account.token_expires_at);
    });
```

with:

```ts
    const accountsNeedingRefresh = allAccounts.filter((account: SocialAccountWithDetails) => {
      // Skip YouTube (and other cron-excluded platforms) in automatic cron cycles.
      if (!adminTriggered && platforms.length === 0 && isCronExcludedPlatform(account.platform)) {
        console.log(`[cron-skip] Skipping ${account.platform} account ${account.id}`);
        return false;
      }
      // An admin pressing "refresh" means every account, not just those inside the window.
      if (adminTriggered) return true;
      return tokenNeedsRefresh(account.platform, account.token_expires_at);
    });
```

Gate the cooldown on it:

```ts
      if (!adminTriggered && isWithinRefreshCooldown(account.last_refresh_attempt_at)) {
```

And replace the trigger-type line:

```ts
    const triggerType: 'cron' | 'manual' | 'force' =
      force ? 'force' : (manual || auth.mode === 'admin') ? 'manual' : 'cron';
```

- [ ] **Step 5: Verify the port is faithful**

```bash
scp root@86.48.2.205:/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/refresh-tokens/index.ts /tmp/vol-rt.ts
tr -d '\r' < supabase/functions/refresh-tokens/index.ts > /tmp/repo-rt.ts
diff -u /tmp/repo-rt.ts /tmp/vol-rt.ts
```
Expected: only formatting/comment differences remain — no behavioural difference. Confirm
`authorizeRefreshRequest`, `manual`, `adminTriggered` and the `triggerType` expression are all
present on both sides.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc -b --noEmit
git add supabase/functions/refresh-tokens/index.ts
git commit -m "chore(refresh-tokens): port deployed admin-auth hotfix back into the repo"
```

---

### Task 2: Teach the platform config which platforms use refresh tokens

**Files:**
- Modify: `supabase/functions/_shared/tokenExpiryConstants.ts`
- Create: `supabase/functions/_shared/tokenExpiryConstants.test.ts`

**Interfaces:**
- Produces: `PlatformRefreshConfig.usesRefreshToken?: boolean` and
  `platformUsesRefreshToken(platform: string): boolean` — consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/tokenExpiryConstants.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { platformUsesRefreshToken } from "./tokenExpiryConstants.ts";

Deno.test("Meta platforms do not use OAuth refresh tokens", () => {
  // Facebook Pages, Instagram and Threads issue a long-lived access token that is
  // exchanged in place (fb_exchange_token / th_refresh_token). There is no refresh token.
  assertEquals(platformUsesRefreshToken("facebook"), false);
  assertEquals(platformUsesRefreshToken("instagram"), false);
  assertEquals(platformUsesRefreshToken("threads"), false);
});

Deno.test("OAuth2 platforms do use refresh tokens", () => {
  assertEquals(platformUsesRefreshToken("twitter"), true);
  assertEquals(platformUsesRefreshToken("youtube"), true);
  assertEquals(platformUsesRefreshToken("pinterest"), true);
  assertEquals(platformUsesRefreshToken("linkedin"), true);
  assertEquals(platformUsesRefreshToken("tiktok"), true);
  assertEquals(platformUsesRefreshToken("reddit"), true);
  assertEquals(platformUsesRefreshToken("bluesky"), true);
});

Deno.test("platform matching is case-insensitive and unknown platforms default to true", () => {
  assertEquals(platformUsesRefreshToken("FaceBook"), false);
  // Unknown platforms keep the conservative old behaviour: a missing refresh token is a failure.
  assertEquals(platformUsesRefreshToken("some-new-platform"), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/_shared/tokenExpiryConstants.test.ts`
Expected: FAIL — `platformUsesRefreshToken` is not exported.

- [ ] **Step 3: Implement**

In `supabase/functions/_shared/tokenExpiryConstants.ts`, add the field to the
`PlatformRefreshConfig` interface:

```ts
  /**
   * Whether the platform issues an OAuth refresh token.
   *
   * Meta platforms (Facebook, Instagram, Threads) do not: they issue a long-lived access
   * token that is exchanged for a new one via fb_exchange_token / th_refresh_token, using
   * the access token itself. Treating their missing refresh_token as a refresh failure is
   * what used to flag every healthy Meta account as needs_reauth.
   *
   * Defaults to true (absent refresh token = failure) so a newly added platform is
   * handled conservatively.
   */
  usesRefreshToken?: boolean;
```

Set `usesRefreshToken: false` on the `facebook`, `instagram` and `threads` entries. Leave every
other entry alone (they default to true).

Append the accessor beside `isCronExcludedPlatform`:

```ts
/**
 * Check whether a platform authenticates with an OAuth refresh token.
 * Unknown platforms default to true — the conservative pre-existing behaviour.
 */
export function platformUsesRefreshToken(platform: string): boolean {
  return PLATFORM_REFRESH_CONFIG[platform.toLowerCase()]?.usesRefreshToken ?? true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-env supabase/functions/_shared/tokenExpiryConstants.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/tokenExpiryConstants.ts supabase/functions/_shared/tokenExpiryConstants.test.ts
git commit -m "feat(tokens): record which platforms actually issue OAuth refresh tokens"
```

---

### Task 3: Route exchange-only platforms past the missing-refresh-token guard

This is the root-cause fix. `refreshFacebookToken` and `refreshThreadsToken` already exchange using
`account.access_token` and need no refresh token — they are simply unreachable today.

**Files:**
- Modify: `supabase/functions/refresh-tokens/index.ts` (the bulk cron loop and `refreshSingleAccount`)
- Create: `supabase/functions/refresh-tokens/refreshEligibility.test.ts`
- Create: `supabase/functions/refresh-tokens/refreshEligibility.ts`

**Interfaces:**
- Consumes: `platformUsesRefreshToken` (Task 2).
- Produces: `accountCanAttemptRefresh(account: { platform: string; refresh_token: string | null }): boolean`.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/refresh-tokens/refreshEligibility.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { accountCanAttemptRefresh } from "./refreshEligibility.ts";

Deno.test("a Facebook account with no refresh token can still be refreshed by exchange", () => {
  // Regression: this account shape used to be marked needs_reauth on sight.
  assertEquals(
    accountCanAttemptRefresh({ platform: "facebook", refresh_token: null }),
    true,
  );
});

Deno.test("Instagram and Threads behave the same as Facebook", () => {
  assertEquals(accountCanAttemptRefresh({ platform: "instagram", refresh_token: null }), true);
  assertEquals(accountCanAttemptRefresh({ platform: "threads", refresh_token: null }), true);
});

Deno.test("an OAuth2 platform with no refresh token genuinely cannot refresh", () => {
  assertEquals(accountCanAttemptRefresh({ platform: "pinterest", refresh_token: null }), false);
  assertEquals(accountCanAttemptRefresh({ platform: "youtube", refresh_token: null }), false);
  assertEquals(accountCanAttemptRefresh({ platform: "twitter", refresh_token: "" }), false);
});

Deno.test("an OAuth2 platform with a refresh token can refresh", () => {
  assertEquals(accountCanAttemptRefresh({ platform: "pinterest", refresh_token: "rt_abc" }), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/refresh-tokens/refreshEligibility.test.ts`
Expected: FAIL — module `./refreshEligibility.ts` not found.

- [ ] **Step 3: Implement the helper**

Create `supabase/functions/refresh-tokens/refreshEligibility.ts`:

```ts
import { platformUsesRefreshToken } from "../_shared/tokenExpiryConstants.ts";

/**
 * Can we even attempt a token refresh for this account?
 *
 * For OAuth2 platforms the answer is "only with a refresh token". For Meta's
 * exchange-only platforms the access token IS the exchange credential, so a null
 * refresh_token is normal and must not be treated as a failure.
 */
export function accountCanAttemptRefresh(
  account: { platform: string; refresh_token: string | null },
): boolean {
  if (!platformUsesRefreshToken(account.platform)) return true;
  return Boolean(account.refresh_token);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-env supabase/functions/refresh-tokens/refreshEligibility.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the helper into the bulk cron loop**

In `supabase/functions/refresh-tokens/index.ts`, add to the imports:

```ts
import { accountCanAttemptRefresh } from "./refreshEligibility.ts";
```

Replace the bulk-loop guard (currently around line 834):

```ts
      // Check if account has refresh token
      if (!account.refresh_token) {
        console.log(`Account ${account.id} has no refresh token - marking as needs_reauth`);
        const { shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'No refresh token available');
        results.push({ id: account.id, platform: account.platform, status: 'needs_reauth', error: 'No refresh token' });
        if (shouldAlert) accountsToAlert.push(account);
        continue;
      }
```

with:

```ts
      // Meta platforms exchange their access token in place and never have a refresh
      // token; only platforms that genuinely need one are failed here.
      if (!accountCanAttemptRefresh(account)) {
        console.log(`Account ${account.id} has no refresh token - marking as needs_reauth`);
        const { shouldAlert } = await handleRefreshFailure(supabaseAdmin, account, 'No refresh token available');
        results.push({ id: account.id, platform: account.platform, status: 'needs_reauth', error: 'No refresh token' });
        if (shouldAlert) accountsToAlert.push(account);
        continue;
      }
```

- [ ] **Step 6: Wire the same helper into `refreshSingleAccount`**

An admin force-refresh takes this path, and it carries the identical bug. Replace (around line 356):

```ts
  // Check if account has refresh token
  if (!account.refresh_token) {
    console.log(`[force-refresh] Account ${account.id} has no refresh token`);
    await handleRefreshFailure(supabaseAdmin, account, 'No refresh token available');
    return { id: account.id, platform: account.platform, status: 'needs_reauth', error: 'No refresh token' };
  }
```

with:

```ts
  if (!accountCanAttemptRefresh(account)) {
    console.log(`[force-refresh] Account ${account.id} has no refresh token`);
    await handleRefreshFailure(supabaseAdmin, account, 'No refresh token available');
    return { id: account.id, platform: account.platform, status: 'needs_reauth', error: 'No refresh token' };
  }
```

- [ ] **Step 7: Fix the third, hidden `!refresh_token` use — the escalation rule**

`handleRefreshFailure` computes (line 303):

```ts
  const needsReauth = isPermanentError || currentFailureCount >= MAX_FAILURES_BEFORE_REAUTH || !account.refresh_token;
```

That trailing disjunct makes **any** failure on a Meta account instantly permanent — it is why
every red row shows `failure_count = 1` rather than the intended 3. Left in place it would undo
Steps 5-6: the first transient exchange hiccup would re-flag the account. Replace with:

```ts
  const needsReauth = isPermanentError
    || currentFailureCount >= MAX_FAILURES_BEFORE_REAUTH
    || !accountCanAttemptRefresh(account);
```

- [ ] **Step 8: Verify no remaining bare guard**

```bash
grep -n "!account.refresh_token" supabase/functions/refresh-tokens/index.ts
```
Expected: no output. If anything prints, replace it too.

Also confirm both switches reach the Meta exchange helpers:
```bash
grep -n "refreshFacebookToken\|refreshThreadsToken" supabase/functions/refresh-tokens/index.ts
```
Expected: `case 'facebook'`/`case 'instagram'` → `refreshFacebookToken`, `case 'threads'` →
`refreshThreadsToken`, in both the single-account and bulk switches.

- [ ] **Step 9: Typecheck, run edge tests, commit**

```bash
npx tsc -b --noEmit
deno test --allow-env supabase/functions/_shared/tokenExpiryConstants.test.ts supabase/functions/refresh-tokens/refreshEligibility.test.ts
git add supabase/functions/refresh-tokens/
git commit -m "fix(refresh-tokens): stop flagging Meta accounts that have no refresh token by design"
```

---

### Task 3b: Send each Instagram account to the right exchange endpoint

**This task is a prerequisite for Task 3 being safe, not an optional extra.** Unblocking the
refresh guard without it sends 21 of 27 Instagram accounts to the *wrong* Meta endpoint, where
they fail and get re-flagged.

Instagram has three auth flavours, recorded in the dedicated **`ig_auth_type` column**:
`business_login` (21 active accounts), `facebook_business` (5), `facebook_page` (1).
Business-login tokens are Instagram-scoped and must be exchanged at
`graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`; the other two are Page
tokens and use `fb_exchange_token`.

Today `refresh-tokens/index.ts:386` detects this as
`account_metadata.account_type === 'business_login'` — the wrong field. That JSONB key holds
Instagram's *account category* (`BUSINESS`, `MEDIA_CREATOR`), so the check matches **zero** rows.
It is the only place in the repo that reads it that way; `brand-scrape/index.ts:588` and every
other consumer correctly use `.eq("ig_auth_type", "business_login")`.

**Files:**
- Modify: `supabase/functions/_shared/social-auth.ts` (add the Instagram Business Login refresher)
- Modify: `supabase/functions/refresh-tokens/index.ts` (both switches)
- Create: `supabase/functions/refresh-tokens/metaRefreshRouting.test.ts`
- Create: `supabase/functions/refresh-tokens/metaRefreshRouting.ts`

**Interfaces:**
- Produces: `metaRefreshStrategy(account: { platform: string; ig_auth_type: string | null }): "fb_exchange" | "ig_refresh" | "threads_refresh" | "none"`
- Produces: `refreshInstagramBusinessToken(account: SocialAccount): Promise<{ access_token: string; expires_in: number } | null>` in `_shared/social-auth.ts`.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/refresh-tokens/metaRefreshRouting.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { metaRefreshStrategy } from "./metaRefreshRouting.ts";

Deno.test("Instagram Business Login uses the Instagram-scoped refresh endpoint", () => {
  // 21 of 27 active Instagram accounts are business_login. Their tokens are IG-scoped
  // and are rejected by fb_exchange_token.
  assertEquals(
    metaRefreshStrategy({ platform: "instagram", ig_auth_type: "business_login" }),
    "ig_refresh",
  );
});

Deno.test("Page-backed Instagram accounts use the Facebook exchange", () => {
  assertEquals(metaRefreshStrategy({ platform: "instagram", ig_auth_type: "facebook_page" }), "fb_exchange");
  assertEquals(metaRefreshStrategy({ platform: "instagram", ig_auth_type: "facebook_business" }), "fb_exchange");
});

Deno.test("an Instagram row with no ig_auth_type falls back to the Facebook exchange", () => {
  assertEquals(metaRefreshStrategy({ platform: "instagram", ig_auth_type: null }), "fb_exchange");
});

Deno.test("Facebook and Threads route to their own exchanges", () => {
  assertEquals(metaRefreshStrategy({ platform: "facebook", ig_auth_type: null }), "fb_exchange");
  assertEquals(metaRefreshStrategy({ platform: "threads", ig_auth_type: null }), "threads_refresh");
});

Deno.test("non-Meta platforms have no exchange strategy", () => {
  assertEquals(metaRefreshStrategy({ platform: "pinterest", ig_auth_type: null }), "none");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/refresh-tokens/metaRefreshRouting.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

Create `supabase/functions/refresh-tokens/metaRefreshRouting.ts`:

```ts
export type MetaRefreshStrategy = "fb_exchange" | "ig_refresh" | "threads_refresh" | "none";

/**
 * Pick the token-exchange endpoint for a Meta account.
 *
 * Instagram's flavour lives in the `ig_auth_type` COLUMN, not in
 * `account_metadata.account_type` (which holds Instagram's own account category,
 * e.g. BUSINESS / MEDIA_CREATOR). Reading the wrong one silently routed every
 * business-login account to fb_exchange_token, which rejects IG-scoped tokens.
 */
export function metaRefreshStrategy(
  account: { platform: string; ig_auth_type: string | null },
): MetaRefreshStrategy {
  switch (account.platform.toLowerCase()) {
    case "facebook":
      return "fb_exchange";
    case "threads":
      return "threads_refresh";
    case "instagram":
      return account.ig_auth_type === "business_login" ? "ig_refresh" : "fb_exchange";
    default:
      return "none";
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-env supabase/functions/refresh-tokens/metaRefreshRouting.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Extract the Instagram Business Login refresher into `_shared/social-auth.ts`**

The logic currently sits inline and unreachable at `refresh-tokens/index.ts:383-415`. Move it
beside its siblings, matching their exact shape:

```ts
export async function refreshInstagramBusinessToken(
  account: SocialAccount,
): Promise<{ access_token: string; expires_in: number } | null> {
    // Instagram Business Login tokens are Instagram-scoped: they refresh against
    // graph.instagram.com using the access token itself, not fb_exchange_token.
    try {
        const response = await fetch(
            `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${account.access_token}`
        );

        const data = await response.json();

        if (!response.ok || data.error || !data.access_token) {
            const errorMsg = data.error?.message || data.error?.error_user_msg || 'Instagram token refresh failed';
            console.error('Instagram Business token refresh failed:', errorMsg);
            return null;
        }

        return {
            access_token: data.access_token,
            expires_in: data.expires_in || 5184000 // 60 days default
        };
    } catch (error) {
        console.error('Error refreshing Instagram Business token:', error);
        return null;
    }
}
```

- [ ] **Step 6: Route both switches through the strategy**

In `refresh-tokens/index.ts`, import both new symbols:

```ts
import { metaRefreshStrategy } from "./metaRefreshRouting.ts";
```
and add `refreshInstagramBusinessToken` to the existing `_shared/social-auth.ts` import list.

In `refreshSingleAccount`, replace the `case 'instagram'` block's broken detection
(`const isBusinessLogin = igMeta && (igMeta as Record<string, unknown>).account_type === 'business_login';`)
with:

```ts
        const isBusinessLogin = metaRefreshStrategy(account) === "ig_refresh";
```
and inside that branch call `refreshInstagramBusinessToken(account)` instead of the inline
`fetch`, keeping the surrounding success/failure handling exactly as it is.

In the **bulk cron loop**, split Instagram out of the shared `case 'facebook': case 'instagram':`
so business-login accounts do not go to `refreshFacebookToken`:

```ts
          case 'facebook':
          case 'instagram': {
            refreshResult = metaRefreshStrategy(account) === "ig_refresh"
              ? await refreshInstagramBusinessToken(account)
              : await refreshFacebookToken(account);
            // ...existing success/failure handling unchanged...
          }
```

- [ ] **Step 7: Confirm the broken field reference is gone**

```bash
grep -rn "account_type === 'business_login'" supabase/functions/
```
Expected: no output.

- [ ] **Step 8: Typecheck, test, commit**

```bash
npx tsc -b --noEmit
deno test --allow-env supabase/functions/refresh-tokens/
git add supabase/functions/refresh-tokens/ supabase/functions/_shared/social-auth.ts
git commit -m "fix(refresh-tokens): route Instagram Business Login accounts to the Instagram exchange endpoint"
```

---

### Task 4: Clear the health flags on a Facebook Page reconnect

Every other platform's OAuth upsert already resets these three columns. Facebook's two Page
upserts are the only ones that don't, so a completed reconnect leaves the row red.

**Files:**
- Modify: `supabase/functions/facebook-oauth/index.ts` (the upsert at ~line 735 and the
  auto-select upsert at ~line 922)
- Create: `supabase/functions/facebook-oauth/accountHealthFields.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing exported; the change is to two upsert payloads.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/facebook-oauth/accountHealthFields.test.ts`. This is a source-level
assertion — the upsert payloads are inline object literals inside a 1000-line handler, so a
behavioural test would require standing up the whole OAuth flow. Guarding the literal is the
proportionate check:

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// Every write that stores a freshly-authorized token must also clear the health flags,
// otherwise a completed reconnect leaves the account showing "Action Required: Reconnect".
Deno.test("every social_accounts upsert clears needs_reauth", () => {
  const upsertCount = (source.match(/\.upsert\(/g) ?? []).length;
  const clearCount = (source.match(/needs_reauth:\s*false/g) ?? []).length;
  assertEquals(
    clearCount,
    upsertCount,
    `${upsertCount} upsert(s) but only ${clearCount} needs_reauth:false — a reconnect path leaves the flag set`,
  );
});

Deno.test("failure tracking is reset alongside needs_reauth", () => {
  const clearCount = (source.match(/needs_reauth:\s*false/g) ?? []).length;
  assertEquals((source.match(/failure_count:\s*0/g) ?? []).length, clearCount);
  assertEquals((source.match(/last_refresh_error:\s*null/g) ?? []).length, clearCount);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-read supabase/functions/facebook-oauth/accountHealthFields.test.ts`
Expected: FAIL — 3 upserts but only 1 `needs_reauth: false`.

- [ ] **Step 3: Implement**

In the explicit page-selection upsert (~line 735), add three fields after `token_expires_at`:

```ts
          token_expires_at: tokenExpiresAt,
          needs_reauth: false,
          failure_count: 0,
          last_refresh_error: null,
```

In the single-page auto-select upsert (~line 922), the same three fields after
`token_expires_at: expiresAt,`:

```ts
            token_expires_at: expiresAt,
            needs_reauth: false,
            failure_count: 0,
            last_refresh_error: null,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-read supabase/functions/facebook-oauth/accountHealthFields.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/facebook-oauth/
git commit -m "fix(facebook-oauth): clear needs_reauth and failure tracking when a Page reconnects"
```

---

### Task 5: Stop dropping reconnect options in the frontend

`invokePlatform` accepts `{ mode, socialAccountId }` but forwards it to only three of ten
platforms. Facebook silently loses it, so the redirect never carries `reconnected=1` and the
"Connection refreshed" toast plus `refetchQueries(["accounts-needing-reauth"])` never fire.
This buys immediacy — Tasks 3+4 alone repaint within the banner's 60s `refetchInterval`.

**Files:**
- Modify: `src/hooks/useProfileOAuth.tsx:88-127`
- Modify: `src/hooks/oauth/useFacebookOAuth.ts` (accept and forward the options)
- Test: `src/hooks/oauth/__tests__/reconnectMode.test.ts`

**Interfaces:**
- Consumes: `ReconnectOptions = { mode?: "connect" | "reconnect"; socialAccountId?: string }`.
- Produces: `handleFacebookConnect(platform: Platform, profileId: string, options?: ReconnectOptions)`.

- [ ] **Step 1: Read the existing test file first**

```bash
cat src/hooks/oauth/__tests__/reconnectMode.test.ts
```
Match its existing style, mocking approach and imports — do not invent a new pattern.

- [ ] **Step 2: Write the failing test**

Append to `src/hooks/oauth/__tests__/reconnectMode.test.ts`, adapting the mock setup that file
already uses:

```ts
it("forwards reconnect options to the Facebook connect handler", async () => {
  const handleFacebookConnect = vi.fn();
  // ...wire the mock exactly as the sibling tiktok/pinterest cases in this file do...

  const { result } = renderHook(() => useProfileOAuth(), { wrapper });
  await act(() =>
    result.current.handleReconnectPlatform("profile-1", "facebook", "account-123"),
  );

  expect(handleFacebookConnect).toHaveBeenCalledWith(
    "facebook",
    "profile-1",
    { mode: "reconnect", socialAccountId: "account-123" },
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/hooks/oauth/__tests__/reconnectMode.test.ts`
Expected: FAIL — called with 2 arguments, options missing.

- [ ] **Step 4: Implement**

In `src/hooks/useProfileOAuth.tsx`, forward `options` to every handler that can use it:

```ts
      } else if (platform === "facebook") {
        await handleFacebookConnect(platform, profileId, options);
```

Do the same for the `youtube`, `linkedin`, `threads`, `bluesky` and `reddit` branches, matching
each handler's existing parameter order. Where a handler genuinely cannot accept options, add a
one-line comment saying why rather than silently dropping it.

Then widen the signature in `src/hooks/oauth/useFacebookOAuth.ts` to accept the third parameter
and include `mode` / `social_account_id` in the body it posts to the `facebook-oauth` function,
mirroring how `usePinterestOAuth.ts` already does it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/hooks/oauth/__tests__/reconnectMode.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full frontend suite and commit**

```bash
npx tsc -b --noEmit
bun run test
git add src/hooks/
git commit -m "fix(oauth): forward reconnect options to every platform handler"
```

---

### Task 6: Backfill the rows the bug already corrupted

43 of 57 active Meta accounts are flagged. Code fixes stop new corruption but do not heal
existing rows — and the cron cannot, because it filters flagged accounts out.

**Files:**
- Create: `supabase/migrations/20260828120000_clear_false_positive_meta_reauth.sql`

- [ ] **Step 1: Preview the affected rows against production**

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c "
select platform, count(*) from social_accounts
where needs_reauth = true
  and is_active = true
  and platform in ('facebook','instagram','threads')
  and last_refresh_error = 'No refresh token available'
  and token_expires_at > now()
group by platform;"
```
Expected: roughly facebook ~11, instagram ~21, threads ~11 minus any already expired. Record the
actual counts — Step 4 verifies against them.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/20260828120000_clear_false_positive_meta_reauth.sql`:

```sql
-- Clear needs_reauth on Meta accounts that were flagged only because the platform
-- does not issue an OAuth refresh token.
--
-- refresh-tokens used to treat a null refresh_token as a refresh failure. Facebook,
-- Instagram and Threads never have one — they exchange their long-lived access token
-- in place. Those accounts were healthy the whole time, but the cron filters flagged
-- rows out, so nothing could ever un-flag them.
--
-- Scoped deliberately narrowly: only rows carrying that exact error string, only the
-- three exchange-only platforms, and only where the token has not actually expired.
-- An account with a genuinely dead token stays flagged.

update public.social_accounts
set needs_reauth = false,
    failure_count = 0,
    last_refresh_error = null,
    last_alert_sent_at = null,
    updated_at = now()
where needs_reauth = true
  and is_active = true
  and platform in ('facebook', 'instagram', 'threads')
  and last_refresh_error = 'No refresh token available'
  and token_expires_at is not null
  and token_expires_at > now();
```

- [ ] **Step 3: Rehearse on a throwaway clone, not in a transaction**

Postora migrations self-commit, so an outer `BEGIN/ROLLBACK` applies them for real. Rehearse on a
copy:

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -c "create database reauth_rehearsal template postgres;"
docker exec -i postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d reauth_rehearsal < supabase/migrations/20260828120000_clear_false_positive_meta_reauth.sql
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d reauth_rehearsal -c "select platform, count(*) filter (where needs_reauth) flagged, count(*) total from social_accounts where is_active group by platform order by 1;"
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -c "drop database reauth_rehearsal;"
```
Expected: facebook / instagram / threads flagged counts drop to only genuinely-expired accounts;
pinterest and twitter counts are unchanged.

- [ ] **Step 4: Commit (do not apply to production yet — see Task 7)**

```bash
git add supabase/migrations/20260828120000_clear_false_positive_meta_reauth.sql
git commit -m "fix(db): clear needs_reauth on Meta accounts flagged by the refresh-token false positive"
```

---

### Task 7: Verify, deploy, and land

**Files:** none modified.

- [ ] **Step 1: Run every gate green**

```bash
npx tsc -b --noEmit          # must exit 0
bun run lint                 # record any new warnings
bun run test                 # vitest — full suite, 0 failures
bun run build                # must exit 0
deno test --allow-env --allow-read supabase/functions/_shared/tokenExpiryConstants.test.ts supabase/functions/refresh-tokens/ supabase/functions/facebook-oauth/accountHealthFields.test.ts
```
Do not proceed until all are green. Paste the actual output — never assert "tests pass" without it.

- [ ] **Step 2: Guard passes**

Run `clean-code-guard` on the changed production code and `test-guard` on the new tests.

- [ ] **Step 3: Deploy the edge functions**

Per `docs/runbooks/deploy-edge-function.md` and the runtime-checkout procedure: copy
`refresh-tokens/`, `facebook-oauth/` and `_shared/tokenExpiryConstants.ts` into
`/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`, verify SHA256
hashes match, then `docker compose -p postorasupabase-supabase-j8axyh restart functions`
(`restart`, not `up -d`, which silently serves old code).

- [ ] **Step 4: Apply the backfill to production**

```bash
docker exec -i postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres < supabase/migrations/20260828120000_clear_false_positive_meta_reauth.sql
```

- [ ] **Step 5: Prove the fix end to end**

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c "
select platform, count(*) total, count(*) filter (where needs_reauth) flagged
from social_accounts where is_active group by platform order by 1;"
```
Expected: facebook/instagram/threads flagged counts near zero.

Then force a refresh cycle and confirm nothing re-flags:
```bash
curl -s -X POST https://api.postora.cloud/functions/v1/refresh-tokens \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d '{"manual":true,"platforms":["facebook"]}' | head -c 600
```
Re-run the count query. Expected: still near zero — this is the check that would have caught the
original bug, since an admin-triggered run bypasses the refresh window and touches every account.

Finally, open https://postora.cloud/profiles and confirm the accounts show green/Active with no
red Reconnect button.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin fix/meta-token-reauth-false-positive
gh pr create --title "fix: stop flagging Meta accounts as needing reauth when they have no refresh token by design" --body "..."
```
Address CodeRabbit and Codex review findings, capped at two rounds, then merge.
