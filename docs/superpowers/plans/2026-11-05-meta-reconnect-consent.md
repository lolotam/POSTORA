# Meta Reconnect Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After Disconnect → Connect of a Facebook Page, a Page-linked or direct-login Instagram account, Meta shows its permission screen again; Threads shows the held permissions in-app because Meta offers nothing else.

**Architecture:** One shared helper appends the provider's consent parameter to the three Meta authorize URLs. A new `disconnect` action in `facebook-oauth` de-authorizes the Facebook user grant with the app access token only when the removed account is the last member of its credential grant; the Profiles-page Disconnect calls it before deleting the row, exactly as it already does for TikTok. Threads loses a probe that can never succeed and gains a permissions popover.

**Tech Stack:** Deno edge functions (Supabase self-hosted), React 18 + TanStack Query + shadcn/ui, Deno test with the `_shared/protectedOAuthHandlers.test.ts` / `protectedRouteHandlers.test.ts` harness (`loadHandler("<fn>/index.ts", probe)` drives the real `index.ts`), Vitest for hooks.

**Spec:** `docs/superpowers/specs/2026-11-05-meta-reconnect-consent-design.md`

## Global Constraints

- Read `ARCHITECTURE.md` before touching `src/**` or `supabase/functions/**`.
- No migration, no new setting, no feature flag: the behaviour is the same for every caller.
- The revoke call uses the app access token `${FACEBOOK_APP_ID}|${FACEBOOK_APP_SECRET}`; the stored user token is never read for it and never logged.
- Every refusal and every failed revoke writes a `system_logs` row with `source: "facebook-oauth"`, `category: "auth"`; the removal in Postora never depends on Meta being reachable.
- Every read in the new action is scoped with `user_id = caller.userId`, including under the service role.
- Branch: `main` only. Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Gates before the PR: `deno check`, the Deno suites named per task, `npm run test`, `npm run typecheck`, `npm run build`, then `clean-code-guard` and `test-guard`.
- Edge functions deploy automatically from `main` (Dokploy sync); no manual `supabase functions deploy`.

---

## File map

| File | Responsibility |
|---|---|
| Create `supabase/functions/_shared/metaConsentPrompt.ts` | The one place that knows which query parameter makes each Meta login re-show its permission screen. |
| Create `supabase/functions/_shared/metaConsentPrompt.test.ts` | Proves the parameter per login kind and that an existing parameter is not duplicated. |
| Modify `supabase/functions/facebook-oauth/index.ts` | Both authorize URLs get the Facebook Login parameter; new `disconnect` action. |
| Create `supabase/functions/facebook-oauth/disconnect.ts` | Pure decision + revoke for the `disconnect` action, behind small ports. |
| Create `supabase/functions/facebook-oauth/disconnect.test.ts` | The four outcomes of the decision and the exact Graph call. |
| Modify `supabase/functions/instagram-business-oauth/index.ts` | Authorize URL gets the Facebook Login parameter. |
| Modify `supabase/functions/instagram-oauth/index.ts` | Authorize URL gets the Instagram Login parameter. |
| Modify `supabase/functions/_shared/protectedOAuthHandlers.test.ts` | Handler-level assertion that the three real `index.ts` files emit the parameter, and that `disconnect` is routed. |
| Modify `supabase/functions/threads-oauth/index.ts` | Remove the dead `/me/permissions` probe. |
| Modify `src/hooks/useSocialProfiles.tsx` | `useDisconnectAccountFromProfile` calls `facebook-oauth` `disconnect` for `facebook`/`instagram` before the delete. |
| Modify `src/hooks/__tests__/useSocialProfiles.test.tsx` | Proves the call order and that a revoke error does not stop the delete. |
| Modify `src/components/profiles/ProfileRow.tsx` | Threads permissions popover. |
| Modify `.github/workflows/ci.yml` | Registers the two new Deno test files. |

---

### Task 1: Shared consent-prompt helper

**Files:**
- Create: `supabase/functions/_shared/metaConsentPrompt.ts`
- Create: `supabase/functions/_shared/metaConsentPrompt.test.ts`
- Modify: `.github/workflows/ci.yml` (the `tests=(` array under "Typecheck and test protected Meta credential readers and refusals", after `supabase/functions/_shared/protectedFacebookCredentials.test.ts`)

**Interfaces:**
- Produces: `export type MetaLoginKind = "facebook_login" | "instagram_login";` and `export function withMetaConsentPrompt(url: URL, login: MetaLoginKind): URL` which sets `auth_type=rerequest` for `facebook_login` and `force_reauth=true` for `instagram_login` on `url.searchParams` and returns the same `URL`.

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/metaConsentPrompt.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { withMetaConsentPrompt } from "./metaConsentPrompt.ts";

Deno.test("each Meta login kind gets the parameter that re-shows its permission screen", () => {
  const facebook = withMetaConsentPrompt(new URL("https://www.facebook.com/v22.0/dialog/oauth?client_id=1&scope=a,b"), "facebook_login");
  assertEquals(facebook.searchParams.get("auth_type"), "rerequest");
  assertEquals(facebook.searchParams.get("force_reauth"), null);
  assertEquals(facebook.searchParams.get("scope"), "a,b");

  const instagram = withMetaConsentPrompt(new URL("https://www.instagram.com/oauth/authorize?client_id=1"), "instagram_login");
  assertEquals(instagram.searchParams.get("force_reauth"), "true");
  assertEquals(instagram.searchParams.get("auth_type"), null);
});

Deno.test("applying the prompt twice leaves one parameter", () => {
  const url = withMetaConsentPrompt(withMetaConsentPrompt(new URL("https://www.facebook.com/v22.0/dialog/oauth"), "facebook_login"), "facebook_login");
  assertEquals(url.searchParams.getAll("auth_type"), ["rerequest"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test _shared/metaConsentPrompt.test.ts`
Expected: FAIL with `Module not found "metaConsentPrompt.ts"`.

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/_shared/metaConsentPrompt.ts
/**
 * The query parameter that makes a Meta login show its permission screen
 * again on a reconnect, instead of silently reusing the earlier grant.
 *
 * facebook_login:  auth_type=rerequest  (Facebook Login dialog; re-asks the
 *                  permissions, no password re-entry).
 * instagram_login: force_reauth=true    (Instagram API with Instagram Login;
 *                  forces a fresh login, the only lever that window offers).
 * Threads has no such parameter; see the 2026-11-05 design.
 */
export type MetaLoginKind = "facebook_login" | "instagram_login";

const CONSENT_PARAMETER: Record<MetaLoginKind, readonly [name: string, value: string]> = {
  facebook_login: ["auth_type", "rerequest"],
  instagram_login: ["force_reauth", "true"],
};

export function withMetaConsentPrompt(url: URL, login: MetaLoginKind): URL {
  const [name, value] = CONSENT_PARAMETER[login];
  url.searchParams.set(name, value);
  return url;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test _shared/metaConsentPrompt.test.ts`
Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 5: Register the test in CI**

In `.github/workflows/ci.yml`, inside the `tests=(` array of the step "Typecheck and test protected Meta credential readers and refusals", add the line `supabase/functions/_shared/metaConsentPrompt.test.ts` directly after `supabase/functions/_shared/protectedFacebookCredentials.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/metaConsentPrompt.ts supabase/functions/_shared/metaConsentPrompt.test.ts .github/workflows/ci.yml
git commit -m "feat(meta-oauth): name the parameter that re-shows each Meta login's permission screen

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Apply the prompt to the three authorize URLs

**Files:**
- Modify: `supabase/functions/facebook-oauth/index.ts` (the two `dialog/oauth` builders around lines 966 and 986)
- Modify: `supabase/functions/instagram-business-oauth/index.ts` (the `authUrl` built around line 902)
- Modify: `supabase/functions/instagram-oauth/index.ts` (the `authUrl` built around line 745)
- Test: `supabase/functions/_shared/protectedOAuthHandlers.test.ts`

**Interfaces:**
- Consumes: `withMetaConsentPrompt(url, login)` from Task 1.

- [ ] **Step 1: Write the failing handler tests**

Append to `supabase/functions/_shared/protectedOAuthHandlers.test.ts`, next to the existing `routeTest("protected authorize captures the attempt before the authorization URL is returned", …)` (around line 715), using the same `probe`, `loadHandler` and `callJson` helpers:

```ts
routeTest("every Meta authorize URL asks the provider to show the permission screen again", async () => {
  const cases = [
    { entry: "facebook-oauth/index.ts", url: "https://synthetic.invalid/functions/v1/facebook-oauth", body: { action: "authorize", social_profile_id: null }, parameter: ["auth_type", "rerequest"] },
    { entry: "facebook-oauth/index.ts", url: "https://synthetic.invalid/functions/v1/facebook-oauth", body: { action: "authorize", intent: "reconnect", target_social_account_id: TARGET_ID }, parameter: ["auth_type", "rerequest"] },
    { entry: "instagram-business-oauth/index.ts", url: "https://synthetic.invalid/functions/v1/instagram-business-oauth", body: { action: "authorize", social_profile_id: null }, parameter: ["auth_type", "rerequest"] },
    { entry: "instagram-oauth/index.ts", url: "https://synthetic.invalid/functions/v1/instagram-oauth", body: { action: "authorize", social_profile_id: null }, parameter: ["force_reauth", "true"] },
  ] as const;
  for (const scenario of cases) {
    const current = probe({ setting: "protected" });
    const handler = await loadHandler(scenario.entry, current);
    const result = await callJson(handler, scenario.url, scenario.body);
    assertEquals(result.status, 200, `${scenario.entry} ${JSON.stringify(scenario.body)}`);
    const url = new URL(String(result.body.url));
    assertEquals(url.searchParams.get(scenario.parameter[0]), scenario.parameter[1], scenario.entry);
  }
});

routeTest("the legacy Facebook authorize URL asks for the permission screen too", async () => {
  const current = probe({ setting: "absent" });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const result = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", { action: "authorize" });
  assertEquals(result.status, 200);
  assertEquals(new URL(String(result.body.url)).searchParams.get("auth_type"), "rerequest");
});
```

If the `instagram-business-oauth` or `instagram-oauth` authorize probes in this file need a body field the existing tests pass (look at the nearest `loadHandler("instagram-oauth/index.ts", …)` authorize test and copy its body), copy that body and keep the `parameter` assertion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test --allow-env --allow-read --allow-write --allow-net --allow-run _shared/protectedOAuthHandlers.test.ts --filter "permission screen"`
Expected: both tests FAIL on the `searchParams.get` assertion (`null` instead of the value).

- [ ] **Step 3: Apply the helper in `facebook-oauth/index.ts`**

Add the import next to the other `_shared` imports:

```ts
import { withMetaConsentPrompt } from "../_shared/metaConsentPrompt.ts";
```

Replace **both** string-built URLs (protected branch around line 966, legacy branch around line 986) with the `URL` form. Protected branch:

```ts
        const authorizeUrl = withMetaConsentPrompt(
          new URL(
            `https://www.facebook.com/v22.0/dialog/oauth` +
              `?client_id=${encodeURIComponent(appId)}` +
              `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}` +
              `&state=${encodeURIComponent(state)}` +
              `&response_type=code` +
              `&scope=${encodeURIComponent(FB_OAUTH_SCOPES.join(","))}`,
          ),
          "facebook_login",
        ).toString();
```

Legacy branch: the same wrapping around its existing string. The `return new Response(JSON.stringify({ success: true, url: authorizeUrl }), …)` lines stay.

- [ ] **Step 4: Apply the helper in `instagram-business-oauth/index.ts`**

Add the import next to the other `_shared` imports:

```ts
import { withMetaConsentPrompt } from "../_shared/metaConsentPrompt.ts";
```

Directly after `authUrl.searchParams.set("response_type", "code");` (around line 906) add:

```ts
      withMetaConsentPrompt(authUrl, "facebook_login");
```

- [ ] **Step 5: Apply the helper in `instagram-oauth/index.ts`**

Add the import next to the other `_shared` imports:

```ts
import { withMetaConsentPrompt } from "../_shared/metaConsentPrompt.ts";
```

Directly after `authUrl.searchParams.set("response_type", "code");` (around line 749) add:

```ts
      withMetaConsentPrompt(authUrl, "instagram_login");
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno check facebook-oauth/index.ts instagram-business-oauth/index.ts instagram-oauth/index.ts && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test --allow-env --allow-read --allow-write --allow-net --allow-run _shared/protectedOAuthHandlers.test.ts`
Expected: check clean; the whole suite `ok` (57 existing + 2 new).

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/facebook-oauth/index.ts supabase/functions/instagram-business-oauth/index.ts supabase/functions/instagram-oauth/index.ts supabase/functions/_shared/protectedOAuthHandlers.test.ts
git commit -m "feat(meta-oauth): ask Meta to show the permission screen again on every connect

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The `disconnect` decision and revoke, as a pure module

**Files:**
- Create: `supabase/functions/facebook-oauth/disconnect.ts`
- Create: `supabase/functions/facebook-oauth/disconnect.test.ts`
- Modify: `.github/workflows/ci.yml` (same `tests=(` array as Task 1, add `supabase/functions/facebook-oauth/disconnect.test.ts` after `supabase/functions/facebook-oauth/protectedPageConnect.test.ts`)

**Interfaces:**
- Produces:

```ts
export type DisconnectOutcome =
  | { revoked: false; reason: "no_binding" | "grant_shared" | "revoke_failed" | "credential_missing" }
  | { revoked: true; reason: null };

export interface DisconnectPorts {
  /** The binding of this account, or null. Scoped to the owner by the caller. */
  readBinding(accountId: string): Promise<{ credential_id: string } | null>;
  /** How many bindings share the credential. */
  countGrantMembers(credentialId: string): Promise<number>;
  /** The Facebook user id the credential was issued to, or null. */
  readProviderUserId(credentialId: string): Promise<string | null>;
  /** fetch, injected for tests. */
  fetch: typeof fetch;
}

export function revokeFacebookGrant(fetchImpl: typeof fetch, app: { appId: string; appSecret: string }, providerUserId: string): Promise<boolean>;
export function decideDisconnect(ports: DisconnectPorts, app: { appId: string; appSecret: string }, accountId: string): Promise<DisconnectOutcome>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/facebook-oauth/disconnect.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { decideDisconnect, revokeFacebookGrant, type DisconnectPorts } from "./disconnect.ts";

const APP = { appId: "123", appSecret: "app-secret-must-not-leak" };
const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
const CREDENTIAL = "c0000000-0000-4000-8000-000000000001";

function ports(overrides: Partial<DisconnectPorts>, calls: Request[] = []): DisconnectPorts {
  return {
    readBinding: async () => ({ credential_id: CREDENTIAL }),
    countGrantMembers: async () => 1,
    readProviderUserId: async () => "fb-user-9",
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json(true);
    },
    ...overrides,
  };
}

Deno.test("revoke sends DELETE /{facebook-user-id}/permissions with the app access token only", async () => {
  const calls: Request[] = [];
  const revoked = await revokeFacebookGrant(async (input, init) => { calls.push(new Request(input, init)); return Response.json(true); }, APP, "fb-user-9");
  assertEquals(revoked, true);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "DELETE");
  const url = new URL(calls[0].url);
  assertEquals(url.origin + url.pathname, "https://graph.facebook.com/v22.0/fb-user-9/permissions");
  assertEquals(url.searchParams.get("access_token"), "123|app-secret-must-not-leak");
});

Deno.test("a Graph refusal or a non-true body is a failed revoke, not a thrown error", async () => {
  for (const reply of [() => Response.json({ error: { code: 100 } }, { status: 400 }), () => Response.json(false), () => { throw new TypeError("network"); }]) {
    const revoked = await revokeFacebookGrant(async () => reply(), APP, "fb-user-9");
    assertEquals(revoked, false);
  }
});

Deno.test("an account without a binding is removed without any Graph call", async () => {
  const calls: Request[] = [];
  const outcome = await decideDisconnect(ports({ readBinding: async () => null }, calls), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "no_binding" });
  assertEquals(calls, []);
});

Deno.test("a grant shared with a sibling account is left alone", async () => {
  const calls: Request[] = [];
  const outcome = await decideDisconnect(ports({ countGrantMembers: async () => 2 }, calls), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "grant_shared" });
  assertEquals(calls, []);
});

Deno.test("the last member of a grant de-authorizes the app", async () => {
  const calls: Request[] = [];
  const outcome = await decideDisconnect(ports({}, calls), APP, ACCOUNT);
  assertEquals(outcome, { revoked: true, reason: null });
  assertEquals(calls.length, 1);
  assertEquals(new URL(calls[0].url).pathname, "/v22.0/fb-user-9/permissions");
});

Deno.test("a credential without a provider user id cannot be revoked and says so", async () => {
  const outcome = await decideDisconnect(ports({ readProviderUserId: async () => null }), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "credential_missing" });
});

Deno.test("a failed Graph revoke is reported, the removal still proceeds", async () => {
  const outcome = await decideDisconnect(ports({ fetch: async () => Response.json({ error: {} }, { status: 500 }) }), APP, ACCOUNT);
  assertEquals(outcome, { revoked: false, reason: "revoke_failed" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test facebook-oauth/disconnect.test.ts`
Expected: FAIL with `Module not found "disconnect.ts"`.

- [ ] **Step 3: Write the implementation**

```ts
// supabase/functions/facebook-oauth/disconnect.ts
/**
 * Disconnect of a Facebook Page or Page-linked Instagram account.
 *
 * One Facebook user grant (facebook_user_credentials) backs every Postora
 * account connected through that login. De-authorizing the app invalidates
 * every user token of that grant, so it happens only when the removed
 * account is the grant's last member; a sibling keeps working and its own
 * reconnect shows the permission screen through auth_type=rerequest.
 *
 * The revoke carries the app access token. The stored user token is never
 * read here.
 */
export type DisconnectOutcome =
  | { revoked: false; reason: "no_binding" | "grant_shared" | "revoke_failed" | "credential_missing" }
  | { revoked: true; reason: null };

export interface DisconnectPorts {
  readBinding(accountId: string): Promise<{ credential_id: string } | null>;
  countGrantMembers(credentialId: string): Promise<number>;
  readProviderUserId(credentialId: string): Promise<string | null>;
  fetch: typeof fetch;
}

const GRAPH_VERSION = "v22.0";

export async function revokeFacebookGrant(
  fetchImpl: typeof fetch,
  app: { appId: string; appSecret: string },
  providerUserId: string,
): Promise<boolean> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(providerUserId)}/permissions`);
  url.searchParams.set("access_token", `${app.appId}|${app.appSecret}`);
  try {
    const response = await fetchImpl(url, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body === true || (typeof body === "object" && body !== null && (body as { success?: unknown }).success === true);
  } catch {
    // Meta unreachable or a malformed reply: the account is still removed in Postora.
    return false;
  }
}

export async function decideDisconnect(
  ports: DisconnectPorts,
  app: { appId: string; appSecret: string },
  accountId: string,
): Promise<DisconnectOutcome> {
  const binding = await ports.readBinding(accountId);
  if (!binding) return { revoked: false, reason: "no_binding" };
  if (await ports.countGrantMembers(binding.credential_id) > 1) return { revoked: false, reason: "grant_shared" };
  const providerUserId = await ports.readProviderUserId(binding.credential_id);
  if (!providerUserId) return { revoked: false, reason: "credential_missing" };
  const revoked = await revokeFacebookGrant(ports.fetch, app, providerUserId);
  return revoked ? { revoked: true, reason: null } : { revoked: false, reason: "revoke_failed" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test facebook-oauth/disconnect.test.ts`
Expected: `ok | 7 passed | 0 failed`.

- [ ] **Step 5: Register the test in CI**

Add `supabase/functions/facebook-oauth/disconnect.test.ts` to the same `tests=(` array as Task 1, after `supabase/functions/facebook-oauth/protectedPageConnect.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/facebook-oauth/disconnect.ts supabase/functions/facebook-oauth/disconnect.test.ts .github/workflows/ci.yml
git commit -m "feat(facebook-oauth): decide when a disconnect de-authorizes the Facebook user grant

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Route the `disconnect` action in `facebook-oauth/index.ts`

**Files:**
- Modify: `supabase/functions/facebook-oauth/index.ts` (`validActions` at line ~811; a new `if (action === "disconnect")` block placed directly **before** the `beginOAuthRequest` call around line 883, because the action neither starts nor continues an OAuth attempt)
- Test: `supabase/functions/_shared/protectedOAuthHandlers.test.ts`

**Interfaces:**
- Consumes: `decideDisconnect`, `DisconnectPorts` from Task 3.
- Produces: HTTP contract `POST { action: "disconnect", social_account_id }` → `200 { success: true, revoked: boolean, reason: string | null }`; `400 { error: "Invalid request body" }` when the id is missing or not a UUID; `404 { error: "Account not found" }` when the account is not the caller's Facebook/Instagram account.

- [ ] **Step 1: Write the failing handler tests**

Append to `supabase/functions/_shared/protectedOAuthHandlers.test.ts`. The harness (`probe()`, line ~100) seeds `social_accounts` through `current.socialRows` and knows no binding or credential table (`rowsFor`, line ~361, returns `[]` for them), and its query shim supports `select/eq/maybeSingle` but not `.in()` or `count`. So the handler test covers routing, ownership and the `no_binding` path; the shared/last-member decision is proven in Task 3's pure tests.

```ts
routeTest("disconnect is routed for an owned Meta account and removes nothing itself", async () => {
  for (const platform of ["facebook", "instagram"] as const) {
    const current = probe({ setting: "protected", socialRows: [{ id: ACCOUNT_ID, user_id: USER_ID, platform, is_active: true }] });
    const handler = await loadHandler("facebook-oauth/index.ts", current);
    const result = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", { action: "disconnect", social_account_id: ACCOUNT_ID });
    assertEquals(result.status, 200, platform);
    assertEquals(result.body, { success: true, revoked: false, reason: "no_binding" }, platform);
    assertEquals(providerUrls(current), [], platform);
    assertEquals(current.mutations, [], platform);
  }
});

routeTest("disconnect refuses a foreign, non-Meta or malformed account id before any provider call", async () => {
  const current = probe({ setting: "protected", socialRows: [
    { id: ACCOUNT_ID, user_id: OTHER_USER_ID, platform: "facebook", is_active: true },
    { id: TARGET_ID, user_id: USER_ID, platform: "threads", is_active: true },
  ] });
  const handler = await loadHandler("facebook-oauth/index.ts", current);
  const foreign = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", { action: "disconnect", social_account_id: ACCOUNT_ID });
  assertEquals(foreign.status, 404);
  const threads = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", { action: "disconnect", social_account_id: TARGET_ID });
  assertEquals(threads.status, 404);
  const malformed = await callJson(handler, "https://synthetic.invalid/functions/v1/facebook-oauth", { action: "disconnect", social_account_id: "not-a-uuid" });
  assertEquals(malformed.status, 400);
  assertEquals(providerUrls(current), []);
});
```

If `installClient`'s `Query` lacks `maybeSingle`, add it the same way `single` is implemented there (return the first matching row or `null`, never an error).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test --allow-env --allow-read --allow-write --allow-net --allow-run _shared/protectedOAuthHandlers.test.ts --filter "disconnect"`
Expected: FAIL with status `400` and body `{ error: "Invalid request body" }` (the action is not in `validActions` yet).

- [ ] **Step 3: Add the action to the validation list**

In `supabase/functions/facebook-oauth/index.ts` change

```ts
  const validActions = [
    "list_pages", "store_page", "store_account", "store_instagram",
    "authorize", "get_pending_selection",
  ];
```

to

```ts
  const validActions = [
    "list_pages", "store_page", "store_account", "store_instagram",
    "authorize", "get_pending_selection", "disconnect",
  ];
```

and extend `missingActionField` with one more clause before the closing `;`:

```ts
    (body.action === "disconnect" &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.social_account_id ?? "")))
```

- [ ] **Step 4: Add the action block**

Add the import next to the other local imports at the top of `facebook-oauth/index.ts`:

```ts
import { decideDisconnect } from "./disconnect.ts";
```

Insert the block directly before `const decision = await beginOAuthRequest({` (around line 883). `auth` (the result of `authenticateCaller(req, body.user_id)` at line ~794) and `supabase` (the service-role client) are already in scope there; `corsHeaders` is the restricted header set used by the other responses in this function.

```ts
    // Disconnect: withdraw the Facebook user grant when this account is its
    // last member, then let the caller delete the row. Neither an OAuth
    // attempt nor the credential schema is touched here, so it runs before
    // the lifecycle decision.
    if (action === "disconnect") {
      const socialAccountId = String(body.social_account_id);
      const logDisconnectEvent = async (message: string, metadata: Record<string, unknown>) => {
        const { error: logError } = await supabase.from("system_logs").insert({
          source: "facebook-oauth",
          category: "auth",
          level: "warn",
          message,
          user_id: auth.userId,
          metadata: { action: "disconnect", social_account_id: socialAccountId, ...metadata },
        }).abortSignal(AbortSignal.timeout(2_000));
        if (logError) console.error("[facebook-oauth] Disconnect log rejected:", logError.message);
      };

      const { data: account, error: accountError } = await supabase
        .from("social_accounts")
        .select("id, platform")
        .eq("id", socialAccountId)
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (accountError) throw new Error("Account lookup failed");
      if (!account || !["facebook", "instagram"].includes(String(account.platform))) {
        await logDisconnectEvent("Facebook disconnect refused: account not found for this caller", {});
        return new Response(JSON.stringify({ error: "Account not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const appId = Deno.env.get("FACEBOOK_APP_ID");
      const appSecret = Deno.env.get("FACEBOOK_APP_SECRET");
      if (!appId || !appSecret) {
        await logDisconnectEvent("Facebook disconnect: app credentials not configured; account removed in Postora only", { reason: "credentials_missing" });
        return new Response(JSON.stringify({ success: true, revoked: false, reason: "credentials_missing" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const outcome = await decideDisconnect({
        readBinding: async (id) => {
          const { data, error } = await supabase
            .from("facebook_user_credential_bindings")
            .select("credential_id")
            .eq("social_account_id", id)
            .eq("user_id", auth.userId)
            .maybeSingle();
          if (error) throw new Error("Binding lookup failed");
          return data;
        },
        countGrantMembers: async (credentialId) => {
          const { count, error } = await supabase
            .from("facebook_user_credential_bindings")
            .select("social_account_id", { count: "exact", head: true })
            .eq("credential_id", credentialId)
            .eq("user_id", auth.userId);
          if (error) throw new Error("Grant member count failed");
          return count ?? 0;
        },
        readProviderUserId: async (credentialId) => {
          const { data, error } = await supabase
            .from("facebook_user_credentials")
            .select("provider_user_id")
            .eq("id", credentialId)
            .eq("user_id", auth.userId)
            .maybeSingle();
          if (error) throw new Error("Credential lookup failed");
          return data?.provider_user_id ?? null;
        },
        fetch,
      }, { appId, appSecret }, socialAccountId);

      if (!outcome.revoked && outcome.reason !== "no_binding" && outcome.reason !== "grant_shared") {
        await logDisconnectEvent("Facebook de-authorization did not succeed; account removed in Postora only", { reason: outcome.reason });
      }
      return new Response(JSON.stringify({ success: true, revoked: outcome.revoked, reason: outcome.reason }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno check facebook-oauth/index.ts && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test --allow-env --allow-read --allow-write --allow-net --allow-run _shared/protectedOAuthHandlers.test.ts`
Expected: check clean; suite `ok`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/facebook-oauth/index.ts supabase/functions/_shared/protectedOAuthHandlers.test.ts
git commit -m "feat(facebook-oauth): disconnect action withdraws the grant of a last-member account

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Profiles-page Disconnect calls the action for Facebook and Instagram

**Files:**
- Modify: `src/hooks/useSocialProfiles.tsx` (`useDisconnectAccountFromProfile`, lines ~176–195)
- Test: `src/hooks/__tests__/useSocialProfiles.test.tsx`

**Interfaces:**
- Consumes: `facebook-oauth` `{ action: "disconnect", social_account_id }` from Task 4.

- [ ] **Step 1: Write the failing test**

Append a `describe` to `src/hooks/__tests__/useSocialProfiles.test.tsx`. The file mocks `@/integrations/supabase/client`; extend that mock with `functions: { invoke: vi.fn() }` and make `from("social_accounts")` return `select().eq().maybeSingle()` and `delete().eq()` chains:

```tsx
describe("useDisconnectAccountFromProfile", () => {
    const invoke = supabase.functions.invoke as unknown as Mock;
    const from = supabase.from as unknown as Mock;
    const deleteEq = vi.fn(async () => ({ error: null }));

    beforeEach(() => {
        vi.clearAllMocks();
        from.mockImplementation(() => ({
            select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { platform: "instagram" }, error: null })) })) })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));
    });

    it.each(["facebook", "instagram"])("withdraws the Meta grant before removing a %s account", async (platform) => {
        from.mockImplementation(() => ({
            select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { platform }, error: null })) })) })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));
        invoke.mockResolvedValue({ data: { success: true, revoked: true, reason: null }, error: null });
        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper: createWrapper() });
        await result.current.mutateAsync("acc-1");
        expect(invoke).toHaveBeenCalledWith("facebook-oauth", { body: { action: "disconnect", social_account_id: "acc-1" } });
        expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(deleteEq.mock.invocationCallOrder[0]);
    });

    it("still removes the account when the grant withdrawal fails", async () => {
        invoke.mockResolvedValue({ data: null, error: new Error("offline") });
        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper: createWrapper() });
        await result.current.mutateAsync("acc-1");
        expect(deleteEq).toHaveBeenCalledWith("id", "acc-1");
    });

    it("does not call Meta for a Threads account", async () => {
        from.mockImplementation(() => ({
            select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { platform: "threads" }, error: null })) })) })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));
        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper: createWrapper() });
        await result.current.mutateAsync("acc-1");
        expect(invoke).not.toHaveBeenCalled();
        expect(deleteEq).toHaveBeenCalledWith("id", "acc-1");
    });
});
```

Add `useDisconnectAccountFromProfile` to the import from `"../useSocialProfiles"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/hooks/__tests__/useSocialProfiles.test.tsx`
Expected: the two Meta cases FAIL (`invoke` not called); the Threads case passes.

- [ ] **Step 3: Implement**

In `src/hooks/useSocialProfiles.tsx`, inside `useDisconnectAccountFromProfile`'s `mutationFn`, after the TikTok branch add:

```ts
      if (account?.platform === "facebook" || account?.platform === "instagram") {
        // Withdraw the Facebook user grant when this account is its last member, so reconnecting shows Meta's permission screen.
        const { error: revokeError } = await supabase.functions.invoke("facebook-oauth", { body: { action: "disconnect", social_account_id: accountId } });
        // Best effort, like TikTok: removing the account must not depend on Meta being reachable.
        if (revokeError) console.warn("Meta grant withdrawal before account removal failed:", revokeError);
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/hooks/__tests__/useSocialProfiles.test.tsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSocialProfiles.tsx src/hooks/__tests__/useSocialProfiles.test.tsx
git commit -m "feat(profiles): withdraw the Meta grant before removing a Facebook or Instagram account

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Threads: remove the dead probe, show the held permissions

**Files:**
- Modify: `supabase/functions/threads-oauth/index.ts` (lines ~126–150)
- Modify: `src/components/profiles/ProfileRow.tsx` (the per-account badge cell, next to the Pinterest access badge around line 659)

**Interfaces:**
- Consumes: `account.account_metadata.granted_scopes: string[]` (already written by `threads-oauth` at line ~268; the `SocialAccount` type in `src/hooks/useSocialProfiles.tsx` exposes `account_metadata`).

- [ ] **Step 1: Remove the probe**

In `supabase/functions/threads-oauth/index.ts` delete from `let permissionsFromApi: string[] = [];` through the closing `}` of the `if (!tokenGrantedScopes.includes("threads_share_to_instagram")) { … }` block, and replace

```ts
  const effectiveGrantedScopes = permissionsFromApi.length > 0
    ? permissionsFromApi
    : tokenGrantedScopes;
```

with

```ts
  // Threads has no /me/permissions edge (verified 2026-11-05: GET answers
  // "nonexisting field (permissions)"); the token response is the only
  // source of the granted scopes.
  const effectiveGrantedScopes = tokenGrantedScopes;
```

- [ ] **Step 2: Typecheck**

Run: `cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno check threads-oauth/index.ts`
Expected: clean.

- [ ] **Step 3: Add the popover**

In `src/components/profiles/ProfileRow.tsx` import `Popover, PopoverContent, PopoverTrigger` from `@/components/ui/popover` and `KeyRound` from `lucide-react`. In the badge cell where the Pinterest access badge is rendered (`account.platform === 'pinterest' && …`, line ~659), add a sibling block:

```tsx
                              {account.platform === 'threads' && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <Badge variant="outline" className="text-xs gap-1 cursor-pointer">
                                      <KeyRound className="w-3 h-3" />
                                      Permissions
                                    </Badge>
                                  </PopoverTrigger>
                                  <PopoverContent className="w-80 text-xs space-y-2">
                                    <p className="font-medium">Permissions Postora holds for this Threads account</p>
                                    <ul className="list-disc pl-4">
                                      {((account.account_metadata as { granted_scopes?: string[] } | null)?.granted_scopes ?? []).map((scope) => (
                                        <li key={scope}>{scope}</li>
                                      ))}
                                    </ul>
                                    <p className="text-muted-foreground">
                                      Threads does not offer a permission review on reconnect. To withdraw these, remove the app under Threads › Settings › Security › Apps and websites.
                                    </p>
                                  </PopoverContent>
                                </Popover>
                              )}
```

- [ ] **Step 4: Run the frontend gates**

Run: `npm run typecheck && npx vitest run src/components/profiles && npm run build`
Expected: all clean. (There is no existing ProfileRow test for badges; the popover is static rendering of stored data and is covered by the live journey.)

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/threads-oauth/index.ts src/components/profiles/ProfileRow.tsx
git commit -m "feat(threads): show the held permissions in-app and drop the probe Threads never answered

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Gates, guards and the PR

**Files:** none new.

- [ ] **Step 1: Full local gates**

Run:
```bash
cd supabase/functions && DENO_DIR=/f/Dev/Runtimes/deno npx -y deno check facebook-oauth/index.ts instagram-business-oauth/index.ts instagram-oauth/index.ts threads-oauth/index.ts _shared/metaConsentPrompt.ts facebook-oauth/disconnect.ts
DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test _shared/metaConsentPrompt.test.ts facebook-oauth/disconnect.test.ts facebook-oauth/protectedPageConnect.test.ts
DENO_DIR=/f/Dev/Runtimes/deno npx -y deno test --allow-env --allow-read --allow-write --allow-net --allow-run _shared/protectedOAuthHandlers.test.ts _shared/protectedRouteHandlers.test.ts
cd ../.. && npm run typecheck && npm run test && npm run build
```
Expected: everything green.

- [ ] **Step 2: Guard passes**

Run `clean-code-guard` on the production diff and `test-guard` on the test diff; fix findings before the PR.

- [ ] **Step 3: Push and open the PR**

```bash
git push origin HEAD:refs/heads/feat/meta-reconnect-consent
gh pr create --repo lolotam/POSTORA --base main --head feat/meta-reconnect-consent --title "feat(meta-oauth): show the permission screen again on Instagram, Facebook and Threads reconnects" --body-file <body>
```
The body summarises the spec sections 3–4, lists the gates run, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Link and watch the PR; merge only on green CI at the exact head and after the owner card.

- [ ] **Step 4: Live journeys (owner)**

After the edge sync lands, run spec section 7 with the owner and record the direct-Instagram result in the spec's section 3 as a follow-up docs commit.
