# YouTube stage 2: resource browse, details and capability contracts — implementation plan

> For agentic workers: you see one task at a time. Each task is self-contained: it repeats the rules that apply to it and pastes the signatures it depends on. Read `ARCHITECTURE.md` before editing (`§12` to `§17`, `§24`, `§26`, `§37` for edge function tasks; `§1`, `§3`, `§4`, `§11`, `§31`, `§33` for frontend tasks). Write the test first, run it, and confirm it fails for the stated reason before you write the implementation.

**Goal:** A capability contract endpoint, a native read-only resource browse API (channel, uploads, video details) and a real page that consumes both.

**Spec:** `docs/specs/2026-11-20-youtube-stage2-resource-browse.md`. This plan is written against the recommended option of every row in its "Decisions needed from Waleed" table. Section [If a decision changes](#if-a-decision-changes) names the tasks to adjust.

**Stack:** Deno edge functions (Zod `npm:zod@3.23.8`), React 18 + TypeScript + React Query + Vitest. No migration.

**Baseline:** `origin/main` at `546b88ac` (stage 1 merged: PRs #445, #446, #447).

## Global constraints

These apply to every task. Each task repeats the ones it can break.

- No new `eslint-disable` comment and no new `any`. The "Lint/i18n: no regressions" CI job refuses added suppressions. Type untrusted values as `unknown` and narrow them, the way `createSupabaseYouTubeRefreshStore(admin: unknown)` does in `supabase/functions/_shared/youtubeTokenRefresh.ts`.
- Every user-visible string goes through `t("key", "English default")` with a literal key, and the key gets an Arabic entry in `src/i18n/locales/ar/<namespace>.json` in the same task. `npm run check:i18n` fails on a key used in code but missing from the bundle, and on a bundle key no code uses (orphan). Never build a key from a variable.
- Applied migrations are immutable. This stage adds none. If you believe one is needed, stop and report.
- Never `git add -A` and never `git add .`. Stage only the files the task lists, then `git commit -- <files>`.
- Never apply anything to production. Never run `npx supabase functions deploy`. Edge functions deploy through the Dokploy schedule after a merge to `main`.
- No access token, refresh token, authorization header, Google error text or SQL text in any response, log line, test fixture file or commit. Test tokens are random values created inside the test.
- No live Google call in any test. Provider behaviour is faked through ports or a fake `fetch`.
- Access tokens come only from `refreshYouTubeAccountToken` in `_shared/youtubeTokenRefresh.ts`. Never call Google's token endpoint from new code.
- Do not import `listChannelVideos` or `videoTitles` from `_shared/youtubeComments.ts` (`callYouTube` is module-private and cannot be imported anyway). The only symbol stage 2 may import from that file is `uploadsPlaylistId`.
- Composio-managed accounts (`auth_provider = 'composio'`) never reach the native read client.
- Deno commands (run from the repository root):
  - `deno check --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json <files>`
  - `deno test --allow-env --allow-read --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/youtube-resources/`
  - If `deno` is not installed, stop and report. Do not skip the run.
- Frontend commands: `npx vitest run <file>`, `npm run typecheck`, `npx eslint <files>`, `npm run check:i18n`.
- Each stage ends with guard passes by the orchestrator (`clean-code-guard` on production code, `test-guard` on tests, `docs-guard` on documentation), a scoped commit per task, and a PR whose body states the tier and ends with the Claude Code attribution line.

## Delivery tiers

Tier names follow `CLAUDE.md`, "Delivery tiers". The owner confirms the tier per stage (spec decision D9). Proposed:

| Stage | Tier | Why |
|---|---|---|
| 2a | Heavy | New authenticated service-role endpoint: authentication and ownership of OAuth-bearing rows are "permissions/auth, security" |
| 2b | Heavy | Same endpoint now obtains and uses OAuth access tokens against Google |
| 2c | Medium | Frontend feature, a route and a flag; no auth rule, no money, no migration |

Each task below also states its own tier, so a reviewer can see which tasks carry the risk.

## File map

| File | Created in | Purpose |
|---|---|---|
| `supabase/functions/youtube-resources/contracts.ts` | 2a-1, extended 2b-1 | The contract shared with the frontend. Import-free |
| `supabase/functions/youtube-resources/capabilities.ts` | 2a-2 | `deriveYouTubeCapabilities` |
| `supabase/functions/youtube-resources/handler.ts` | 2a-3, extended 2b-3 to 2b-5 | `createYouTubeResourcesHandler` |
| `supabase/functions/youtube-resources/index.ts` | 2a-4, extended 2b-6 | Adapter and port wiring |
| `supabase/functions/youtube-resources/youtubeReadClient.ts` | 2b-1, extended 2b-2 | `createYouTubeReadClient` |
| `supabase/functions/youtube-resources/tokens.ts` | 2b-6 | `tokenResultFromOutcome` |
| `supabase/functions/youtube-resources/rateLimit.ts` | 2b-6 | `toRateLimitDecision` |
| `supabase/functions/youtube-resources/requestExamples.fixture.ts` | 2b-5 | Request bodies shared by the Deno handler test and the Vitest gateway test |
| `src/features/youtube-management/**` | 2c-1 to 2c-6 | Frontend feature |
| `src/pages/youtube/YouTubeManagementPage.tsx` | 2c-7 | Page consumer |

---

# Stage 2a: capability contract endpoint

Branch: `git fetch origin && git checkout --no-track -b T3-CODE/youtube-stage2a-capabilities origin/main`. Push only with `git push origin HEAD:T3-CODE/youtube-stage2a-capabilities`.

## Task 2a-1: the contract file

**Tier:** Medium (pure types and constants, but it is the public API contract).

**Files:** create `supabase/functions/youtube-resources/contracts.ts` and `supabase/functions/youtube-resources/contracts.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** `contracts.ts` must have no `import` statement and use no Deno API, because the Vite frontend imports it later. No `any`. No `eslint-disable`. Commit only the two files.

- [ ] **Step 1: write the failing test** `supabase/functions/youtube-resources/contracts.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isYouTubeResourceErrorCode,
  YOUTUBE_RESOURCE_ERROR_STATUS,
  YOUTUBE_RESOURCE_QUOTA_POLICY,
  YOUTUBE_SCOPE,
} from "./contracts.ts";

Deno.test("each error code keeps its documented HTTP status", () => {
  assertEquals(YOUTUBE_RESOURCE_ERROR_STATUS, {
    invalid_request: 400,
    invalid_cursor: 400,
    unauthorized: 401,
    missing_scope: 403,
    not_found: 404,
    method_not_allowed: 405,
    provider_unsupported: 409,
    reconnect_required: 409,
    rate_limited: 429,
    quota_exceeded: 429,
    internal_error: 500,
    upstream_unavailable: 502,
  });
});

Deno.test("isYouTubeResourceErrorCode accepts known codes and rejects everything else", () => {
  assertEquals(isYouTubeResourceErrorCode("quota_exceeded"), true);
  assertEquals(isYouTubeResourceErrorCode("Quota exceeded for quota metric"), false);
  assertEquals(isYouTubeResourceErrorCode(429), false);
  assertEquals(isYouTubeResourceErrorCode(null), false);
});

Deno.test("the quota policy is the one the specification publishes", () => {
  assertEquals(YOUTUBE_RESOURCE_QUOTA_POLICY.per_user_burst, { limit: 30, window_seconds: 600 });
  assertEquals(YOUTUBE_RESOURCE_QUOTA_POLICY.per_user_daily, { limit: 300, window_seconds: 86400 });
  assertEquals(YOUTUBE_RESOURCE_QUOTA_POLICY.unit_costs, { channel: 1, videos_page: 1, video: 1 });
});

Deno.test("scope constants are the full Google scope URLs", () => {
  assertEquals(YOUTUBE_SCOPE.readonly, "https://www.googleapis.com/auth/youtube.readonly");
  assertEquals(YOUTUBE_SCOPE.upload, "https://www.googleapis.com/auth/youtube.upload");
  assertEquals(YOUTUBE_SCOPE.force_ssl, "https://www.googleapis.com/auth/youtube.force-ssl");
});
```

- [ ] **Step 2: run it and confirm it fails** because `./contracts.ts` does not exist:

```bash
deno test --allow-env --allow-read --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/youtube-resources/
```

- [ ] **Step 3: write `contracts.ts`** with exactly these exports:

```ts
export const YOUTUBE_RESOURCES_SCHEMA_VERSION = 1 as const;

export const YOUTUBE_SCOPE = {
  readonly: "https://www.googleapis.com/auth/youtube.readonly",
  upload: "https://www.googleapis.com/auth/youtube.upload",
  force_ssl: "https://www.googleapis.com/auth/youtube.force-ssl",
} as const;

export const YOUTUBE_RESOURCE_ERROR_STATUS = {
  invalid_request: 400,
  invalid_cursor: 400,
  unauthorized: 401,
  missing_scope: 403,
  not_found: 404,
  method_not_allowed: 405,
  provider_unsupported: 409,
  reconnect_required: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  internal_error: 500,
  upstream_unavailable: 502,
} as const;

export type YouTubeResourceErrorCode = keyof typeof YOUTUBE_RESOURCE_ERROR_STATUS;

export function isYouTubeResourceErrorCode(value: unknown): value is YouTubeResourceErrorCode {
  return typeof value === "string" && Object.keys(YOUTUBE_RESOURCE_ERROR_STATUS).includes(value);
}

export const YOUTUBE_RESOURCE_QUOTA_POLICY = {
  provider_quota: "not_tracked",
  unit_costs: { channel: 1, videos_page: 1, video: 1 },
  per_user_burst: { limit: 30, window_seconds: 600 },
  per_user_daily: { limit: 300, window_seconds: 86400 },
} as const;

export type YouTubeScopeState = "granted" | "missing" | "unknown";

export type YouTubeCapabilityReason =
  | "reconnect_required"
  | "missing_scope"
  | "provider_unsupported";

export type YouTubeCapabilityState =
  | { state: "available" }
  | { state: "unknown" }
  | { state: "unavailable"; reason: YouTubeCapabilityReason };

export interface YouTubeAccountCapabilities {
  account_id: string;
  channel_id: string | null;
  channel_title: string | null;
  provider: "native" | "composio";
  connection: "ok" | "reconnect_required";
  scopes: {
    readonly: YouTubeScopeState;
    upload: YouTubeScopeState;
    force_ssl: YouTubeScopeState;
  };
  capabilities: {
    browse: YouTubeCapabilityState;
    upload: YouTubeCapabilityState;
    comments: YouTubeCapabilityState;
  };
  quota: typeof YOUTUBE_RESOURCE_QUOTA_POLICY;
}

export interface YouTubeResourceSuccess<T> {
  schema_version: typeof YOUTUBE_RESOURCES_SCHEMA_VERSION;
  request_id: string;
  freshness: { fetched_at: string; source: "database" | "provider" };
  data: T;
}

export interface YouTubeResourceFailure {
  error: YouTubeResourceErrorCode;
  request_id: string;
  retry_after_seconds?: number;
}
```

- [ ] **Step 4: verify.** Run the `deno test` command from step 2 (4 passed) and:

```bash
deno check --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/youtube-resources/contracts.ts supabase/functions/youtube-resources/contracts.test.ts
git grep -n "^import" -- supabase/functions/youtube-resources/contracts.ts   # must print nothing
```

- [ ] **Step 5: commit.**

```bash
git add supabase/functions/youtube-resources/contracts.ts supabase/functions/youtube-resources/contracts.test.ts
git commit -m "feat(youtube): resource contract types and error codes" -- supabase/functions/youtube-resources/contracts.ts supabase/functions/youtube-resources/contracts.test.ts
```

## Task 2a-2: capability derivation

**Tier:** Medium (pure function, no I/O).

**Files:** create `supabase/functions/youtube-resources/capabilities.ts` and `supabase/functions/youtube-resources/capabilities.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** pure function, no I/O, no `any`, no `eslint-disable`. Reuse the existing comment rule; do not write a second one. Commit only the two files.

**You depend on (already on `main`, in `supabase/functions/_shared/youtubeCommentCapability.ts`):**

```ts
export function grantedScopes(metadata: unknown): string[];
export function youtubeCommentCapability(
  account: { auth_provider?: string | null; account_metadata?: unknown },
): "capable" | "reconnect_required";
```

**You depend on (from task 2a-1, `./contracts.ts`):** `YOUTUBE_SCOPE`, `YOUTUBE_RESOURCE_QUOTA_POLICY`, and the types `YouTubeAccountCapabilities`, `YouTubeCapabilityState`, `YouTubeScopeState`.

- [ ] **Step 1: write the failing test** `capabilities.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveYouTubeCapabilities, type YouTubeCapabilityAccountInput } from "./capabilities.ts";
import { YOUTUBE_SCOPE } from "./contracts.ts";

const ALL_SCOPES = [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl];

function account(overrides: Partial<YouTubeCapabilityAccountInput> = {}): YouTubeCapabilityAccountInput {
  return {
    id: "0ee20001-0000-4000-8000-000000000021",
    channelId: "UCfixturechannel000000001",
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    hasAccessToken: true,
    hasRefreshToken: true,
    accountMetadata: { granted_scopes: ALL_SCOPES },
    ...overrides,
  };
}

Deno.test("native row with all scopes recorded can browse, upload and comment", () => {
  const result = deriveYouTubeCapabilities(account());
  assertEquals(result.provider, "native");
  assertEquals(result.connection, "ok");
  assertEquals(result.scopes, { readonly: "granted", upload: "granted", force_ssl: "granted" });
  assertEquals(result.capabilities, {
    browse: { state: "available" },
    upload: { state: "available" },
    comments: { state: "available" },
  });
});

Deno.test("native row with no recorded scopes is unknown for browse and upload, and keeps the comment rule", () => {
  const result = deriveYouTubeCapabilities(account({ accountMetadata: {} }));
  assertEquals(result.scopes, { readonly: "unknown", upload: "unknown", force_ssl: "unknown" });
  assertEquals(result.capabilities.browse, { state: "unknown" });
  assertEquals(result.capabilities.upload, { state: "unknown" });
  assertEquals(result.capabilities.comments, { state: "unavailable", reason: "missing_scope" });
});

Deno.test("a recorded list without readonly blocks browse only", () => {
  const result = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(result.scopes.readonly, "missing");
  assertEquals(result.capabilities.browse, { state: "unavailable", reason: "missing_scope" });
  assertEquals(result.capabilities.upload, { state: "available" });
  assertEquals(result.capabilities.comments, { state: "available" });
});

Deno.test("needs_reauth makes every capability reconnect_required", () => {
  const result = deriveYouTubeCapabilities(account({ needsReauth: true }));
  assertEquals(result.connection, "reconnect_required");
  const expected = { state: "unavailable", reason: "reconnect_required" };
  assertEquals(result.capabilities, { browse: expected, upload: expected, comments: expected });
});

Deno.test("a native row with no token at all needs a reconnect", () => {
  const result = deriveYouTubeCapabilities(account({ hasAccessToken: false, hasRefreshToken: false }));
  assertEquals(result.connection, "reconnect_required");
});

Deno.test("composio row: browse unsupported, upload unknown, comments by the existing rule", () => {
  const result = deriveYouTubeCapabilities(
    account({ authProvider: "composio", hasAccessToken: false, hasRefreshToken: false, accountMetadata: {} }),
  );
  assertEquals(result.provider, "composio");
  assertEquals(result.connection, "ok");
  assertEquals(result.scopes, { readonly: "unknown", upload: "unknown", force_ssl: "unknown" });
  assertEquals(result.capabilities.browse, { state: "unavailable", reason: "provider_unsupported" });
  assertEquals(result.capabilities.upload, { state: "unknown" });
  assertEquals(result.capabilities.comments, { state: "available" });
});
```

- [ ] **Step 2: run and confirm it fails** because `./capabilities.ts` does not exist (same `deno test` command as in the global constraints).

- [ ] **Step 3: implement `capabilities.ts`.** Shape:

```ts
import { grantedScopes, youtubeCommentCapability } from "../_shared/youtubeCommentCapability.ts";
import {
  YOUTUBE_RESOURCE_QUOTA_POLICY,
  YOUTUBE_SCOPE,
  type YouTubeAccountCapabilities,
  type YouTubeCapabilityState,
  type YouTubeScopeState,
} from "./contracts.ts";

export interface YouTubeCapabilityAccountInput {
  id: string;
  channelId: string | null;
  channelTitle: string | null;
  authProvider: string | null;
  needsReauth: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  accountMetadata: unknown;
}

const RECONNECT: YouTubeCapabilityState = { state: "unavailable", reason: "reconnect_required" };

export function deriveYouTubeCapabilities(
  account: YouTubeCapabilityAccountInput,
): YouTubeAccountCapabilities {
  const composio = account.authProvider === "composio";
  const recorded = composio ? [] : grantedScopes(account.accountMetadata);
  const scopeState = (scope: string): YouTubeScopeState =>
    recorded.length === 0 ? "unknown" : recorded.includes(scope) ? "granted" : "missing";
  const scopes = {
    readonly: scopeState(YOUTUBE_SCOPE.readonly),
    upload: scopeState(YOUTUBE_SCOPE.upload),
    force_ssl: scopeState(YOUTUBE_SCOPE.force_ssl),
  };
  const needsReconnect = account.needsReauth ||
    (!composio && !account.hasAccessToken && !account.hasRefreshToken);
  // browse, upload, comments: apply the six rules of spec section 3.3 in order.
  // comments must call youtubeCommentCapability({ auth_provider, account_metadata }).
  ...
}
```

Rules to implement (spec section 3.3):
1. `browse`: composio gives `{ state: "unavailable", reason: "provider_unsupported" }`; else `needsReconnect` gives `RECONNECT`; else `scopes.readonly` `granted` gives available, `unknown` gives `{ state: "unknown" }`, `missing` gives `{ state: "unavailable", reason: "missing_scope" }`.
2. `upload`: `needsReconnect` gives `RECONNECT`; else composio gives `{ state: "unknown" }`; else `upload` or `force_ssl` granted gives available; else `recorded.length === 0` gives `{ state: "unknown" }`; else `{ state: "unavailable", reason: "missing_scope" }`.
3. `comments`: `needsReconnect` gives `RECONNECT`; else `youtubeCommentCapability({ auth_provider: account.authProvider, account_metadata: account.accountMetadata }) === "capable"` gives available; else `{ state: "unavailable", reason: "missing_scope" }`.
4. `quota` is `YOUTUBE_RESOURCE_QUOTA_POLICY`; `account_id`, `channel_id`, `channel_title` copy the input.

- [ ] **Step 4: verify.** `deno test` (10 passed in the directory) and `deno check` on both new files.

- [ ] **Step 5: commit.**

```bash
git add supabase/functions/youtube-resources/capabilities.ts supabase/functions/youtube-resources/capabilities.test.ts
git commit -m "feat(youtube): derive per-account capability contract" -- supabase/functions/youtube-resources/capabilities.ts supabase/functions/youtube-resources/capabilities.test.ts
```

## Task 2a-3: the handler with the `capabilities` operation

**Tier:** Heavy (authentication and ownership boundary).

**Files:** create `supabase/functions/youtube-resources/handler.ts` and `supabase/functions/youtube-resources/handler.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** the handler does no I/O of its own; everything goes through `ports`. Identity comes only from `ports.auth.authenticate(req)`; a `user_id` in the body is refused by the strict schema. A foreign account and a missing account must produce the same status and the same body (apart from `request_id`, which is fixed in the tests). No token may appear in a response. No `any`, no `eslint-disable`. Use `restrictedCorsHeaders` from `../_shared/cors.ts`, never the wildcard `corsHeaders`. Commit only the two files.

**You depend on:**

```ts
// ../_shared/cors.ts (on main)
export function restrictedCorsHeaders(req: Request): Record<string, string>;

// ./capabilities.ts (task 2a-2)
export function deriveYouTubeCapabilities(account: YouTubeCapabilityAccountInput): YouTubeAccountCapabilities;
// YouTubeCapabilityAccountInput = { id, channelId, channelTitle, authProvider, needsReauth, hasAccessToken, hasRefreshToken, accountMetadata }

// ./contracts.ts (task 2a-1)
export const YOUTUBE_RESOURCE_ERROR_STATUS: Record<YouTubeResourceErrorCode, number>;
export const YOUTUBE_RESOURCES_SCHEMA_VERSION: 1;
```

- [ ] **Step 1: write the failing test** `handler.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createYouTubeResourcesHandler,
  type YouTubeResourceAccount,
  type YouTubeResourceRefusal,
  type YouTubeResourcesPorts,
} from "./handler.ts";
import { YOUTUBE_SCOPE } from "./contracts.ts";

const ENDPOINT = "https://api.postora.cloud/functions/v1/youtube-resources";
const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const FOREIGN_ACCOUNT_ID = "0ee20002-0000-4000-8000-000000000022";
const REQUEST_ID = "0ee90001-0000-4000-8000-000000000091";
const CHANNEL_ID = "UCfixturechannel000000001";

function request(body: unknown, method = "POST"): Request {
  return new Request(ENDPOINT, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function fixture(overrides: {
  authenticated?: boolean;
  account?: Partial<YouTubeResourceAccount>;
  loadError?: boolean;
} = {}) {
  const accessToken = crypto.randomUUID() + crypto.randomUUID();
  const refreshToken = crypto.randomUUID() + crypto.randomUUID();
  const calls = { auth: 0, load: 0 };
  const logs: YouTubeResourceRefusal[] = [];
  const account: YouTubeResourceAccount = {
    id: ACCOUNT_ID,
    userId: USER_ID,
    channelId: CHANNEL_ID,
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    accessToken,
    refreshToken,
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    accountMetadata: {
      granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl],
    },
    ...overrides.account,
  };
  const ports: YouTubeResourcesPorts = {
    auth: {
      authenticate: () => {
        calls.auth++;
        return overrides.authenticated === false
          ? Promise.reject(new Error("unauthorized"))
          : Promise.resolve({ userId: USER_ID });
      },
    },
    accounts: {
      load: ({ accountId, userId }) => {
        calls.load++;
        if (overrides.loadError) return Promise.reject(new Error("account_read_failed"));
        return Promise.resolve(accountId === ACCOUNT_ID && userId === USER_ID ? account : null);
      },
    },
    clock: { now: () => new Date("2026-11-20T10:00:00.000Z") },
    ids: { requestId: () => REQUEST_ID },
    log: {
      refusal: (entry) => {
        logs.push(entry);
        return Promise.resolve();
      },
    },
  };
  return { handler: createYouTubeResourcesHandler(ports), calls, logs, accessToken, refreshToken };
}

Deno.test("a request without a valid user is refused before any account read", async () => {
  const { handler, calls } = fixture({ authenticated: false });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "unauthorized", request_id: REQUEST_ID });
  assertEquals(calls.load, 0);
});

Deno.test("a body that names a user is refused by the strict schema", async () => {
  const { handler, calls } = fixture();
  const response = await handler(
    request({ operation: "capabilities", account_id: ACCOUNT_ID, user_id: USER_ID }),
  );
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "invalid_request");
  assertEquals(calls.load, 0);
});

Deno.test("another owner's account and an unknown account get the same answer", async () => {
  const { handler } = fixture();
  const foreign = await handler(request({ operation: "capabilities", account_id: FOREIGN_ACCOUNT_ID }));
  const unknown = await handler(
    request({ operation: "capabilities", account_id: "0ee20009-0000-4000-8000-000000000029" }),
  );
  assertEquals(foreign.status, 404);
  assertEquals(unknown.status, 404);
  assertEquals(await foreign.text(), await unknown.text());
});

Deno.test("capabilities answers from the database and never returns a credential", async () => {
  const { handler, accessToken, refreshToken } = fixture();
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  const text = await response.text();
  assertEquals(text.includes(accessToken), false);
  assertEquals(text.includes(refreshToken), false);
  const body = JSON.parse(text);
  assertEquals(body.schema_version, 1);
  assertEquals(body.request_id, REQUEST_ID);
  assertEquals(body.freshness, { fetched_at: "2026-11-20T10:00:00.000Z", source: "database" });
  assertEquals(body.data.account_id, ACCOUNT_ID);
  assertEquals(body.data.capabilities.browse, { state: "available" });
});

Deno.test("a failed account read is an internal error, not a not_found", async () => {
  const { handler, logs } = fixture({ loadError: true });
  const response = await handler(request({ operation: "capabilities", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 500);
  assertEquals((await response.json()).error, "internal_error");
  assertEquals(logs.map((entry) => entry.code), ["internal_error"]);
});

Deno.test("only POST is served", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request(null, "GET"));
  assertEquals(response.status, 405);
  assertEquals(calls.auth, 0);
});
```

- [ ] **Step 2: run and confirm it fails** because `./handler.ts` does not exist.

- [ ] **Step 3: implement `handler.ts`.** Exports and flow:

```ts
import { z } from "npm:zod@3.23.8";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { deriveYouTubeCapabilities } from "./capabilities.ts";
import {
  YOUTUBE_RESOURCE_ERROR_STATUS,
  YOUTUBE_RESOURCES_SCHEMA_VERSION,
  type YouTubeResourceErrorCode,
} from "./contracts.ts";

export interface YouTubeResourceAccount {
  id: string;
  userId: string;
  channelId: string | null;
  channelTitle: string | null;
  authProvider: string | null;
  needsReauth: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  accountMetadata: unknown;
}

export interface YouTubeResourceRefusal {
  operation: string;
  code: YouTubeResourceErrorCode;
  userId: string | null;
  accountId: string | null;
  requestId: string;
}

export interface YouTubeResourcesPorts {
  auth: { authenticate(req: Request): Promise<{ userId: string }> };
  accounts: {
    load(input: { accountId: string; userId: string }): Promise<YouTubeResourceAccount | null>;
  };
  clock: { now(): Date };
  ids: { requestId(): string };
  log: { refusal(entry: YouTubeResourceRefusal): Promise<void> };
}

const CapabilitiesRequest = z.object({
  operation: z.literal("capabilities"),
  account_id: z.string().uuid(),
}).strict();

export function createYouTubeResourcesHandler(
  ports: YouTubeResourcesPorts,
): (req: Request) => Promise<Response>;
```

Flow inside the returned function, in this order:
1. `OPTIONS` returns `new Response(null, { status: 204, headers: restrictedCorsHeaders(req) })`.
2. `const requestId = ports.ids.requestId()`.
3. Method other than `POST`: refuse `method_not_allowed`.
4. `ports.auth.authenticate(req)` in `try`; on throw refuse `unauthorized`.
5. `await req.json()` in `try`; on throw refuse `invalid_request`.
6. `CapabilitiesRequest.safeParse(body)`; on failure refuse `invalid_request`.
7. `ports.accounts.load({ accountId, userId })` in `try`; on throw refuse `internal_error`.
8. `null` account, or `account.userId !== userId`: refuse `not_found`.
9. Answer 200 with `{ schema_version: YOUTUBE_RESOURCES_SCHEMA_VERSION, request_id, freshness: { fetched_at: ports.clock.now().toISOString(), source: "database" }, data: deriveYouTubeCapabilities({ id, channelId, channelTitle, authProvider, needsReauth, hasAccessToken: Boolean(account.accessToken), hasRefreshToken: Boolean(account.refreshToken), accountMetadata }) }`.

`refuse(req, entry, extra?)` builds `{ error: entry.code, request_id: entry.requestId, ...extra }` with status `YOUTUBE_RESOURCE_ERROR_STATUS[entry.code]` and the restricted CORS headers plus `Content-Type: application/json`. It calls `ports.log.refusal(entry)` inside `try`/`catch` for every code except `method_not_allowed` and `unauthorized` (those two are not written, so an anonymous caller cannot fill the log table); a failed log write only does `console.warn({ event: "youtube_resources_refusal_log_failed", code: entry.code })` and never changes the response.

- [ ] **Step 4: verify.** `deno test` on the directory (16 passed) and `deno check` on `handler.ts` and `handler.test.ts`.

- [ ] **Step 5: commit.**

```bash
git add supabase/functions/youtube-resources/handler.ts supabase/functions/youtube-resources/handler.test.ts
git commit -m "feat(youtube): owner-bound capabilities operation" -- supabase/functions/youtube-resources/handler.ts supabase/functions/youtube-resources/handler.test.ts
```

## Task 2a-4: the adapter, the CI step and the function table

**Tier:** Heavy (service-role wiring).

**Files:** create `supabase/functions/youtube-resources/index.ts`; modify `.github/workflows/ci.yml`; modify `CLAUDE.md` (one table row).

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** `index.ts` contains wiring only, no business rule. The service-role client never leaves this file. Never pass a body `user_id` to `authenticateCaller`. The account query must filter on the caller, on `platform = 'youtube'` and on `is_active = true`. Rows from the untyped client are `unknown`: narrow them, do not cast to `any`. `system_logs.category` only accepts `auth`, `edge`, `database`, `token`, `post`, `system`, `ai`, `scheduler`, `webhook`, `payment`, `media` (migration `20260928120000_store_events_worker.sql`): use `edge`. Commit only the three files.

**You depend on:**

```ts
// ../_shared/auth-helper.ts (on main). A service-role bearer without a body user id throws,
// so calling it with one argument refuses service-role callers.
export async function authenticateCaller(req: Request, bodyUserId?: string | null): Promise<{ userId: string; isServiceRole: boolean }>;

// ./handler.ts (task 2a-3)
export function createYouTubeResourcesHandler(ports: YouTubeResourcesPorts): (req: Request) => Promise<Response>;
```

- [ ] **Step 1: write `index.ts`.** There is no unit test for the adapter; its proof is `deno check` plus the handler suite. Shape:

```ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  createYouTubeResourcesHandler,
  type YouTubeResourceAccount,
  type YouTubeResourcesPorts,
} from "./handler.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const ACCOUNT_COLUMNS =
  "id, user_id, platform_user_id, platform_username, auth_provider, needs_reauth, access_token, refresh_token, token_expires_at, account_metadata";

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toAccount(row: unknown): YouTubeResourceAccount | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const id = text(record.id);
  const userId = text(record.user_id);
  if (!id || !userId) return null;
  return {
    id,
    userId,
    channelId: text(record.platform_user_id),
    channelTitle: text(record.platform_username),
    authProvider: text(record.auth_provider),
    needsReauth: record.needs_reauth === true,
    accessToken: text(record.access_token),
    refreshToken: text(record.refresh_token),
    tokenExpiresAt: text(record.token_expires_at),
    accountMetadata: record.account_metadata ?? null,
  };
}

const ports: YouTubeResourcesPorts = {
  auth: {
    authenticate: async (req) => ({ userId: (await authenticateCaller(req)).userId }),
  },
  accounts: {
    load: async ({ accountId, userId }) => {
      const { data, error } = await admin
        .from("social_accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("id", accountId)
        .eq("user_id", userId)
        .eq("platform", "youtube")
        .eq("is_active", true)
        .maybeSingle();
      if (error) throw new Error("account_read_failed");
      return toAccount(data);
    },
  },
  clock: { now: () => new Date() },
  ids: { requestId: () => crypto.randomUUID() },
  log: {
    refusal: async ({ operation, code, userId, accountId, requestId }) => {
      const { error } = await admin.from("system_logs").insert({
        level: "warn",
        category: "edge",
        source: "youtube-resources",
        message: "YouTube resource request refused",
        user_id: userId,
        metadata: { operation, code, account_id: accountId, request_id: requestId },
      });
      if (error) throw new Error("refusal_log_failed");
    },
  },
};

Deno.serve(createYouTubeResourcesHandler(ports));
```

- [ ] **Step 2: add the CI step.** In `.github/workflows/ci.yml`, directly after the step named `Typecheck and test youtube-oauth`, add a step with the same indentation:

```yaml
      - name: Typecheck and test youtube-resources
        run: |
          set -euo pipefail
          map=".github/deno/process-post-import-map.json"
          deno check --node-modules-dir=none --import-map="${map}" supabase/functions/youtube-resources/index.ts
          deno test --allow-env --allow-read --node-modules-dir=none --import-map="${map}" supabase/functions/youtube-resources/
```

- [ ] **Step 3: document the function.** In `CLAUDE.md`, section "Edge Functions", add one row at the end of the table:

```markdown
| `youtube-resources` | Owner-bound YouTube capability contract (`capabilities` operation); spec `docs/specs/2026-11-20-youtube-stage2-resource-browse.md` |
```

- [ ] **Step 4: verify.**

```bash
deno check --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/youtube-resources/index.ts
deno test --allow-env --allow-read --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/youtube-resources/
git grep -n "eslint-disable\|: any\|as any" -- supabase/functions/youtube-resources/   # must print nothing
git grep -n "authenticateCaller(req)" -- supabase/functions/youtube-resources/index.ts   # exactly one line, one argument
```

- [ ] **Step 5: commit.**

```bash
git add supabase/functions/youtube-resources/index.ts .github/workflows/ci.yml CLAUDE.md
git commit -m "feat(youtube): serve youtube-resources and test it in CI" -- supabase/functions/youtube-resources/index.ts .github/workflows/ci.yml CLAUDE.md
```

## Task 2a-5: pull request for stage 2a (orchestrator)

**Tier:** Heavy (the PR carries the stage's authentication and ownership boundary).

- [ ] Inspect the full diff. Run `clean-code-guard` on the four production files, `test-guard` on the three test files and `docs-guard` on the `CLAUDE.md` row.
- [ ] `git push origin HEAD:T3-CODE/youtube-stage2a-capabilities`. Open a PR to `main` titled `feat(youtube): capability contract endpoint (stage 2a)`. The body states "Tier: HEAVY", lists the production call site (`supabase/functions/youtube-resources/index.ts` serves `createYouTubeResourcesHandler`, which calls `deriveYouTubeCapabilities`), states that no browser calls the endpoint until stage 2c, and ends with the Claude Code attribution line.
- [ ] Merge only on green CI for the exact head commit and after the review rounds of the tier. No migration is involved.
- [ ] After the Dokploy schedule has deployed (about two minutes), verify with an authenticated session: one `capabilities` call for an owned YouTube account answers 200, and one for a random UUID answers 404 `not_found`.

---

# Stage 2b: resource browse backend

Branch (after 2a is merged): `git fetch origin && git checkout --no-track -b T3-CODE/youtube-stage2b-resource-browse origin/main`. Push only with `git push origin HEAD:T3-CODE/youtube-stage2b-resource-browse`.

## Task 2b-1: read client with `getChannel`, and the resource DTOs

**Tier:** Medium (provider adapter behind a fake `fetch`; no auth decision).

**Files:** modify `supabase/functions/youtube-resources/contracts.ts` (append types only); create `supabase/functions/youtube-resources/youtubeReadClient.ts` and `supabase/functions/youtube-resources/youtubeReadClient.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** every provider call has a timeout (`AbortSignal.timeout`). The client returns stable codes only: never Google's `error.message`, never the request URL. It never writes to the database and never changes `account_metadata`. Validate the provider body with Zod; every provider field is optional so a missing field becomes `null`, not a crash. `contracts.ts` stays import-free. No `any`, no `eslint-disable`. Commit only the three files.

**You depend on (on `main`, `supabase/functions/_shared/youtubeApiErrors.ts`):**

```ts
export type YouTubeErrorClass = "scope_missing" | "quota" | "unauthorized" | "not_found" | "forbidden" | "upstream";
export function classifyGoogleError(status: number, body: unknown): YouTubeErrorClass;
```

- [ ] **Step 1: append the DTOs to `contracts.ts`** (below the existing exports, no import):

```ts
export const YOUTUBE_VIDEOS_DEFAULT_PAGE_SIZE = 25;
export const YOUTUBE_VIDEOS_MAX_PAGE_SIZE = 50;

export interface YouTubeChannelDetails {
  id: string;
  title: string;
  description: string;
  custom_url: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  country: string | null;
  privacy_status: string | null;
  statistics: {
    view_count: number | null;
    subscriber_count: number | null;
    subscriber_count_hidden: boolean;
    video_count: number | null;
  };
}

export interface YouTubeVideoListItem {
  id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string | null;
  privacy_status: string | null;
  url: string;
}

export interface YouTubeVideosPage {
  items: YouTubeVideoListItem[];
  next_page_token: string | null;
  total_results: number | null;
}

export interface YouTubeVideoDetails {
  id: string;
  channel_id: string;
  title: string;
  description: string;
  thumbnail_url: string | null;
  published_at: string | null;
  tags: string[];
  category_id: string | null;
  default_language: string | null;
  duration_iso8601: string | null;
  privacy_status: string | null;
  upload_status: string | null;
  made_for_kids: boolean | null;
  statistics: {
    view_count: number | null;
    like_count: number | null;
    comment_count: number | null;
  };
  url: string;
}
```

- [ ] **Step 2: write the failing test** `youtubeReadClient.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createYouTubeReadClient } from "./youtubeReadClient.ts";

const CHANNEL_ID = "UCfixturechannel000000001";

function fakeFetch(status: number, body: unknown) {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    requests.push({
      url: new URL(String(input)),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return Promise.resolve(Response.json(body, { status }));
  };
  return { fetchImpl, requests };
}

function client(fetchImpl: typeof fetch) {
  return createYouTubeReadClient({
    fetchImpl,
    uploadsPlaylistIdFor: (channelId) => `UU${channelId.slice(2)}`,
  });
}

Deno.test("getChannel asks for the caller's own channel and maps the stored one", async () => {
  const token = crypto.randomUUID();
  const { fetchImpl, requests } = fakeFetch(200, {
    items: [{
      id: CHANNEL_ID,
      snippet: {
        title: "Fixture channel",
        description: "About",
        customUrl: "@fixture",
        publishedAt: "2020-01-01T00:00:00Z",
        country: "KW",
        thumbnails: { medium: { url: "https://yt3.example/medium.jpg" } },
      },
      statistics: { viewCount: "1200", subscriberCount: "34", hiddenSubscriberCount: false, videoCount: "7" },
      status: { privacyStatus: "public" },
    }],
  });
  const result = await client(fetchImpl).getChannel(token, { channelId: CHANNEL_ID });

  assertEquals(requests.length, 1);
  assertEquals(requests[0].url.pathname, "/youtube/v3/channels");
  assertEquals(requests[0].url.searchParams.get("mine"), "true");
  assertEquals(requests[0].url.searchParams.get("part"), "snippet,statistics,status");
  assertEquals(requests[0].authorization, `Bearer ${token}`);
  assertEquals(result, {
    ok: true,
    value: {
      id: CHANNEL_ID,
      title: "Fixture channel",
      description: "About",
      custom_url: "@fixture",
      thumbnail_url: "https://yt3.example/medium.jpg",
      published_at: "2020-01-01T00:00:00Z",
      country: "KW",
      privacy_status: "public",
      statistics: { view_count: 1200, subscriber_count: 34, subscriber_count_hidden: false, video_count: 7 },
    },
  });
});

Deno.test("getChannel reports reconnect_required when the grant no longer covers the stored channel", async () => {
  const { fetchImpl } = fakeFetch(200, { items: [{ id: "UCanotherchannel0000000002" }] });
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result, { ok: false, code: "reconnect_required", unauthorized: false });
});

Deno.test("a hidden subscriber count is null, not zero", async () => {
  const { fetchImpl } = fakeFetch(200, {
    items: [{ id: CHANNEL_ID, statistics: { hiddenSubscriberCount: true, subscriberCount: "0" } }],
  });
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result.ok && result.value.statistics, {
    view_count: null,
    subscriber_count: null,
    subscriber_count_hidden: true,
    video_count: null,
  });
});

const GOOGLE_ERRORS: Array<[string, number, unknown, string, boolean]> = [
  ["scope", 403, { error: { message: "secret provider text", errors: [{ reason: "insufficientPermissions" }] } }, "missing_scope", false],
  ["quota", 403, { error: { errors: [{ reason: "quotaExceeded" }] } }, "quota_exceeded", false],
  ["expired token", 401, { error: { errors: [{ reason: "authError" }] } }, "reconnect_required", true],
  ["not found", 404, { error: {} }, "not_found", false],
  ["forbidden", 403, { error: { errors: [{ reason: "forbidden" }] } }, "not_found", false],
  ["server error", 503, null, "upstream_unavailable", false],
];

for (const [name, status, body, code, unauthorized] of GOOGLE_ERRORS) {
  Deno.test(`a Google ${name} answer becomes ${code} without provider text`, async () => {
    const { fetchImpl } = fakeFetch(status, body);
    const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
    assertEquals(result, { ok: false, code, unauthorized });
    assertEquals(JSON.stringify(result).includes("secret provider text"), false);
  });
}

Deno.test("a network failure is upstream_unavailable", async () => {
  const fetchImpl: typeof fetch = () => Promise.reject(new TypeError("connection refused to https://internal"));
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result, { ok: false, code: "upstream_unavailable", unauthorized: false });
});

Deno.test("a body that is not the documented shape is upstream_unavailable, not an empty channel", async () => {
  const { fetchImpl } = fakeFetch(200, { items: "not-an-array" });
  const result = await client(fetchImpl).getChannel("t", { channelId: CHANNEL_ID });
  assertEquals(result, { ok: false, code: "upstream_unavailable", unauthorized: false });
});
```

- [ ] **Step 3: run and confirm it fails** because `./youtubeReadClient.ts` does not exist.

- [ ] **Step 4: implement `youtubeReadClient.ts`.** Shape:

```ts
import { z } from "npm:zod@3.23.8";
import { classifyGoogleError, type YouTubeErrorClass } from "../_shared/youtubeApiErrors.ts";
import type { YouTubeChannelDetails, YouTubeResourceErrorCode } from "./contracts.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_READ_TIMEOUT_MS = 15_000;

export type YouTubeReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: YouTubeResourceErrorCode; unauthorized: boolean };

export interface YouTubeReadClient {
  getChannel(accessToken: string, input: { channelId: string }): Promise<YouTubeReadResult<YouTubeChannelDetails>>;
}

export interface YouTubeReadClientOptions {
  fetchImpl: typeof fetch;
  uploadsPlaylistIdFor(channelId: string): string;
  timeoutMs?: number;
}

export function createYouTubeReadClient(options: YouTubeReadClientOptions): YouTubeReadClient;
```

Inside:
- `const CODE_BY_CLASS: Record<YouTubeErrorClass, YouTubeResourceErrorCode> = { scope_missing: "missing_scope", quota: "quota_exceeded", unauthorized: "reconnect_required", not_found: "not_found", forbidden: "not_found", upstream: "upstream_unavailable" };`
- `async function send(path: string, query: Record<string, string>, accessToken: string): Promise<{ ok: true; body: unknown } | { ok: false; code: YouTubeResourceErrorCode; unauthorized: boolean; status: number }>`: `fetchImpl(`${DATA_API}/${path}?${new URLSearchParams(query)}`, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(options.timeoutMs ?? YOUTUBE_READ_TIMEOUT_MS) })` inside `try`; on throw return `upstream_unavailable` with `status: 0`. Read the body with `await response.json().catch(() => null)` typed as `unknown`. On `response.ok` return the body. Otherwise `const kind = classifyGoogleError(response.status, body)` and return `{ ok: false, code: CODE_BY_CLASS[kind], unauthorized: kind === "unauthorized", status: response.status }`.
- Helpers: `count(value: unknown): number | null` (accepts a string or number, returns a finite number or `null`) and `thumbnail(thumbnails): string | null` (first of `medium.url`, `high.url`, `default.url`).
- `getChannel`: query `{ part: "snippet,statistics,status", mine: "true", maxResults: "50" }`. Validate with a Zod schema whose `items` is `z.array(...)` and whose inner fields are all optional; a failed parse returns `{ ok: false, code: "upstream_unavailable", unauthorized: false }`. Pick the item whose `id === input.channelId`; none returns `{ ok: false, code: "reconnect_required", unauthorized: false }`. `subscriber_count` is `null` when `hiddenSubscriberCount === true`.
- Public failures drop the internal `status` field: return `{ ok: false, code, unauthorized }`.

- [ ] **Step 5: verify.** `deno test` on the directory and `deno check` on the three files. `git grep -n "^import" -- supabase/functions/youtube-resources/contracts.ts` prints nothing.

- [ ] **Step 6: commit.**

```bash
git add supabase/functions/youtube-resources/contracts.ts supabase/functions/youtube-resources/youtubeReadClient.ts supabase/functions/youtube-resources/youtubeReadClient.test.ts
git commit -m "feat(youtube): typed native read client with channel details" -- supabase/functions/youtube-resources/contracts.ts supabase/functions/youtube-resources/youtubeReadClient.ts supabase/functions/youtube-resources/youtubeReadClient.test.ts
```

## Task 2b-2: read client `listUploads` and `getVideo`

**Tier:** Medium (provider adapter behind a fake `fetch`; the channel-ownership check of a video lives here, so review it with care).

**Files:** modify `supabase/functions/youtube-resources/youtubeReadClient.ts` and `supabase/functions/youtube-resources/youtubeReadClient.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** the playlist ID is computed inside the client from `options.uploadsPlaylistIdFor(input.channelId)`; no caller passes a playlist ID. A video whose `snippet.channelId` differs from `input.channelId` is `not_found`, exactly like an absent video. Stable codes only, no provider text. No `any`, no `eslint-disable`. Commit only the two files.

**You depend on (same file, from task 2b-1):** `createYouTubeReadClient`, `YouTubeReadResult<T>`, the internal `send`, `count`, `thumbnail`, and the test helpers `fakeFetch` and `client`. From `./contracts.ts`: `YouTubeVideosPage`, `YouTubeVideoDetails`.

- [ ] **Step 1: add the failing tests** to `youtubeReadClient.test.ts` (append; keep the existing ones):

```ts
Deno.test("listUploads pages the channel's own uploads playlist", async () => {
  const { fetchImpl, requests } = fakeFetch(200, {
    nextPageToken: "CAUQAA",
    pageInfo: { totalResults: 60 },
    items: [
      {
        snippet: {
          title: "First video",
          publishedAt: "2026-11-01T00:00:00Z",
          resourceId: { videoId: "videoAAAAAAA" },
          thumbnails: { default: { url: "https://i.ytimg.example/a.jpg" } },
        },
        contentDetails: { videoId: "videoAAAAAAA", videoPublishedAt: "2026-10-31T00:00:00Z" },
        status: { privacyStatus: "unlisted" },
      },
      { snippet: { title: "Item without a video id" } },
    ],
  });
  const result = await client(fetchImpl).listUploads("t", {
    channelId: CHANNEL_ID,
    pageSize: 25,
    pageToken: "CAoQAA",
  });

  assertEquals(requests[0].url.pathname, "/youtube/v3/playlistItems");
  assertEquals(requests[0].url.searchParams.get("playlistId"), `UU${CHANNEL_ID.slice(2)}`);
  assertEquals(requests[0].url.searchParams.get("maxResults"), "25");
  assertEquals(requests[0].url.searchParams.get("pageToken"), "CAoQAA");
  assertEquals(requests[0].url.searchParams.get("part"), "snippet,contentDetails,status");
  assertEquals(result, {
    ok: true,
    value: {
      items: [{
        id: "videoAAAAAAA",
        title: "First video",
        thumbnail_url: "https://i.ytimg.example/a.jpg",
        published_at: "2026-10-31T00:00:00Z",
        privacy_status: "unlisted",
        url: "https://www.youtube.com/watch?v=videoAAAAAAA",
      }],
      next_page_token: "CAUQAA",
      total_results: 60,
    },
  });
});

Deno.test("the first page sends no pageToken and the last page has none to give", async () => {
  const { fetchImpl, requests } = fakeFetch(200, { items: [] });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 50 });
  assertEquals(requests[0].url.searchParams.has("pageToken"), false);
  assertEquals(result, { ok: true, value: { items: [], next_page_token: null, total_results: null } });
});

Deno.test("a 400 on a request that carried a page token is invalid_cursor", async () => {
  const { fetchImpl } = fakeFetch(400, { error: { errors: [{ reason: "invalidPageToken" }] } });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25, pageToken: "bad" });
  assertEquals(result, { ok: false, code: "invalid_cursor", unauthorized: false });
});

Deno.test("a 400 without a page token is upstream_unavailable", async () => {
  const { fetchImpl } = fakeFetch(400, { error: {} });
  const result = await client(fetchImpl).listUploads("t", { channelId: CHANNEL_ID, pageSize: 25 });
  assertEquals(result, { ok: false, code: "upstream_unavailable", unauthorized: false });
});

Deno.test("getVideo returns the details of a video of the bound channel", async () => {
  const { fetchImpl, requests } = fakeFetch(200, {
    items: [{
      id: "videoAAAAAAA",
      snippet: {
        channelId: CHANNEL_ID,
        title: "First video",
        description: "Body",
        publishedAt: "2026-10-31T00:00:00Z",
        tags: ["one", "two"],
        categoryId: "22",
        defaultLanguage: "ar",
        thumbnails: { high: { url: "https://i.ytimg.example/high.jpg" } },
      },
      contentDetails: { duration: "PT4M13S" },
      statistics: { viewCount: "10", likeCount: "2", commentCount: "1" },
      status: { privacyStatus: "public", uploadStatus: "processed", madeForKids: false },
    }],
  });
  const result = await client(fetchImpl).getVideo("t", { channelId: CHANNEL_ID, videoId: "videoAAAAAAA" });

  assertEquals(requests[0].url.pathname, "/youtube/v3/videos");
  assertEquals(requests[0].url.searchParams.get("id"), "videoAAAAAAA");
  assertEquals(result, {
    ok: true,
    value: {
      id: "videoAAAAAAA",
      channel_id: CHANNEL_ID,
      title: "First video",
      description: "Body",
      thumbnail_url: "https://i.ytimg.example/high.jpg",
      published_at: "2026-10-31T00:00:00Z",
      tags: ["one", "two"],
      category_id: "22",
      default_language: "ar",
      duration_iso8601: "PT4M13S",
      privacy_status: "public",
      upload_status: "processed",
      made_for_kids: false,
      statistics: { view_count: 10, like_count: 2, comment_count: 1 },
      url: "https://www.youtube.com/watch?v=videoAAAAAAA",
    },
  });
});

Deno.test("a video of another channel and an absent video are the same not_found", async () => {
  const foreign = fakeFetch(200, { items: [{ id: "videoBBBBBBB", snippet: { channelId: "UCanotherchannel0000000002" } }] });
  const absent = fakeFetch(200, { items: [] });
  const input = { channelId: CHANNEL_ID, videoId: "videoBBBBBBB" };
  assertEquals(
    await client(foreign.fetchImpl).getVideo("t", input),
    await client(absent.fetchImpl).getVideo("t", input),
  );
  assertEquals(await client(absent.fetchImpl).getVideo("t", input), {
    ok: false,
    code: "not_found",
    unauthorized: false,
  });
});
```

- [ ] **Step 2: run and confirm they fail** because `listUploads` and `getVideo` are not functions.

- [ ] **Step 3: implement.** Extend the interface and the factory:

```ts
export interface YouTubeReadClient {
  getChannel(accessToken: string, input: { channelId: string }): Promise<YouTubeReadResult<YouTubeChannelDetails>>;
  listUploads(
    accessToken: string,
    input: { channelId: string; pageSize: number; pageToken?: string },
  ): Promise<YouTubeReadResult<YouTubeVideosPage>>;
  getVideo(
    accessToken: string,
    input: { channelId: string; videoId: string },
  ): Promise<YouTubeReadResult<YouTubeVideoDetails>>;
}
```

- `listUploads`: query `{ part: "snippet,contentDetails,status", playlistId: options.uploadsPlaylistIdFor(input.channelId), maxResults: String(input.pageSize) }` plus `pageToken` only when it is given. On a failure with `status === 400` and a `pageToken`, the code is `invalid_cursor`. Item ID is `contentDetails.videoId ?? snippet.resourceId.videoId`; items without one are dropped. `published_at` is `contentDetails.videoPublishedAt ?? snippet.publishedAt ?? null`. `next_page_token` is `nextPageToken ?? null`. `total_results` is `count(pageInfo.totalResults)`. `url` is `https://www.youtube.com/watch?v=${id}`.
- `getVideo`: query `{ part: "snippet,contentDetails,statistics,status", id: input.videoId }`. Take `items[0]`. No item, or `snippet.channelId !== input.channelId`, returns `{ ok: false, code: "not_found", unauthorized: false }`. `tags` defaults to `[]`.
- Both validate the body with Zod and return `upstream_unavailable` on a failed parse.

- [ ] **Step 4: verify.** `deno test` on the directory, `deno check` on both files.

- [ ] **Step 5: commit.**

```bash
git add supabase/functions/youtube-resources/youtubeReadClient.ts supabase/functions/youtube-resources/youtubeReadClient.test.ts
git commit -m "feat(youtube): read client lists uploads and reads video details" -- supabase/functions/youtube-resources/youtubeReadClient.ts supabase/functions/youtube-resources/youtubeReadClient.test.ts
```

## Task 2b-3: handler admission, token handling and the `channel` operation

**Tier:** Heavy (OAuth token use, ownership, rate limit).

**Files:** modify `supabase/functions/youtube-resources/handler.ts` and `supabase/functions/youtube-resources/handler.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** a refused request makes zero token reads and zero provider calls; the tests prove it with counters. The handler never calls Google or the token endpoint itself: it uses `ports.tokens` and `ports.youtube`. At most one repeat, and only after a 401 on a token this request did not mint. A Composio row never reaches `ports.youtube`. No token in any response. No `any`, no `eslint-disable`. Keep every existing test green. Commit only the two files.

**You depend on:**

```ts
// ./youtubeReadClient.ts (tasks 2b-1, 2b-2)
export type YouTubeReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: YouTubeResourceErrorCode; unauthorized: boolean };
export interface YouTubeReadClient {
  getChannel(accessToken: string, input: { channelId: string }): Promise<YouTubeReadResult<YouTubeChannelDetails>>;
  listUploads(accessToken: string, input: { channelId: string; pageSize: number; pageToken?: string }): Promise<YouTubeReadResult<YouTubeVideosPage>>;
  getVideo(accessToken: string, input: { channelId: string; videoId: string }): Promise<YouTubeReadResult<YouTubeVideoDetails>>;
}

// ./capabilities.ts: deriveYouTubeCapabilities(...).capabilities.browse is
// { state: "available" } | { state: "unknown" } | { state: "unavailable"; reason: "reconnect_required" | "missing_scope" | "provider_unsupported" }
```

- [ ] **Step 1: extend the test fixture and add the failing tests.** In `handler.test.ts`, add to the `fixture` overrides `tokenResults?: YouTubeTokenResult[]`, `channelResults?: Array<YouTubeReadResult<YouTubeChannelDetails>>` and `rateLimit?: { allowed: boolean; retryAfterSeconds: number }`; add `tokens: 0, channel: 0, rateLimit: 0` to `calls`; record `forceFlags: boolean[]`; and add these ports (import `YouTubeTokenResult` from `./handler.ts`, `YouTubeReadResult` from `./youtubeReadClient.ts`, `YouTubeChannelDetails` from `./contracts.ts`):

```ts
    tokens: {
      get: (_account, options) => {
        forceFlags.push(options.force);
        const queued = overrides.tokenResults?.[calls.tokens];
        calls.tokens++;
        return Promise.resolve(queued ?? { ok: true, accessToken, minted: false });
      },
    },
    youtube: {
      getChannel: () => {
        const queued = overrides.channelResults?.[calls.channel];
        calls.channel++;
        return Promise.resolve(queued ?? { ok: true, value: CHANNEL });
      },
      listUploads: () => Promise.reject(new Error("not used in this test")),
      getVideo: () => Promise.reject(new Error("not used in this test")),
    },
    rateLimit: {
      check: () => {
        calls.rateLimit++;
        return Promise.resolve(overrides.rateLimit ?? { allowed: true, retryAfterSeconds: 0 });
      },
    },
```

with this constant near the top of the file:

```ts
const CHANNEL: YouTubeChannelDetails = {
  id: CHANNEL_ID,
  title: "Fixture channel",
  description: "",
  custom_url: null,
  thumbnail_url: null,
  published_at: null,
  country: null,
  privacy_status: "public",
  statistics: { view_count: 1, subscriber_count: 1, subscriber_count_hidden: false, video_count: 1 },
};
```

Return `forceFlags` from `fixture`. Then append:

```ts
const CHANNEL_REQUEST = { operation: "channel", account_id: ACCOUNT_ID };

Deno.test("channel returns the provider answer with provider freshness and no credential", async () => {
  const { handler, accessToken, calls } = fixture();
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 200);
  const text = await response.text();
  assertEquals(text.includes(accessToken), false);
  const body = JSON.parse(text);
  assertEquals(body.freshness.source, "provider");
  assertEquals(body.data, CHANNEL);
  assertEquals(calls, { auth: 1, load: 1, tokens: 1, channel: 1, rateLimit: 1 });
});

Deno.test("a foreign account never reaches the token store or the provider", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({ operation: "channel", account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(response.status, 404);
  assertEquals([calls.tokens, calls.channel, calls.rateLimit], [0, 0, 0]);
});

Deno.test("a composio account is provider_unsupported and never reaches the native client", async () => {
  const { handler, calls } = fixture({ account: { authProvider: "composio", accountMetadata: {} } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "provider_unsupported");
  assertEquals([calls.tokens, calls.channel], [0, 0]);
});

Deno.test("an account flagged for reauth is reconnect_required before any provider call", async () => {
  const { handler, calls } = fixture({ account: { needsReauth: true } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "reconnect_required");
  assertEquals([calls.tokens, calls.channel], [0, 0]);
});

Deno.test("recorded scopes without readonly are missing_scope before any provider call", async () => {
  const { handler, calls } = fixture({
    account: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload] } },
  });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 403);
  assertEquals((await response.json()).error, "missing_scope");
  assertEquals([calls.tokens, calls.channel], [0, 0]);
});

Deno.test("an account whose scopes were never recorded is allowed to try", async () => {
  const { handler, calls } = fixture({ account: { accountMetadata: {} } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 200);
  assertEquals(calls.channel, 1);
});

Deno.test("the per-user limit answers rate_limited with a retry hint and spends no quota", async () => {
  const { handler, calls } = fixture({ rateLimit: { allowed: false, retryAfterSeconds: 120 } });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 429);
  assertEquals(await response.json(), {
    error: "rate_limited",
    request_id: REQUEST_ID,
    retry_after_seconds: 120,
  });
  assertEquals([calls.tokens, calls.channel], [0, 0]);
});

Deno.test("a 401 on a stored token forces one refresh and one repeat", async () => {
  const { handler, calls, forceFlags } = fixture({
    channelResults: [{ ok: false, code: "reconnect_required", unauthorized: true }],
  });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 200);
  assertEquals(forceFlags, [false, true]);
  assertEquals(calls.channel, 2);
});

Deno.test("a second 401 is reconnect_required and is not repeated again", async () => {
  const denied = { ok: false as const, code: "reconnect_required" as const, unauthorized: true };
  const { handler, calls } = fixture({ channelResults: [denied, denied] });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals((await response.json()).error, "reconnect_required");
  assertEquals(calls.channel, 2);
});

Deno.test("a 401 on a token this request just minted is not repeated", async () => {
  const fresh = crypto.randomUUID();
  const { handler, calls } = fixture({
    tokenResults: [{ ok: true, accessToken: fresh, minted: true }],
    channelResults: [{ ok: false, code: "reconnect_required", unauthorized: true }],
  });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 409);
  assertEquals(calls.channel, 1);
});

Deno.test("a token that cannot be obtained maps to its stable code", async () => {
  const { handler, calls } = fixture({ tokenResults: [{ ok: false, code: "upstream_unavailable" }] });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error, "upstream_unavailable");
  assertEquals(calls.channel, 0);
});

Deno.test("a provider quota refusal is quota_exceeded", async () => {
  const { handler } = fixture({
    channelResults: [{ ok: false, code: "quota_exceeded", unauthorized: false }],
  });
  const response = await handler(request(CHANNEL_REQUEST));
  assertEquals(response.status, 429);
  assertEquals((await response.json()).error, "quota_exceeded");
});
```

- [ ] **Step 2: run and confirm the new tests fail** (the `channel` operation is refused as `invalid_request` and the new port types do not exist).

- [ ] **Step 3: implement in `handler.ts`.**

Add the types and ports:

```ts
export type YouTubeTokenResult =
  | { ok: true; accessToken: string; minted: boolean }
  | { ok: false; code: "reconnect_required" | "upstream_unavailable" };

// add to YouTubeResourcesPorts:
  tokens: {
    get(account: YouTubeResourceAccount, options: { force: boolean }): Promise<YouTubeTokenResult>;
  };
  youtube: YouTubeReadClient;
  rateLimit: { check(userId: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> };
```

Replace the single schema with a discriminated union:

```ts
const AccountId = z.string().uuid();
const CapabilitiesRequest = z.object({ operation: z.literal("capabilities"), account_id: AccountId }).strict();
const ChannelRequest = z.object({ operation: z.literal("channel"), account_id: AccountId }).strict();
const RequestSchema = z.discriminatedUnion("operation", [CapabilitiesRequest, ChannelRequest]);
```

Add two helpers inside `createYouTubeResourcesHandler`:

```ts
// Returns the refusal code, or null when the provider may be called.
async function admit(
  account: YouTubeResourceAccount,
  userId: string,
): Promise<{ code: YouTubeResourceErrorCode; retryAfterSeconds?: number } | null>;

// One read, with the single forced-refresh repeat after a 401.
async function providerRead<T>(
  account: YouTubeResourceAccount,
  read: (accessToken: string) => Promise<YouTubeReadResult<T>>,
): Promise<YouTubeReadResult<T>>;
```

`admit`, in order: `account.authProvider === "composio"` gives `provider_unsupported`; `browse = deriveYouTubeCapabilities(...).capabilities.browse`, and `browse.state === "unavailable"` gives `browse.reason` (the reason names equal the error codes); `account.channelId === null` gives `reconnect_required`; `ports.rateLimit.check(userId)` not allowed gives `rate_limited` with `retryAfterSeconds`; otherwise `null`.

`providerRead`: `token = await ports.tokens.get(account, { force: false })`; not ok returns `{ ok: false, code: token.code, unauthorized: false }`; `result = await read(token.accessToken)`; when `!result.ok && result.unauthorized && !token.minted`, get a token with `{ force: true }` (not ok returns its code) and call `read` once more; return the result.

`channel` operation after the account load: `admit` refusal is refused with its code (and `{ retry_after_seconds }` for `rate_limited`); then `providerRead(account, (accessToken) => ports.youtube.getChannel(accessToken, { channelId }))`; a failure is refused with `result.code`; success answers 200 with `freshness.source = "provider"` and `data: result.value`. Wrap `admit` and `providerRead` in one `try`/`catch` that refuses `internal_error`.

- [ ] **Step 4: verify.** `deno test` on the directory (all earlier tests still pass) and `deno check` on both files.

- [ ] **Step 5: commit.**

```bash
git add supabase/functions/youtube-resources/handler.ts supabase/functions/youtube-resources/handler.test.ts
git commit -m "feat(youtube): owner-bound channel details operation" -- supabase/functions/youtube-resources/handler.ts supabase/functions/youtube-resources/handler.test.ts
```

## Task 2b-4: the `videos` operation

**Tier:** Heavy (same boundary as 2b-3).

**Files:** modify `supabase/functions/youtube-resources/handler.ts` and `supabase/functions/youtube-resources/handler.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** reuse `admit` and `providerRead` from task 2b-3; do not write a second admission path. The browser never sends a playlist or channel ID. `page_size` is capped at 50 by the schema. No `any`, no `eslint-disable`. Commit only the two files.

**You depend on (same file, task 2b-3):**

```ts
async function admit(account: YouTubeResourceAccount, userId: string): Promise<{ code: YouTubeResourceErrorCode; retryAfterSeconds?: number } | null>;
async function providerRead<T>(account: YouTubeResourceAccount, read: (accessToken: string) => Promise<YouTubeReadResult<T>>): Promise<YouTubeReadResult<T>>;
// ports.youtube.listUploads(accessToken, { channelId, pageSize, pageToken? }): Promise<YouTubeReadResult<YouTubeVideosPage>>
// ./contracts.ts: YOUTUBE_VIDEOS_DEFAULT_PAGE_SIZE = 25, YOUTUBE_VIDEOS_MAX_PAGE_SIZE = 50
```

- [ ] **Step 1: add the failing tests.** In the `fixture` of `handler.test.ts`, add `calls.uploads` (start 0), an array `uploadInputs: Array<{ channelId: string; pageSize: number; pageToken?: string }>`, an override `uploadResults?: Array<YouTubeReadResult<YouTubeVideosPage>>`, and replace the `listUploads` stub with:

```ts
      listUploads: (_token, input) => {
        uploadInputs.push(input);
        const queued = overrides.uploadResults?.[calls.uploads];
        calls.uploads++;
        return Promise.resolve(queued ?? { ok: true, value: pageOf(25, "CAUQAA", 60) });
      },
```

with this helper near the top of the file:

```ts
function pageOf(size: number, nextPageToken: string | null, total: number): YouTubeVideosPage {
  return {
    items: Array.from({ length: size }, (_, index) => ({
      id: `video${String(index).padStart(6, "0")}`,
      title: `Video ${index}`,
      thumbnail_url: null,
      published_at: null,
      privacy_status: "public",
      url: `https://www.youtube.com/watch?v=video${String(index).padStart(6, "0")}`,
    })),
    next_page_token: nextPageToken,
    total_results: total,
  };
}
```

Return `uploadInputs` from `fixture`. The earlier test that compares the whole `calls` object must be updated to include `uploads: 0`. Then append:

```ts
Deno.test("videos defaults to 25 per page for the stored channel", async () => {
  const { handler, uploadInputs } = fixture();
  const response = await handler(request({ operation: "videos", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.data.items.length, 25);
  assertEquals(body.data.next_page_token, "CAUQAA");
  assertEquals(uploadInputs, [{ channelId: CHANNEL_ID, pageSize: 25 }]);
});

Deno.test("sixty uploads are reachable in three pages", async () => {
  const { handler, uploadInputs } = fixture({
    uploadResults: [
      { ok: true, value: pageOf(25, "PAGE2", 60) },
      { ok: true, value: pageOf(25, "PAGE3", 60) },
      { ok: true, value: pageOf(10, null, 60) },
    ],
  });
  let token: string | null = null;
  let total = 0;
  for (let page = 0; page < 3; page++) {
    const response = await handler(request({
      operation: "videos",
      account_id: ACCOUNT_ID,
      ...(token ? { page_token: token } : {}),
    }));
    const body = await response.json();
    total += body.data.items.length;
    token = body.data.next_page_token;
  }
  assertEquals(total, 60);
  assertEquals(token, null);
  assertEquals(uploadInputs.map((input) => input.pageToken), [undefined, "PAGE2", "PAGE3"]);
});

Deno.test("a page size above fifty and a malformed token are refused before any provider call", async () => {
  const { handler, calls } = fixture();
  const tooLarge = await handler(request({ operation: "videos", account_id: ACCOUNT_ID, page_size: 51 }));
  const badToken = await handler(request({ operation: "videos", account_id: ACCOUNT_ID, page_token: "has space" }));
  assertEquals([tooLarge.status, badToken.status], [400, 400]);
  assertEquals([calls.load, calls.uploads], [0, 0]);
});

Deno.test("a cursor Google rejects is invalid_cursor", async () => {
  const { handler } = fixture({
    uploadResults: [{ ok: false, code: "invalid_cursor", unauthorized: false }],
  });
  const response = await handler(request({ operation: "videos", account_id: ACCOUNT_ID, page_token: "STALE" }));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, "invalid_cursor");
});

Deno.test("a failed listing is an error, never an empty page", async () => {
  const { handler } = fixture({
    uploadResults: [{ ok: false, code: "upstream_unavailable", unauthorized: false }],
  });
  const response = await handler(request({ operation: "videos", account_id: ACCOUNT_ID }));
  assertEquals(response.status, 502);
  assertEquals("data" in (await response.json()), false);
});
```

- [ ] **Step 2: run and confirm they fail** (`videos` is refused as `invalid_request`).

- [ ] **Step 3: implement.** Add to the union:

```ts
const VideosRequest = z.object({
  operation: z.literal("videos"),
  account_id: AccountId,
  page_size: z.number().int().min(1).max(YOUTUBE_VIDEOS_MAX_PAGE_SIZE).optional(),
  page_token: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
}).strict();
```

After the account load and `admit`: `providerRead(account, (accessToken) => ports.youtube.listUploads(accessToken, { channelId, pageSize: input.page_size ?? YOUTUBE_VIDEOS_DEFAULT_PAGE_SIZE, ...(input.page_token ? { pageToken: input.page_token } : {}) }))`. Failure is refused with `result.code`; success answers 200 with `freshness.source = "provider"`.

- [ ] **Step 4: verify.** `deno test` on the directory, `deno check` on both files.

- [ ] **Step 5: commit.**

```bash
git add supabase/functions/youtube-resources/handler.ts supabase/functions/youtube-resources/handler.test.ts
git commit -m "feat(youtube): paginated uploads operation" -- supabase/functions/youtube-resources/handler.ts supabase/functions/youtube-resources/handler.test.ts
```

## Task 2b-5: the `video` operation

**Tier:** Heavy (same boundary as 2b-3).

**Files:** modify `supabase/functions/youtube-resources/handler.ts` and `supabase/functions/youtube-resources/handler.test.ts`; create `supabase/functions/youtube-resources/requestExamples.fixture.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** reuse `admit` and `providerRead`. The fixture file has no `import` and no Deno API, because a Vitest test imports it later. The handler passes the stored `channelId` to `ports.youtube.getVideo`, which refuses videos of another channel as `not_found`; the handler must not add a second, different answer for that case. No `any`, no `eslint-disable`. Commit only the three files.

**You depend on (same file, already written):**

```ts
// Returns the refusal code, or null when the provider may be called.
async function admit(account: YouTubeResourceAccount, userId: string): Promise<{ code: YouTubeResourceErrorCode; retryAfterSeconds?: number } | null>;
// One read, with the single forced-refresh repeat after a 401.
async function providerRead<T>(account: YouTubeResourceAccount, read: (accessToken: string) => Promise<YouTubeReadResult<T>>): Promise<YouTubeReadResult<T>>;
// ports.youtube.getVideo(accessToken, { channelId, videoId }): Promise<YouTubeReadResult<YouTubeVideoDetails>>
// YouTubeReadResult<T> = { ok: true; value: T } | { ok: false; code: YouTubeResourceErrorCode; unauthorized: boolean }
```

- [ ] **Step 1: add the failing tests.** In `fixture`, add `calls.video` (start 0), `videoInputs: Array<{ channelId: string; videoId: string }>`, an override `videoResults?: Array<YouTubeReadResult<YouTubeVideoDetails>>`, and replace the `getVideo` stub with one that records the input and answers `queued ?? { ok: true, value: VIDEO }`, where:

```ts
const VIDEO: YouTubeVideoDetails = {
  id: "videoAAAAAAA",
  channel_id: CHANNEL_ID,
  title: "First video",
  description: "",
  thumbnail_url: null,
  published_at: null,
  tags: [],
  category_id: null,
  default_language: null,
  duration_iso8601: "PT1M",
  privacy_status: "public",
  upload_status: "processed",
  made_for_kids: false,
  statistics: { view_count: 1, like_count: 0, comment_count: 0 },
  url: "https://www.youtube.com/watch?v=videoAAAAAAA",
};
```

Update any earlier test that compares the whole `calls` object. Then append:

```ts
const VIDEO_REQUEST = { operation: "video", account_id: ACCOUNT_ID, video_id: "videoAAAAAAA" };

Deno.test("video reads the details against the stored channel", async () => {
  const { handler, videoInputs } = fixture();
  const response = await handler(request(VIDEO_REQUEST));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).data, VIDEO);
  assertEquals(videoInputs, [{ channelId: CHANNEL_ID, videoId: "videoAAAAAAA" }]);
});

Deno.test("a video the provider layer rejects as foreign is the same 404 as an unknown account", async () => {
  const { handler } = fixture({
    videoResults: [{ ok: false, code: "not_found", unauthorized: false }],
  });
  const foreignVideo = await handler(request(VIDEO_REQUEST));
  const foreignAccount = await handler(request({ ...VIDEO_REQUEST, account_id: FOREIGN_ACCOUNT_ID }));
  assertEquals(foreignVideo.status, 404);
  assertEquals(await foreignVideo.text(), await foreignAccount.text());
});

Deno.test("a malformed video id is refused before any account read", async () => {
  const { handler, calls } = fixture();
  const response = await handler(request({ ...VIDEO_REQUEST, video_id: "../channels?mine=true" }));
  assertEquals(response.status, 400);
  assertEquals([calls.load, calls.video], [0, 0]);
});
```

Create the shared fixture `requestExamples.fixture.ts` (the gateway test of stage 2c sends these exact bodies, which is what ties the browser side to this handler):

```ts
// Request bodies both sides agree on. The Deno handler test proves the handler accepts each one;
// the Vitest gateway test proves the browser sends each one. Keep it import-free.
export const EXAMPLE_ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
export const EXAMPLE_VIDEO_ID = "videoAAAAAAA";
export const EXAMPLE_PAGE_TOKEN = "CAUQAA";

export const YOUTUBE_RESOURCE_REQUEST_EXAMPLES = {
  capabilities: { operation: "capabilities", account_id: EXAMPLE_ACCOUNT_ID },
  channel: { operation: "channel", account_id: EXAMPLE_ACCOUNT_ID },
  videosFirstPage: { operation: "videos", account_id: EXAMPLE_ACCOUNT_ID },
  videosNextPage: { operation: "videos", account_id: EXAMPLE_ACCOUNT_ID, page_token: EXAMPLE_PAGE_TOKEN },
  video: { operation: "video", account_id: EXAMPLE_ACCOUNT_ID, video_id: EXAMPLE_VIDEO_ID },
} as const;
```

And append to `handler.test.ts` (import `YOUTUBE_RESOURCE_REQUEST_EXAMPLES` from `./requestExamples.fixture.ts`; `EXAMPLE_ACCOUNT_ID` equals the test file's `ACCOUNT_ID`):

```ts
for (const [name, body] of Object.entries(YOUTUBE_RESOURCE_REQUEST_EXAMPLES)) {
  Deno.test(`the handler accepts the shared ${name} request example`, async () => {
    const { handler } = fixture();
    const response = await handler(request(body));
    assertEquals(response.status, 200);
  });
}
```

- [ ] **Step 2: run and confirm they fail.**

- [ ] **Step 3: implement.** Add to the union:

```ts
const VideoRequest = z.object({
  operation: z.literal("video"),
  account_id: AccountId,
  video_id: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
}).strict();
```

After the account load and `admit`: `providerRead(account, (accessToken) => ports.youtube.getVideo(accessToken, { channelId, videoId: input.video_id }))`; failure refused with `result.code`; success 200 with `freshness.source = "provider"`.

- [ ] **Step 4: verify.** `deno test` on the directory, `deno check` on both files.

- [ ] **Step 5: commit.**

```bash
git add supabase/functions/youtube-resources/handler.ts supabase/functions/youtube-resources/handler.test.ts supabase/functions/youtube-resources/requestExamples.fixture.ts
git commit -m "feat(youtube): channel-bound video details operation" -- supabase/functions/youtube-resources/handler.ts supabase/functions/youtube-resources/handler.test.ts supabase/functions/youtube-resources/requestExamples.fixture.ts
```

## Task 2b-6: wire tokens, the read client and the rate limit into `index.ts`

**Tier:** Heavy (the only place that touches real credentials).

**Files:** create `supabase/functions/youtube-resources/tokens.ts`, `supabase/functions/youtube-resources/tokens.test.ts`, `supabase/functions/youtube-resources/rateLimit.ts` and `supabase/functions/youtube-resources/rateLimit.test.ts`; modify `supabase/functions/youtube-resources/index.ts`; modify `CLAUDE.md` (the row added in stage 2a).

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** tokens come only from `refreshYouTubeAccountToken`. `recordTransientFailure` stays `false` (an on-demand read must not raise `failure_count`). Never set `adminRecovery`. The only import from `_shared/youtubeComments.ts` is `uploadsPlaylistId`. No token in any log line. No `any`, no `eslint-disable`. Commit only the six files.

**Known mismatch you must handle:** the SQL function `check_rate_limit` (`supabase/manual-sql/20260627213616_rate_limit_buckets.sql`) returns JSON with the key `retry_after`, while the TypeScript type `RpcRateLimitResult` in `_shared/rate-limiter.ts` names it `retryAfter` and the helper only casts. At runtime `retryAfter` can therefore be `undefined`. Do not change `_shared/rate-limiter.ts` in this task. Read the result as `unknown` through `toRateLimitDecision` below, which accepts both spellings.

**You depend on (on `main`):**

```ts
// ../_shared/youtubeTokenRefresh.ts
export type YouTubeRefreshOutcome =
  | { ok: true; status: "fresh" | "refreshed" | "reused"; accessToken: string; expiresAt: string | null; grantedScopes: string[] | null }
  | { ok: false; status: "needs_reauth" | "retryable_refusal" | "failed"; retryable: boolean; reason: string; accessToken: string | null; expiresAt: string | null; needsReauth: boolean; transitioned?: boolean };
export function createSupabaseYouTubeRefreshStore(admin: unknown): YouTubeRefreshStore;
export async function refreshYouTubeAccountToken(options: {
  accountId: string;
  snapshot?: { access_token?: string | null; refresh_token?: string | null; token_expires_at?: string | null; needs_reauth?: boolean | null };
  force?: boolean;
  recordTransientFailure?: boolean;
  store: YouTubeRefreshStore;
}): Promise<YouTubeRefreshOutcome>;

// ../_shared/rate-limiter.ts
export async function checkUserRateLimit(supabaseAdmin: SupabaseClient, endpoint: string, userId: string, maxRequests: number, windowSeconds: number): Promise<{ allowed: boolean; count: number; remaining: number; retryAfter: number }>;

// ../_shared/youtubeComments.ts
export function uploadsPlaylistId(channelId: string): string;

// ./handler.ts
export type YouTubeTokenResult =
  | { ok: true; accessToken: string; minted: boolean }
  | { ok: false; code: "reconnect_required" | "upstream_unavailable" };
```

- [ ] **Step 1: write the failing test** `tokens.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tokenResultFromOutcome } from "./tokens.ts";

const failure = { retryable: false, accessToken: null, expiresAt: null, needsReauth: false };

Deno.test("a stored fresh token is usable and not marked as minted", () => {
  const accessToken = crypto.randomUUID();
  assertEquals(
    tokenResultFromOutcome({ ok: true, status: "fresh", accessToken, expiresAt: null, grantedScopes: null }),
    { ok: true, accessToken, minted: false },
  );
});

Deno.test("a token another worker just committed is not marked as minted", () => {
  const accessToken = crypto.randomUUID();
  assertEquals(
    tokenResultFromOutcome({ ok: true, status: "reused", accessToken, expiresAt: null, grantedScopes: null }),
    { ok: true, accessToken, minted: false },
  );
});

Deno.test("a token this call refreshed is marked as minted", () => {
  const accessToken = crypto.randomUUID();
  assertEquals(
    tokenResultFromOutcome({ ok: true, status: "refreshed", accessToken, expiresAt: null, grantedScopes: null }),
    { ok: true, accessToken, minted: true },
  );
});

Deno.test("needs_reauth and a missing refresh token both ask for a reconnect", () => {
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "needs_reauth", reason: "needs_reauth", needsReauth: true }),
    { ok: false, code: "reconnect_required" },
  );
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "failed", reason: "no_refresh_token" }),
    { ok: false, code: "reconnect_required" },
  );
});

Deno.test("a lease held elsewhere or a transient failure is upstream_unavailable", () => {
  assertEquals(
    tokenResultFromOutcome({ ...failure, ok: false, status: "retryable_refusal", retryable: true, reason: "refresh_in_progress" }),
    { ok: false, code: "upstream_unavailable" },
  );
});
```

Also write `rateLimit.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toRateLimitDecision } from "./rateLimit.ts";

Deno.test("an allowed result lets the request through", () => {
  assertEquals(toRateLimitDecision({ allowed: true, count: 3, remaining: 27, retry_after: 0 }, 600), {
    allowed: true,
    retryAfterSeconds: 0,
  });
});

Deno.test("a refusal reads the wait from the database's snake_case key", () => {
  assertEquals(toRateLimitDecision({ allowed: false, count: 30, remaining: 0, retry_after: 240 }, 600), {
    allowed: false,
    retryAfterSeconds: 240,
  });
});

Deno.test("a refusal also accepts the camelCase key of the TypeScript type", () => {
  assertEquals(toRateLimitDecision({ allowed: false, retryAfter: 90 }, 600), {
    allowed: false,
    retryAfterSeconds: 90,
  });
});

Deno.test("a refusal without a usable wait falls back to the whole window", () => {
  assertEquals(toRateLimitDecision({ allowed: false }, 600), { allowed: false, retryAfterSeconds: 600 });
});

Deno.test("an unreadable result keeps the helper's fail-open behaviour", () => {
  assertEquals(toRateLimitDecision(null, 600), { allowed: true, retryAfterSeconds: 0 });
});
```

- [ ] **Step 2: run and confirm both fail** because `./tokens.ts` and `./rateLimit.ts` do not exist.

- [ ] **Step 3: implement `tokens.ts`:**

```ts
import type { YouTubeRefreshOutcome } from "../_shared/youtubeTokenRefresh.ts";
import type { YouTubeTokenResult } from "./handler.ts";

export function tokenResultFromOutcome(outcome: YouTubeRefreshOutcome): YouTubeTokenResult {
  if (outcome.ok) {
    // Only a token this call minted counts: a reused one may still be rejected and
    // then deserves its single forced refresh.
    return { ok: true, accessToken: outcome.accessToken, minted: outcome.status === "refreshed" };
  }
  if (outcome.status === "needs_reauth" || outcome.reason === "no_refresh_token") {
    return { ok: false, code: "reconnect_required" };
  }
  return { ok: false, code: "upstream_unavailable" };
}
```

Implement `rateLimit.ts`:

```ts
export interface YouTubeRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

// `result` is what checkUserRateLimit resolved with. It is read as unknown because the database
// answers `retry_after` while the TypeScript type says `retryAfter`.
export function toRateLimitDecision(result: unknown, windowSeconds: number): YouTubeRateLimitDecision {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const record = result as Record<string, unknown>;
  if (record.allowed !== false) return { allowed: true, retryAfterSeconds: 0 };
  const wait = [record.retry_after, record.retryAfter].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return { allowed: false, retryAfterSeconds: wait ?? windowSeconds };
}
```

- [ ] **Step 4: wire the three ports in `index.ts`.** Add the imports and, inside `ports`:

```ts
import { checkUserRateLimit } from "../_shared/rate-limiter.ts";
import { uploadsPlaylistId } from "../_shared/youtubeComments.ts";
import { createSupabaseYouTubeRefreshStore, refreshYouTubeAccountToken } from "../_shared/youtubeTokenRefresh.ts";
import { YOUTUBE_RESOURCE_QUOTA_POLICY } from "./contracts.ts";
import { toRateLimitDecision } from "./rateLimit.ts";
import { tokenResultFromOutcome } from "./tokens.ts";
import { createYouTubeReadClient } from "./youtubeReadClient.ts";

const refreshStore = createSupabaseYouTubeRefreshStore(admin);
const { per_user_burst: BURST, per_user_daily: DAILY } = YOUTUBE_RESOURCE_QUOTA_POLICY;

  tokens: {
    get: async (account, { force }) =>
      tokenResultFromOutcome(
        await refreshYouTubeAccountToken({
          accountId: account.id,
          snapshot: {
            access_token: account.accessToken,
            refresh_token: account.refreshToken,
            token_expires_at: account.tokenExpiresAt,
            needs_reauth: account.needsReauth,
          },
          force,
          recordTransientFailure: false,
          store: refreshStore,
        }),
      ),
  },
  youtube: createYouTubeReadClient({ fetchImpl: fetch, uploadsPlaylistIdFor: uploadsPlaylistId }),
  rateLimit: {
    check: async (userId) => {
      const burst = toRateLimitDecision(
        await checkUserRateLimit(admin, "youtube-resources:burst", userId, BURST.limit, BURST.window_seconds),
        BURST.window_seconds,
      );
      if (!burst.allowed) return burst;
      return toRateLimitDecision(
        await checkUserRateLimit(admin, "youtube-resources:day", userId, DAILY.limit, DAILY.window_seconds),
        DAILY.window_seconds,
      );
    },
  },
```

- [ ] **Step 5: update the `CLAUDE.md` row** added in stage 2a so it reads:

```markdown
| `youtube-resources` | Owner-bound YouTube capability contract and native read-only browse (`capabilities`, `channel`, `videos`, `video` operations); spec `docs/specs/2026-11-20-youtube-stage2-resource-browse.md` |
```

- [ ] **Step 6: verify.**

```bash
deno check --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/youtube-resources/index.ts
deno test --allow-env --allow-read --node-modules-dir=none --import-map=.github/deno/process-post-import-map.json supabase/functions/youtube-resources/
git grep -n "eslint-disable\|: any\|as any" -- supabase/functions/youtube-resources/     # must print nothing
git grep -n "oauth2.googleapis.com\|adminRecovery" -- supabase/functions/youtube-resources/   # must print nothing
git grep -n "youtubeComments.ts" -- supabase/functions/youtube-resources/                 # exactly one line: the uploadsPlaylistId import
```

`_shared/rate-limiter.ts` is already typechecked in CI through `_shared/aiImageAtlasRoute.ts`, and `_shared/youtubeComments.ts` and `_shared/youtubeTokenRefresh.ts` through the step `Typecheck and test YouTube refresh lease`. If `deno check` on `index.ts` still fails inside one of those shared files, stop and report the exact error; do not edit a shared file to make it pass.

- [ ] **Step 7: commit.**

```bash
git add supabase/functions/youtube-resources/tokens.ts supabase/functions/youtube-resources/tokens.test.ts supabase/functions/youtube-resources/rateLimit.ts supabase/functions/youtube-resources/rateLimit.test.ts supabase/functions/youtube-resources/index.ts CLAUDE.md
git commit -m "feat(youtube): wire lease-based tokens, read client and rate limit" -- supabase/functions/youtube-resources/tokens.ts supabase/functions/youtube-resources/tokens.test.ts supabase/functions/youtube-resources/rateLimit.ts supabase/functions/youtube-resources/rateLimit.test.ts supabase/functions/youtube-resources/index.ts CLAUDE.md
```

## Task 2b-7: pull request for stage 2b (orchestrator)

**Tier:** Heavy (the PR carries OAuth token use against Google).

- [ ] Before review, re-check the Google field names used by the Zod schemas in `youtubeReadClient.ts` against the resource pages for `channels`, `playlistItems` and `videos` (spec section 9) and record the result in the PR body.
- [ ] Re-check the `page_token` regex `^[A-Za-z0-9_-]{1,256}$` against the characters of a real `nextPageToken` observed from the API. If a real token carries another character, widen the regex to any 1 to 256 printable ASCII characters (or reduce it to a length cap) in the same PR: the token is relayed URL-encoded against the caller's own playlist, so the strict class adds no security and a mismatch would turn every "Load more" past page 1 into `400 invalid_request`.
- [ ] Inspect the full diff, run `clean-code-guard`, `test-guard` and `docs-guard`.
- [ ] `git push origin HEAD:T3-CODE/youtube-stage2b-resource-browse`. PR title `feat(youtube): native resource browse API (stage 2b)`. The body states "Tier: HEAVY", the production call sites (`index.ts` calls `createYouTubeReadClient`, `tokenResultFromOutcome`, `toRateLimitDecision`, `refreshYouTubeAccountToken`, `checkUserRateLimit`), the units each operation spends, that no browser calls the endpoint until stage 2c, and ends with the Claude Code attribution line.
- [ ] Merge only on green CI for the exact head commit and after the review rounds of the tier.
- [ ] Before the merge, confirm with a read-only query (owner or orchestrator, through `supabase_postora_mcp`) that `public.check_rate_limit` exists in production. It lives in `supabase/manual-sql/`, not in `supabase/migrations/`, and `checkUserRateLimit` fails open when the RPC errors, so a missing function would silently switch the guard off.
- [ ] After the Dokploy schedule has deployed, and only with an account the owner authorises for the check: one `channel`, one `videos` and one `video` call answer 200; a `video` call with the ID of a video from another channel answers 404; a channel with zero uploads is called once and Google's real answer is recorded in the PR.

---

# Stage 2c: frontend feature and route

Branch (after 2b is merged): `git fetch origin && git checkout --no-track -b T3-CODE/youtube-stage2c-management-ui origin/main`. Push only with `git push origin HEAD:T3-CODE/youtube-stage2c-management-ui`.

Translation namespace for every screen string: `accounts` (already registered in `src/i18n/index.ts`). The sidebar label uses `nav`.

## Task 2c-1: feature domain

**Tier:** Medium (pure code).

**Files:** create `src/features/youtube-management/domain/types.ts`, `src/features/youtube-management/domain/errors.ts`, `src/features/youtube-management/domain/accountOptions.ts`, `src/features/youtube-management/domain/errors.test.ts`, `src/features/youtube-management/domain/accountOptions.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** domain code imports no React, no Supabase client, no browser API (ARCHITECTURE.md §4). The contract is not redefined: `types.ts` re-exports it from the edge function's `contracts.ts`, the same way `src/features/instagram-insights/domain/types.ts` does. No `any`, no `eslint-disable`. Commit only the five files.

- [ ] **Step 1: write the failing tests.**

`errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRetryableYouTubeError, toYouTubeResourceError, YouTubeResourceError } from "./errors";

describe("toYouTubeResourceError", () => {
  it("keeps the stable code and the retry hint the server sent", () => {
    const error = toYouTubeResourceError({ error: "rate_limited", request_id: "r", retry_after_seconds: 120 });
    expect(error).toBeInstanceOf(YouTubeResourceError);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(120);
  });

  it.each([null, "text", { error: "Quota exceeded for quota metric" }, { error: 42 }])(
    "treats an unknown payload as upstream_unavailable: %j",
    (payload) => {
      expect(toYouTubeResourceError(payload).code).toBe("upstream_unavailable");
    },
  );
});

describe("isRetryableYouTubeError", () => {
  it("retries only transient failures", () => {
    expect(isRetryableYouTubeError("upstream_unavailable")).toBe(true);
    expect(isRetryableYouTubeError("internal_error")).toBe(false);
    expect(isRetryableYouTubeError("quota_exceeded")).toBe(false);
    expect(isRetryableYouTubeError("rate_limited")).toBe(false);
    expect(isRetryableYouTubeError("not_found")).toBe(false);
    expect(isRetryableYouTubeError("reconnect_required")).toBe(false);
  });
});
```

`accountOptions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toYouTubeAccountOptions } from "./accountOptions";

describe("toYouTubeAccountOptions", () => {
  it("keeps only YouTube accounts and names an untitled channel by a neutral label", () => {
    const options = toYouTubeAccountOptions([
      { id: "a", platform: "youtube", platform_username: "Channel A", avatar_url: "https://cdn.example/a.png", auth_provider: "native" },
      { id: "b", platform: "instagram", platform_username: "ig", avatar_url: null, auth_provider: "native" },
      { id: "c", platform: "youtube", platform_username: null, avatar_url: null, auth_provider: "composio" },
    ]);
    expect(options).toEqual([
      { id: "a", title: "Channel A", avatarUrl: "https://cdn.example/a.png", provider: "native" },
      { id: "c", title: "YouTube", avatarUrl: null, provider: "composio" },
    ]);
  });
});
```

- [ ] **Step 2: run and confirm they fail** (`npx vitest run src/features/youtube-management/domain`): the modules do not exist.

- [ ] **Step 3: implement.**

`types.ts`:

```ts
// One contract for the edge function and the UI: never redefine these here.
export {
  isYouTubeResourceErrorCode,
  YOUTUBE_VIDEOS_DEFAULT_PAGE_SIZE,
} from "../../../../supabase/functions/youtube-resources/contracts";
export type {
  YouTubeAccountCapabilities,
  YouTubeCapabilityReason,
  YouTubeCapabilityState,
  YouTubeChannelDetails,
  YouTubeResourceErrorCode,
  YouTubeResourceSuccess,
  YouTubeVideoDetails,
  YouTubeVideoListItem,
  YouTubeVideosPage,
} from "../../../../supabase/functions/youtube-resources/contracts";
```

`errors.ts`:

```ts
import { isYouTubeResourceErrorCode, type YouTubeResourceErrorCode } from "./types";

export class YouTubeResourceError extends Error {
  readonly code: YouTubeResourceErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: YouTubeResourceErrorCode, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = "YouTubeResourceError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function toYouTubeResourceError(payload: unknown): YouTubeResourceError;   // unknown shape or code -> "upstream_unavailable"
export function isRetryableYouTubeError(code: YouTubeResourceErrorCode): boolean; // true only for "upstream_unavailable"; "internal_error" is NOT retried because it means the server-side read just failed
```

`accountOptions.ts`:

```ts
export interface YouTubeAccountSource {
  id: string;
  platform: string;
  platform_username: string | null;
  avatar_url: string | null;
  auth_provider?: string | null;
}

export interface YouTubeAccountOption {
  id: string;
  title: string;
  avatarUrl: string | null;
  provider: "native" | "composio";
}

export function toYouTubeAccountOptions(accounts: readonly YouTubeAccountSource[]): YouTubeAccountOption[];
// filter platform === "youtube"; title = platform_username ?? "YouTube"; provider = "composio" only when auth_provider === "composio"
```

- [ ] **Step 4: verify.** `npx vitest run src/features/youtube-management/domain` and `npm run typecheck`.

- [ ] **Step 5: commit.**

```bash
git add src/features/youtube-management/domain/types.ts src/features/youtube-management/domain/errors.ts src/features/youtube-management/domain/accountOptions.ts src/features/youtube-management/domain/errors.test.ts src/features/youtube-management/domain/accountOptions.test.ts
git commit -m "feat(youtube-management): domain types, errors and account options" -- src/features/youtube-management/domain/types.ts src/features/youtube-management/domain/errors.ts src/features/youtube-management/domain/accountOptions.ts src/features/youtube-management/domain/errors.test.ts src/features/youtube-management/domain/accountOptions.test.ts
```

## Task 2c-2: gateway port and Supabase gateway

**Tier:** Medium (browser-side adapter of an authenticated endpoint; no auth rule of its own, no migration).

**Files:** create `src/features/youtube-management/application/ports.ts`, `src/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway.ts`, `src/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway.test.ts`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** the infrastructure file is the only file of the feature that imports `@/integrations/supabase/client` (ARCHITECTURE.md §11). The gateway never sends a user ID. A failed call throws `YouTubeResourceError` with the server's stable code; it never returns an empty result for a failure. No `any`, no `eslint-disable`. Commit only the three files.

**You depend on (task 2c-1):**

```ts
// ../domain/errors
export class YouTubeResourceError extends Error { readonly code: YouTubeResourceErrorCode; readonly retryAfterSeconds: number | null; constructor(code: YouTubeResourceErrorCode, retryAfterSeconds?: number | null) }
export function toYouTubeResourceError(payload: unknown): YouTubeResourceError;
// ../domain/types: YouTubeAccountCapabilities, YouTubeChannelDetails, YouTubeVideosPage, YouTubeVideoDetails, YouTubeResourceSuccess<T>
// supabase/functions/youtube-resources/requestExamples.fixture.ts (on main since stage 2b, import-free):
//   EXAMPLE_ACCOUNT_ID, EXAMPLE_VIDEO_ID, EXAMPLE_PAGE_TOKEN,
//   YOUTUBE_RESOURCE_REQUEST_EXAMPLES = { capabilities, channel, videosFirstPage, videosNextPage, video }
```

- [ ] **Step 1: write the failing test** `supabaseYouTubeResourcesGateway.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  EXAMPLE_ACCOUNT_ID,
  EXAMPLE_PAGE_TOKEN,
  EXAMPLE_VIDEO_ID,
  YOUTUBE_RESOURCE_REQUEST_EXAMPLES,
} from "../../../../supabase/functions/youtube-resources/requestExamples.fixture";
import { YouTubeResourceError } from "../domain/errors";
import { SupabaseYouTubeResourcesGateway } from "./supabaseYouTubeResourcesGateway";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

const envelope = <T,>(data: T) => ({
  schema_version: 1 as const,
  request_id: "req-1",
  freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" as const },
  data,
});

describe("YouTube resources gateway", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks for a page of videos with the account, the size and the cursor, and no user id", async () => {
    const page = envelope({ items: [], next_page_token: null, total_results: 0 });
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: page, error: null });

    const received = await new SupabaseYouTubeResourcesGateway().listVideos({ accountId: "acc-1", pageToken: "PAGE2" });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: { operation: "videos", account_id: "acc-1", page_token: "PAGE2" },
    });
    expect(received).toEqual(page);
  });

  it("omits the cursor on the first page", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ items: [], next_page_token: null, total_results: 0 }),
      error: null,
    });
    await new SupabaseYouTubeResourcesGateway().listVideos({ accountId: "acc-1", pageToken: null });
    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: { operation: "videos", account_id: "acc-1" },
    });
  });

  it("sends exactly the request bodies the edge handler's shared examples define", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: envelope({}), error: null });
    const gateway = new SupabaseYouTubeResourcesGateway();

    await gateway.getCapabilities(EXAMPLE_ACCOUNT_ID);
    await gateway.getChannel(EXAMPLE_ACCOUNT_ID);
    await gateway.listVideos({ accountId: EXAMPLE_ACCOUNT_ID });
    await gateway.listVideos({ accountId: EXAMPLE_ACCOUNT_ID, pageToken: EXAMPLE_PAGE_TOKEN });
    await gateway.getVideo({ accountId: EXAMPLE_ACCOUNT_ID, videoId: EXAMPLE_VIDEO_ID });

    const sent = vi.mocked(supabase.functions.invoke).mock.calls.map((call) => call[1]?.body);
    expect(sent).toEqual([
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.capabilities,
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.channel,
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.videosFirstPage,
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.videosNextPage,
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.video,
    ]);
  });

  it("turns a refusal into the server's stable code", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ error: "quota_exceeded", request_id: "req-2" }, { status: 429 }),
      }),
    });
    const failure = await new SupabaseYouTubeResourcesGateway().getChannel("acc-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(YouTubeResourceError);
    expect((failure as YouTubeResourceError).code).toBe("quota_exceeded");
  });

  it("treats a failure without a readable body as upstream_unavailable", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: new Error("network down") });
    await expect(new SupabaseYouTubeResourcesGateway().getVideo({ accountId: "acc-1", videoId: "videoAAAAAAA" }))
      .rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("treats an empty success as a failure, never as an empty resource", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: null });
    await expect(new SupabaseYouTubeResourcesGateway().getCapabilities("acc-1"))
      .rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});
```

- [ ] **Step 2: run and confirm it fails** (`npx vitest run src/features/youtube-management/infrastructure`).

- [ ] **Step 3: implement.**

`application/ports.ts`:

```ts
import type {
  YouTubeAccountCapabilities,
  YouTubeChannelDetails,
  YouTubeResourceSuccess,
  YouTubeVideoDetails,
  YouTubeVideosPage,
} from "../domain/types";

export interface YouTubeResourcesGateway {
  getCapabilities(accountId: string): Promise<YouTubeResourceSuccess<YouTubeAccountCapabilities>>;
  getChannel(accountId: string): Promise<YouTubeResourceSuccess<YouTubeChannelDetails>>;
  listVideos(params: { accountId: string; pageToken?: string | null }): Promise<YouTubeResourceSuccess<YouTubeVideosPage>>;
  getVideo(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<YouTubeVideoDetails>>;
}
```

`infrastructure/supabaseYouTubeResourcesGateway.ts`: `export class SupabaseYouTubeResourcesGateway implements YouTubeResourcesGateway` plus `export const defaultYouTubeResourcesGateway = new SupabaseYouTubeResourcesGateway();`. One private helper does every call:

```ts
async function call<T>(body: Record<string, unknown>): Promise<YouTubeResourceSuccess<T>> {
  const { data, error } = await supabase.functions.invoke<YouTubeResourceSuccess<T>>("youtube-resources", { body });
  if (error) {
    const context = (error as { context?: unknown }).context;
    const payload: unknown = context instanceof Response
      ? await context.clone().json().catch(() => null)
      : null;
    throw toYouTubeResourceError(payload);
  }
  if (!data) throw new YouTubeResourceError("upstream_unavailable");
  return data;
}
```

Bodies: `{ operation: "capabilities", account_id }`, `{ operation: "channel", account_id }`, `{ operation: "videos", account_id, ...(pageToken ? { page_token: pageToken } : {}) }`, `{ operation: "video", account_id, video_id }`.

- [ ] **Step 4: verify.** `npx vitest run src/features/youtube-management/infrastructure`, `npm run typecheck`.

- [ ] **Step 5: commit.**

```bash
git add src/features/youtube-management/application/ports.ts src/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway.ts src/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway.test.ts
git commit -m "feat(youtube-management): resources gateway" -- src/features/youtube-management/application/ports.ts src/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway.ts src/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway.test.ts
```

## Task 2c-3: query hooks

**Tier:** Medium (client state only; the risk is showing one account's data under another, which the tests cover).

**Files:** create `src/features/youtube-management/application/queryKeys.ts`, `useYouTubeCapabilities.ts`, `useYouTubeChannel.ts`, `useYouTubeVideos.ts`, `useYouTubeVideo.ts` and `useYouTubeVideos.test.tsx`, all in `src/features/youtube-management/application/`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** application code imports no infrastructure and no Supabase client; the gateway arrives as a parameter (ARCHITECTURE.md §4). Every query key contains the user ID and the account ID. Never use `placeholderData` or `keepPreviousData`: after an account switch the previous account's data must not be returned. No `refetchInterval`. No `any`, no `eslint-disable`. Commit only the six files.

**You depend on:**

```ts
// ./ports (task 2c-2): YouTubeResourcesGateway with getCapabilities, getChannel, listVideos, getVideo
// ../domain/errors (task 2c-1): YouTubeResourceError, isRetryableYouTubeError(code)
// @/hooks/useAuth (on main): useAuth() returns { user: { id: string } | null, ... }
```

- [ ] **Step 1: write the failing test** `useYouTubeVideos.test.tsx`:

```tsx
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { YouTubeResourceError } from "../domain/errors";
import type { YouTubeResourcesGateway } from "./ports";
import { useYouTubeVideos } from "./useYouTubeVideos";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));

function page(prefix: string, next: string | null) {
  return {
    schema_version: 1 as const,
    request_id: "req",
    freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" as const },
    data: {
      items: [{ id: `${prefix}-1`, title: `${prefix} video`, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x" }],
      next_page_token: next,
      total_results: 1,
    },
  };
}

function gatewayWith(listVideos: YouTubeResourcesGateway["listVideos"]): YouTubeResourcesGateway {
  const unused = () => Promise.reject(new Error("not used"));
  return { getCapabilities: unused, getChannel: unused, getVideo: unused, listVideos };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useYouTubeVideos", () => {
  it("never shows the previous account's videos after a switch", async () => {
    let releaseB: (value: ReturnType<typeof page>) => void = () => {};
    const listVideos = vi.fn(({ accountId }: { accountId: string }) =>
      accountId === "acc-a"
        ? Promise.resolve(page("A", null))
        : new Promise<ReturnType<typeof page>>((resolve) => { releaseB = resolve; }));
    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string }) => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId, enabled: true }),
      { wrapper: wrapper(), initialProps: { accountId: "acc-a" } },
    );
    await waitFor(() => expect(result.current.data?.pages[0].data.items[0].id).toBe("A-1"));

    rerender({ accountId: "acc-b" });
    expect(result.current.data).toBeUndefined();

    releaseB(page("B", null));
    await waitFor(() => expect(result.current.data?.pages[0].data.items[0].id).toBe("B-1"));
  });

  it("requests the next page with the cursor of the last page", async () => {
    const listVideos = vi.fn(({ pageToken }: { pageToken?: string | null }) =>
      Promise.resolve(pageToken ? page("second", null) : page("first", "PAGE2")));
    const { result } = renderHook(
      () => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId: "acc-a", enabled: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(listVideos).toHaveBeenLastCalledWith({ accountId: "acc-a", pageToken: "PAGE2" });
    expect(result.current.hasNextPage).toBe(false);
  });

  it("reports a failed page as an error, not as an empty list", async () => {
    const listVideos = vi.fn(() => Promise.reject(new YouTubeResourceError("quota_exceeded")));
    const { result } = renderHook(
      () => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId: "acc-a", enabled: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(listVideos).toHaveBeenCalledTimes(1);
  });

  it("does not call the gateway while disabled or without an account", () => {
    const listVideos = vi.fn(() => Promise.resolve(page("A", null)));
    renderHook(() => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId: null, enabled: true }), { wrapper: wrapper() });
    renderHook(() => useYouTubeVideos({ gateway: gatewayWith(listVideos), accountId: "acc-a", enabled: false }), { wrapper: wrapper() });
    expect(listVideos).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: run and confirm it fails** (`npx vitest run src/features/youtube-management/application`).

- [ ] **Step 3: implement.**

`queryKeys.ts`:

```ts
import { isRetryableYouTubeError, YouTubeResourceError } from "../domain/errors";

export const YOUTUBE_RESOURCE_STALE_MS = 5 * 60_000;
export const YOUTUBE_CAPABILITIES_STALE_MS = 60_000;

export function youtubeResourceKey(userId: string, accountId: string | null, resource: string, id?: string) {
  return ["youtube-resources", userId, accountId, resource, id ?? null] as const;
}

// One repeat, and only for transient failures. Quota and rate limit are never retried.
export function youtubeResourceRetry(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && error instanceof YouTubeResourceError && isRetryableYouTubeError(error.code);
}
```

Hooks (each takes `{ gateway, accountId, enabled? }`; `useYouTubeVideo` also takes `videoId: string | null`):

```ts
export function useYouTubeCapabilities(options: { gateway: YouTubeResourcesGateway; accountId: string | null }): UseQueryResult<YouTubeResourceSuccess<YouTubeAccountCapabilities>, Error>;
export function useYouTubeChannel(options: { gateway: YouTubeResourcesGateway; accountId: string | null; enabled: boolean }): UseQueryResult<YouTubeResourceSuccess<YouTubeChannelDetails>, Error>;
export function useYouTubeVideos(options: { gateway: YouTubeResourcesGateway; accountId: string | null; enabled: boolean }): UseInfiniteQueryResult<InfiniteData<YouTubeResourceSuccess<YouTubeVideosPage>, string | null>, Error>;
export function useYouTubeVideo(options: { gateway: YouTubeResourcesGateway; accountId: string | null; videoId: string | null; enabled: boolean }): UseQueryResult<YouTubeResourceSuccess<YouTubeVideoDetails>, Error>;
```

`useYouTubeCapabilities` takes only `{ gateway, accountId }` (no `enabled` option) and is enabled when `Boolean(accountId && user?.id)`; the other hooks also take `enabled`. Common options: `queryKey: youtubeResourceKey(userId, accountId, "<resource>", videoId)`, `enabled: Boolean(enabled && accountId && user?.id)` (and `videoId` for the video hook), `staleTime` from the constants, `refetchOnWindowFocus: false`, `retry: youtubeResourceRetry`. `useYouTubeVideos` uses `useInfiniteQuery` with `initialPageParam: null as string | null`, `queryFn: ({ pageParam }) => gateway.listVideos({ accountId, pageToken: pageParam })` and `getNextPageParam: (last) => last.data.next_page_token ?? undefined`. `userId` is `useAuth().user?.id ?? "anonymous"`.

The test in step 1 passes `retry: false` at the client level but the hook's own `retry` wins; `quota_exceeded` is not retryable, so the gateway is called once.

- [ ] **Step 4: verify.** `npx vitest run src/features/youtube-management/application`, `npm run typecheck`.

- [ ] **Step 5: commit.**

```bash
git add src/features/youtube-management/application/queryKeys.ts src/features/youtube-management/application/useYouTubeCapabilities.ts src/features/youtube-management/application/useYouTubeChannel.ts src/features/youtube-management/application/useYouTubeVideos.ts src/features/youtube-management/application/useYouTubeVideo.ts src/features/youtube-management/application/useYouTubeVideos.test.tsx
git commit -m "feat(youtube-management): account-scoped query hooks" -- src/features/youtube-management/application/queryKeys.ts src/features/youtube-management/application/useYouTubeCapabilities.ts src/features/youtube-management/application/useYouTubeChannel.ts src/features/youtube-management/application/useYouTubeVideos.ts src/features/youtube-management/application/useYouTubeVideo.ts src/features/youtube-management/application/useYouTubeVideos.test.tsx
```

## Task 2c-4: notice, account picker and channel summary components

**Tier:** Medium (presentational UI and i18n, but more than the 150 lines a Light task allows).

**Files:** create in `src/features/youtube-management/ui/`: `YouTubeResourceNotice.tsx`, `YouTubeAccountPicker.tsx`, `YouTubeChannelSummary.tsx`, `__tests__/YouTubeResourceNotice.test.tsx`, `__tests__/YouTubeChannelSummary.test.tsx`. Modify `src/i18n/locales/ar/accounts.json`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** presentational components only: props in, callbacks out, no gateway and no query hook inside them. Every string is `t("literal.key", "English default")` under `useTranslation("accounts")`; never build a key from a variable (the i18n gate cannot see it, and the bundle key becomes an orphan). Add the Arabic entry for every key in this same task, and add no key you do not use. Counters are labelled as YouTube counters, never as watch time. No `any`, no `eslint-disable`. Commit only the six files.

**You depend on (tasks 2c-1):** `YouTubeResourceErrorCode`, `YouTubeChannelDetails` from `../domain/types`; `YouTubeAccountOption` from `../domain/accountOptions`.

- [ ] **Step 1: write the failing tests.** Both files use this helper (copy it into each file; it is the pattern of `src/features/instagram-insights/ui/__tests__/MetricsOverviewCards.test.tsx`):

```tsx
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";

async function renderUi(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  return render(<MemoryRouter><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></MemoryRouter>);
}
```

`__tests__/YouTubeResourceNotice.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { YouTubeResourceNotice } from "../YouTubeResourceNotice";

describe("YouTubeResourceNotice", () => {
  it.each([
    ["reconnect_required", "This channel needs to be reconnected before Postora can read it."],
    ["missing_scope", "Postora does not have permission to read this channel. Reconnect it and allow viewing your YouTube account."],
    ["provider_unsupported", "This channel is connected through the managed connector, which does not support browsing yet."],
    ["quota_exceeded", "YouTube's daily limit for Postora is used up. It resets at midnight Pacific Time."],
    ["not_found", "YouTube could not find this content for the connected channel."],
    ["upstream_unavailable", "YouTube did not answer. Nothing was changed."],
  ] as const)("explains %s in its own words", async (code, message) => {
    await renderUi(<YouTubeResourceNotice code={code} retryAfterSeconds={null} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("tells a rate limited user how long to wait", async () => {
    await renderUi(<YouTubeResourceNotice code="rate_limited" retryAfterSeconds={120} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Too many requests. Try again in 2 minutes.");
  });

  it("links to Profiles when a reconnect fixes it and offers no retry", async () => {
    await renderUi(<YouTubeResourceNotice code="reconnect_required" retryAfterSeconds={null} onRetry={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open Profiles" })).toHaveAttribute("href", "/profiles");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry only for a transient failure", async () => {
    const onRetry = vi.fn();
    await renderUi(<YouTubeResourceNotice code="upstream_unavailable" retryAfterSeconds={null} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
```

`__tests__/YouTubeChannelSummary.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { YouTubeChannelSummary } from "../YouTubeChannelSummary";

const channel = {
  id: "UCfixturechannel000000001",
  title: "Fixture channel",
  description: "",
  custom_url: "@fixture",
  thumbnail_url: null,
  published_at: null,
  country: null,
  privacy_status: "public",
  statistics: { view_count: 1200, subscriber_count: null, subscriber_count_hidden: true, video_count: 7 },
};

describe("YouTubeChannelSummary", () => {
  it("shows the channel, says when subscribers are hidden, and labels the counters honestly", async () => {
    await renderUi(<YouTubeChannelSummary channel={channel} fetchedAt="2026-11-20T10:00:00.000Z" />);
    expect(screen.getByRole("heading", { name: "Fixture channel" })).toBeInTheDocument();
    expect(screen.getByText("Hidden")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Counters come from YouTube. They are not watch-time reports.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: run and confirm they fail** (`npx vitest run src/features/youtube-management/ui`).

- [ ] **Step 3: implement the three components.**

```tsx
// YouTubeResourceNotice.tsx
export interface YouTubeResourceNoticeProps {
  code: YouTubeResourceErrorCode;
  retryAfterSeconds: number | null;
  onRetry: () => void;
}
export function YouTubeResourceNotice(props: YouTubeResourceNoticeProps): JSX.Element;
```

The message comes from a `switch (code)` whose every branch is a literal `t(...)` call. Root element has `role="alert"`. `reconnect_required` and `missing_scope` render a `Link` to `/profiles`. Only `upstream_unavailable` and `internal_error` render the retry button. `rate_limited` uses `Math.max(1, Math.ceil((retryAfterSeconds ?? 60) / 60))` as `{{minutes}}`. `invalid_request`, `invalid_cursor`, `unauthorized`, `method_not_allowed` and `internal_error` use the generic key.

```tsx
// YouTubeAccountPicker.tsx
export interface YouTubeAccountPickerProps {
  accounts: readonly YouTubeAccountOption[];
  selectedId: string | null;
  onSelect: (accountId: string) => void;
}
// A labelled native <select> (label text from t("youtubeManagement.accountLabel", "Channel")).

// YouTubeChannelSummary.tsx
export interface YouTubeChannelSummaryProps {
  channel: YouTubeChannelDetails;
  fetchedAt: string;
}
// <h2> with the title; three counters (subscribers, views, videos); "Hidden" when subscriber_count_hidden;
// numbers through new Intl.NumberFormat().format; the counters note; the fetch time.
```

Keys to add under a new top-level object `"youtubeManagement"` in `src/i18n/locales/ar/accounts.json` (keep the file's alphabetical key order), and the English defaults to use at the call sites:

| Key | English default | Arabic |
|---|---|---|
| `youtubeManagement.accountLabel` | Channel | القناة |
| `youtubeManagement.goToProfiles` | Open Profiles | افتح الملفات |
| `youtubeManagement.retry` | Try again | جرّب تاني |
| `youtubeManagement.fetchedAt` | Updated {{time}} | آخر تحديث {{time}} |
| `youtubeManagement.countersNote` | Counters come from YouTube. They are not watch-time reports. | الأرقام دي جاية من YouTube، ومش تقارير مدة مشاهدة. |
| `youtubeManagement.stats.subscribers` | Subscribers | المشتركين |
| `youtubeManagement.stats.views` | Views | المشاهدات |
| `youtubeManagement.stats.videos` | Videos | الفيديوهات |
| `youtubeManagement.stats.hidden` | Hidden | مخفي |
| `youtubeManagement.notice.reconnectRequired` | This channel needs to be reconnected before Postora can read it. | القناة دي محتاجة تتربط تاني قبل ما Postora يقدر يقراها. |
| `youtubeManagement.notice.missingScope` | Postora does not have permission to read this channel. Reconnect it and allow viewing your YouTube account. | Postora معندوش صلاحية يقرا القناة دي. اربطها تاني ووافق على عرض حساب YouTube بتاعك. |
| `youtubeManagement.notice.providerUnsupported` | This channel is connected through the managed connector, which does not support browsing yet. | القناة دي مربوطة عن طريق الموصّل المُدار، وده لسه مش بيدعم التصفّح. |
| `youtubeManagement.notice.quotaExceeded` | YouTube's daily limit for Postora is used up. It resets at midnight Pacific Time. | الحد اليومي بتاع YouTube لـ Postora خلص. بيتجدد عند نص الليل بتوقيت المحيط الهادئ. |
| `youtubeManagement.notice.rateLimited` | Too many requests. Try again in about {{minutes}} min. | طلبات كتير. جرّب تاني بعد حوالي {{minutes}} دقيقة. |
| `youtubeManagement.notice.notFound` | YouTube could not find this content for the connected channel. | YouTube ملقاش المحتوى ده للقناة المربوطة. |
| `youtubeManagement.notice.upstreamUnavailable` | YouTube did not answer. Nothing was changed. | YouTube مردّش. مفيش حاجة اتغيّرت. |
| `youtubeManagement.notice.generic` | Something went wrong while loading this content. | حصلت مشكلة وإحنا بنحمّل المحتوى ده. |

- [ ] **Step 4: verify.**

```bash
npx vitest run src/features/youtube-management/ui
npm run typecheck
npm run check:i18n
npx eslint src/features/youtube-management
```

- [ ] **Step 5: commit.**

```bash
git add src/features/youtube-management/ui/YouTubeResourceNotice.tsx src/features/youtube-management/ui/YouTubeAccountPicker.tsx src/features/youtube-management/ui/YouTubeChannelSummary.tsx src/features/youtube-management/ui/__tests__/YouTubeResourceNotice.test.tsx src/features/youtube-management/ui/__tests__/YouTubeChannelSummary.test.tsx src/i18n/locales/ar/accounts.json
git commit -m "feat(youtube-management): notice, account picker and channel summary" -- src/features/youtube-management/ui/YouTubeResourceNotice.tsx src/features/youtube-management/ui/YouTubeAccountPicker.tsx src/features/youtube-management/ui/YouTubeChannelSummary.tsx src/features/youtube-management/ui/__tests__/YouTubeResourceNotice.test.tsx src/features/youtube-management/ui/__tests__/YouTubeChannelSummary.test.tsx src/i18n/locales/ar/accounts.json
```

## Task 2c-5: video library and video detail components

**Tier:** Medium (presentational UI and i18n, above the Light size limit).

**Files:** create in `src/features/youtube-management/ui/`: `YouTubeVideoLibrary.tsx`, `YouTubeVideoDetail.tsx`, `__tests__/YouTubeVideoLibrary.test.tsx`, `__tests__/YouTubeVideoDetail.test.tsx`. Modify `src/i18n/locales/ar/accounts.json`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** presentational components only. An empty list and a failed list are different states: the library renders the empty text only when it is given zero items and no error; the caller renders errors with `YouTubeResourceNotice`. Literal `t()` keys under `useTranslation("accounts")`, Arabic entry for each key in this task, no unused key. External links open with `target="_blank"` and `rel="noopener noreferrer"`. No `any`, no `eslint-disable`. Commit only the five files.

**You depend on:** `YouTubeVideoListItem`, `YouTubeVideoDetails` from `../domain/types`.

- [ ] **Step 1: write the failing tests.** Put this helper at the top of each of the two test files:

```tsx
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";

async function renderUi(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  return render(<MemoryRouter><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></MemoryRouter>);
}
```

`__tests__/YouTubeVideoLibrary.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { YouTubeVideoLibrary } from "../YouTubeVideoLibrary";

const video = (id: string) => ({
  id,
  title: `Title ${id}`,
  thumbnail_url: null,
  published_at: "2026-11-01T00:00:00Z",
  privacy_status: "unlisted",
  url: `https://www.youtube.com/watch?v=${id}`,
});

describe("YouTubeVideoLibrary", () => {
  it("lists the videos and reports the one the user picks", async () => {
    const onSelect = vi.fn();
    await renderUi(
      <YouTubeVideoLibrary videos={[video("a"), video("b")]} selectedVideoId={null} onSelect={onSelect}
        hasMore={false} isLoadingMore={false} onLoadMore={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Title b/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("offers more only while another page exists", async () => {
    const onLoadMore = vi.fn();
    await renderUi(
      <YouTubeVideoLibrary videos={[video("a")]} selectedVideoId={null} onSelect={vi.fn()}
        hasMore isLoadingMore={false} onLoadMore={onLoadMore} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("This channel has no uploaded videos yet.")).not.toBeInTheDocument();
  });

  it("says the channel has no uploads when the list is empty", async () => {
    await renderUi(
      <YouTubeVideoLibrary videos={[]} selectedVideoId={null} onSelect={vi.fn()}
        hasMore={false} isLoadingMore={false} onLoadMore={vi.fn()} />,
    );
    expect(screen.getByText("This channel has no uploaded videos yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
```

`__tests__/YouTubeVideoDetail.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { YouTubeVideoDetail } from "../YouTubeVideoDetail";

const details = {
  id: "videoAAAAAAA",
  channel_id: "UCfixturechannel000000001",
  title: "First video",
  description: "Body text",
  thumbnail_url: null,
  published_at: "2026-10-31T00:00:00Z",
  tags: ["one", "two"],
  category_id: "22",
  default_language: "ar",
  duration_iso8601: "PT4M13S",
  privacy_status: "public",
  upload_status: "processed",
  made_for_kids: false,
  statistics: { view_count: 10, like_count: null, comment_count: 1 },
  url: "https://www.youtube.com/watch?v=videoAAAAAAA",
};

describe("YouTubeVideoDetail", () => {
  it("shows the details and a safe link to YouTube", async () => {
    await renderUi(<YouTubeVideoDetail video={details} fetchedAt="2026-11-20T10:00:00.000Z" />);
    expect(screen.getByRole("heading", { name: "First video" })).toBeInTheDocument();
    expect(screen.getByText("Body text")).toBeInTheDocument();
    expect(screen.getByText("4:13")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open on YouTube" });
    expect(link).toHaveAttribute("href", details.url);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows a counter YouTube did not return as unavailable, not as zero", async () => {
    await renderUi(<YouTubeVideoDetail video={details} fetchedAt="2026-11-20T10:00:00.000Z" />);
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: run and confirm they fail.**

- [ ] **Step 3: implement.**

```tsx
// YouTubeVideoLibrary.tsx
export interface YouTubeVideoLibraryProps {
  videos: readonly YouTubeVideoListItem[];
  selectedVideoId: string | null;
  onSelect: (videoId: string) => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}
// A heading with t("youtubeManagement.library.title", "Uploaded videos").
// Each video is a <button type="button"> whose accessible name starts with the title;
// aria-pressed marks the selected one. "Load more" only when hasMore; disabled while isLoadingMore.

// YouTubeVideoDetail.tsx
export interface YouTubeVideoDetailProps {
  video: YouTubeVideoDetails;
  fetchedAt: string;
}
// <h3> title, description, privacy, duration, three counters, tags, link to video.url.
```

Add one pure helper in `YouTubeVideoDetail.tsx`: `formatIsoDuration(value: string | null): string | null`, which turns `PT4M13S` into `4:13` and `PT1H2M3S` into `1:02:03`, and returns `null` for `null` or an unparseable value (render the "Not available" text then).

Keys to add to `src/i18n/locales/ar/accounts.json` under `youtubeManagement`:

| Key | English default | Arabic |
|---|---|---|
| `youtubeManagement.library.title` | Uploaded videos | الفيديوهات المرفوعة |
| `youtubeManagement.library.empty` | This channel has no uploaded videos yet. | القناة دي مفيهاش فيديوهات مرفوعة لسه. |
| `youtubeManagement.library.loadMore` | Load more | حمّل أكتر |
| `youtubeManagement.detail.openOnYouTube` | Open on YouTube | افتح على YouTube |
| `youtubeManagement.detail.privacy` | Privacy | الخصوصية |
| `youtubeManagement.detail.duration` | Duration | المدة |
| `youtubeManagement.detail.views` | Views | المشاهدات |
| `youtubeManagement.detail.likes` | Likes | الإعجابات |
| `youtubeManagement.detail.comments` | Comments | التعليقات |
| `youtubeManagement.detail.tags` | Tags | الوسوم |
| `youtubeManagement.detail.notAvailable` | Not available | مش متاح |

For the fetch time, call the key that already exists in the bundle: `t("youtubeManagement.fetchedAt", "Updated {{time}}", { time })`. Do not add it again. Every key in the table must be used by a component of this task, otherwise `npm run check:i18n` reports it as an orphan.

- [ ] **Step 4: verify.** Same four commands as task 2c-4.

- [ ] **Step 5: commit.**

```bash
git add src/features/youtube-management/ui/YouTubeVideoLibrary.tsx src/features/youtube-management/ui/YouTubeVideoDetail.tsx src/features/youtube-management/ui/__tests__/YouTubeVideoLibrary.test.tsx src/features/youtube-management/ui/__tests__/YouTubeVideoDetail.test.tsx src/i18n/locales/ar/accounts.json
git commit -m "feat(youtube-management): video library and detail" -- src/features/youtube-management/ui/YouTubeVideoLibrary.tsx src/features/youtube-management/ui/YouTubeVideoDetail.tsx src/features/youtube-management/ui/__tests__/YouTubeVideoLibrary.test.tsx src/features/youtube-management/ui/__tests__/YouTubeVideoDetail.test.tsx src/i18n/locales/ar/accounts.json
```

## Task 2c-6: the screen, the public API and the layering test

**Tier:** Medium (composition of the feature; no auth, money or schema change).

**Files:** create `src/features/youtube-management/ui/YouTubeManagementScreen.tsx`, `src/features/youtube-management/ui/__tests__/YouTubeManagementScreen.test.tsx`, `src/features/youtube-management/tests/architecture.test.ts`, `src/features/youtube-management/index.ts`. Modify `src/i18n/locales/ar/accounts.json`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** `YouTubeManagementScreen.tsx` is the only file under `ui/` that imports from `infrastructure/` (for the default gateway). The screen takes the account list as a prop; it does not import `useSocialAccounts` or any other legacy hook. When capabilities say browse is `unavailable`, the channel, videos and video hooks stay disabled. Changing the account clears the selected video. Literal `t()` keys, Arabic entry for each key in this task. No `any`, no `eslint-disable`. Commit only the five files.

**You depend on:**

```ts
// ../application (task 2c-3)
useYouTubeCapabilities({ gateway, accountId })
useYouTubeChannel({ gateway, accountId, enabled })
useYouTubeVideos({ gateway, accountId, enabled })       // .data.pages[n].data.items, .hasNextPage, .fetchNextPage(), .isFetchingNextPage
useYouTubeVideo({ gateway, accountId, videoId, enabled })
// ../infrastructure/supabaseYouTubeResourcesGateway (task 2c-2): defaultYouTubeResourcesGateway
// ./YouTubeResourceNotice, ./YouTubeAccountPicker, ./YouTubeChannelSummary (task 2c-4)
// ./YouTubeVideoLibrary, ./YouTubeVideoDetail (task 2c-5)
// ../domain/errors: YouTubeResourceError (has .code and .retryAfterSeconds)
// ../domain/accountOptions: YouTubeAccountOption = { id, title, avatarUrl, provider }
```

- [ ] **Step 1: write the failing tests.**

`ui/__tests__/YouTubeManagementScreen.test.tsx`. In addition to the cases in the code block below, add one more test that clicks the screen's Refresh control (`youtubeManagement.refresh`) and asserts that the fake gateway's `getChannel` and `listVideos` are called again (the queries refetch). The screen's Refresh behaviour needs a test like every other behaviour here.

```tsx
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import type { YouTubeResourcesGateway } from "../../application/ports";
import type { YouTubeCapabilityState } from "../../domain/types";
import { YouTubeManagementScreen } from "../YouTubeManagementScreen";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));

const ACCOUNTS = [
  { id: "acc-a", title: "Channel A", avatarUrl: null, provider: "native" as const },
  { id: "acc-b", title: "Channel B", avatarUrl: null, provider: "native" as const },
];

const envelope = <T,>(data: T) => ({
  schema_version: 1 as const,
  request_id: "req",
  freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" as const },
  data,
});

function gateway(browse: YouTubeCapabilityState = { state: "available" }): YouTubeResourcesGateway {
  return {
    getCapabilities: vi.fn((accountId: string) => Promise.resolve(envelope({
      account_id: accountId,
      channel_id: `UC-${accountId}`,
      channel_title: accountId,
      provider: "native" as const,
      connection: "ok" as const,
      scopes: { readonly: "granted" as const, upload: "granted" as const, force_ssl: "granted" as const },
      capabilities: { browse, upload: { state: "available" as const }, comments: { state: "available" as const } },
      quota: {
        provider_quota: "not_tracked" as const,
        unit_costs: { channel: 1 as const, videos_page: 1 as const, video: 1 as const },
        per_user_burst: { limit: 30 as const, window_seconds: 600 as const },
        per_user_daily: { limit: 300 as const, window_seconds: 86400 as const },
      },
    }))),
    getChannel: vi.fn((accountId: string) => Promise.resolve(envelope({
      id: `UC-${accountId}`, title: `Channel of ${accountId}`, description: "", custom_url: null, thumbnail_url: null,
      published_at: null, country: null, privacy_status: "public",
      statistics: { view_count: 1, subscriber_count: 1, subscriber_count_hidden: false, video_count: 1 },
    }))),
    listVideos: vi.fn(({ accountId }: { accountId: string }) => Promise.resolve(envelope({
      items: [{ id: `${accountId}-video`, title: `Video of ${accountId}`, thumbnail_url: null, published_at: null, privacy_status: "public", url: "https://www.youtube.com/watch?v=x" }],
      next_page_token: null,
      total_results: 1,
    }))),
    getVideo: vi.fn(({ videoId }: { accountId: string; videoId: string }) => Promise.resolve(envelope({
      id: videoId, channel_id: "UC", title: `Details of ${videoId}`, description: "", thumbnail_url: null, published_at: null,
      tags: [], category_id: null, default_language: null, duration_iso8601: null, privacy_status: "public",
      upload_status: null, made_for_kids: null, statistics: { view_count: null, like_count: null, comment_count: null },
      url: "https://www.youtube.com/watch?v=x",
    }))),
  };
}

async function renderScreen(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter><QueryClientProvider client={client}><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></QueryClientProvider></MemoryRouter>,
  );
}

describe("YouTubeManagementScreen", () => {
  it("invites a user with no YouTube channel to connect one", async () => {
    await renderScreen(<YouTubeManagementScreen accounts={[]} accountsLoading={false} gateway={gateway()} />);
    expect(screen.getByText("No YouTube channel is connected yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Profiles" })).toHaveAttribute("href", "/profiles");
  });

  it("loads the first channel, its videos, and the details of a picked video", async () => {
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={gateway()} />);
    expect(await screen.findByRole("heading", { name: "Channel of acc-a" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    expect(await screen.findByRole("heading", { name: "Details of acc-a-video" })).toBeInTheDocument();
  });

  it("drops the previous channel's video and details when the account changes", async () => {
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={gateway()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Video of acc-a/ }));
    await screen.findByRole("heading", { name: "Details of acc-a-video" });

    await userEvent.selectOptions(screen.getByLabelText("Channel"), "acc-b");

    expect(screen.queryByRole("heading", { name: "Details of acc-a-video" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Video of acc-a/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Video of acc-b/ })).toBeInTheDocument();
  });

  it("explains an unavailable browse capability and spends no provider call", async () => {
    const fake = gateway({ state: "unavailable", reason: "provider_unsupported" });
    await renderScreen(<YouTubeManagementScreen accounts={ACCOUNTS} accountsLoading={false} gateway={fake} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("managed connector");
    await waitFor(() => expect(fake.getCapabilities).toHaveBeenCalled());
    expect(fake.getChannel).not.toHaveBeenCalled();
    expect(fake.listVideos).not.toHaveBeenCalled();
  });
});
```

`tests/architecture.test.ts`: copy `src/features/instagram-insights/tests/architecture.test.ts` and change three things: `FEATURE_ROOT` to `"src/features/youtube-management"`, the `describe` title to `"youtube-management layering"`, and every occurrence of `InstagramPerformanceScreen` to `YouTubeManagementScreen`. There are three in that file: the test title, the `/ui/InstagramPerformanceScreen.tsx` `endsWith` exclusion and the `filesImportingInfrastructure` list. The copied test fails until all three are renamed.

- [ ] **Step 2: run and confirm they fail** (`npx vitest run src/features/youtube-management`).

- [ ] **Step 3: implement.**

```tsx
// ui/YouTubeManagementScreen.tsx
export interface YouTubeManagementScreenProps {
  accounts: readonly YouTubeAccountOption[];
  accountsLoading: boolean;
  gateway?: YouTubeResourcesGateway;       // defaults to defaultYouTubeResourcesGateway
}
export function YouTubeManagementScreen(props: YouTubeManagementScreenProps): JSX.Element;
```

Behaviour:
1. `selectedAccountId` state; when it is `null` or no longer in `accounts`, use `accounts[0]?.id ?? null`.
2. `selectedVideoId` state; the account change handler sets it to `null`.
3. `accountsLoading` shows a loading indicator. No accounts shows the empty state with a `Link` to `/profiles`.
4. `capabilities = useYouTubeCapabilities({ gateway, accountId })`. `browse = capabilities.data?.data.capabilities.browse`. `canBrowse = browse !== undefined && browse.state !== "unavailable"`.
5. `browse.state === "unavailable"` renders `<YouTubeResourceNotice code={browse.reason} ... />` (the reason names are error codes) and nothing below it.
6. `useYouTubeChannel`, `useYouTubeVideos` with `enabled: canBrowse`; `useYouTubeVideo` with `enabled: canBrowse && selectedVideoId !== null`.
7. For each of the four queries, an error renders `<YouTubeResourceNotice>` with `error instanceof YouTubeResourceError ? error.code : "upstream_unavailable"`, its `retryAfterSeconds`, and `onRetry={() => query.refetch()}`. An errored list never renders the library's empty text.
8. Videos are `videos.data?.pages.flatMap((page) => page.data.items) ?? []`.
9. A "Refresh" button refetches the channel and video queries of the selected account.

`index.ts`:

```ts
export * from "./domain/types";
export * from "./domain/errors";
export * from "./domain/accountOptions";
export * from "./application/ports";
export * from "./ui/YouTubeManagementScreen";
```

Keys to add to `src/i18n/locales/ar/accounts.json` under `youtubeManagement`:

| Key | English default | Arabic |
|---|---|---|
| `youtubeManagement.title` | YouTube channel | قناة YouTube |
| `youtubeManagement.subtitle` | Browse your channel and its uploaded videos. | تصفّح قناتك والفيديوهات المرفوعة عليها. |
| `youtubeManagement.noAccounts` | No YouTube channel is connected yet. | مفيش قناة YouTube مربوطة لسه. |
| `youtubeManagement.loading` | Loading… | جاري التحميل… |
| `youtubeManagement.refresh` | Refresh | تحديث |
| `youtubeManagement.detail.select` | Select a video to see its details. | اختار فيديو عشان تشوف تفاصيله. |

For the Profiles link, call the key that already exists in the bundle: `t("youtubeManagement.goToProfiles", "Open Profiles")`. Do not add it again. Every key in the table must be used by this task's screen.

- [ ] **Step 4: verify.**

```bash
npx vitest run src/features/youtube-management
npm run typecheck
npm run check:i18n
npx eslint src/features/youtube-management
```

- [ ] **Step 5: commit.**

```bash
git add src/features/youtube-management/ui/YouTubeManagementScreen.tsx src/features/youtube-management/ui/__tests__/YouTubeManagementScreen.test.tsx src/features/youtube-management/tests/architecture.test.ts src/features/youtube-management/index.ts src/i18n/locales/ar/accounts.json
git commit -m "feat(youtube-management): management screen and public API" -- src/features/youtube-management/ui/YouTubeManagementScreen.tsx src/features/youtube-management/ui/__tests__/YouTubeManagementScreen.test.tsx src/features/youtube-management/tests/architecture.test.ts src/features/youtube-management/index.ts src/i18n/locales/ar/accounts.json
```

## Task 2c-7: feature flag, page, route and sidebar entry

**Tier:** Medium (touches shared navigation and the flag registry in five existing files; the flag is a UI switch, not a permission).

**Files:** create `src/pages/youtube/YouTubeManagementPage.tsx` and `src/features/youtube-management/tests/wiring.test.tsx`. Modify `src/hooks/useFeatureFlags.tsx`, `src/components/admin/FeatureFlagIndicator.tsx`, `src/pages/admin/AdminFeatureFlags.tsx`, `src/components/AnimatedRoutes.tsx`, `src/components/layout/DashboardLayout.tsx`, `src/i18n/locales/ar/nav.json`.

**Fixed rules (every task):** never deploy and never apply anything to production; never run `npx supabase functions deploy`; never run `git add -A` or `git add .`; add no `eslint-disable` and no `any`; no live Google call in a test.

**Rules for this task:** this task is what makes the feature reachable; without it the modules are dead (ARCHITECTURE.md §1). The flag is `youtubeManagement` (database key `feature_youtube_management`), default `false`. No migration: `useFeatureFlags` falls back to `DEFAULT_FLAGS` when `app_settings` has no row, and the admin page upserts the row on the first toggle. The flag only hides UI; never rely on it for authorization. The page imports the feature only through `@/features/youtube-management` (no deep import). No `any`, no `eslint-disable`. Commit only the eight files.

- [ ] **Step 1: write the failing test** `src/features/youtube-management/tests/wiring.test.tsx`:

```tsx
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import YouTubeManagementPage from "@/pages/youtube/YouTubeManagementPage";

const flags = vi.hoisted(() => ({ youtubeManagement: true }));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags, isLoading: false }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [
      { id: "acc-yt", platform: "youtube", platform_username: "My channel", avatar_url: null, auth_provider: "native" },
      { id: "acc-ig", platform: "instagram", platform_username: "ig", avatar_url: null, auth_provider: "native" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/youtube-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/youtube-management")>()),
  YouTubeManagementScreen: ({ accounts }: { accounts: Array<{ id: string }> }) => (
    <div data-testid="youtube-screen">{accounts.map((account) => account.id).join(",")}</div>
  ),
}));

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/youtube"]}>
      <Routes>
        <Route path="/youtube" element={<YouTubeManagementPage />} />
        <Route path="/dashboard" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("YouTube management wiring", () => {
  it("the page hands only YouTube accounts to the feature's public screen", () => {
    flags.youtubeManagement = true;
    renderAt();
    expect(screen.getByTestId("youtube-screen")).toHaveTextContent("acc-yt");
    expect(screen.getByTestId("youtube-screen")).not.toHaveTextContent("acc-ig");
  });

  it("the page sends a user without the flag to the dashboard", () => {
    flags.youtubeManagement = false;
    renderAt();
    expect(screen.getByText("dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("youtube-screen")).not.toBeInTheDocument();
  });

  it("the application registers the route and a flag-gated sidebar entry", () => {
    const routes = readFileSync("src/components/AnimatedRoutes.tsx", "utf8");
    expect(routes).toContain('import("@/pages/youtube/YouTubeManagementPage")');
    expect(routes).toContain('path="/youtube"');
    const layout = readFileSync("src/components/layout/DashboardLayout.tsx", "utf8");
    expect(layout).toMatch(/flags\.youtubeManagement \? \[\{[^\]]*path: "\/youtube"/);
  });
});
```

- [ ] **Step 2: run and confirm it fails** (`npx vitest run src/features/youtube-management/tests/wiring.test.tsx`): the page does not exist.

- [ ] **Step 3: add the flag.** Mirror the existing flag `analyticsTiktok` / `feature_analytics_tiktok`. Run `git grep -n "analyticsTiktok\|feature_analytics_tiktok" -- src` and add a matching `youtubeManagement` / `feature_youtube_management` line next to every hit in these places:
  - `src/hooks/useFeatureFlags.tsx`: the `FeatureFlags` interface (`youtubeManagement: boolean;`), `DEFAULT_FLAGS` (`false`), `FLAG_KEYS` (`"feature_youtube_management"`), `FLAG_KEY_MAP` (`feature_youtube_management: "youtubeManagement"`), `FEATURE_DISPLAY_NAMES` (`"YouTube Channel"`), `ALL_FLAGS_ENABLED` (`true`), and the `baseFromDb` object (`youtubeManagement: globalFlagMap["feature_youtube_management"] ?? DEFAULT_FLAGS.youtubeManagement,`).
  - `src/components/admin/FeatureFlagIndicator.tsx`: `FLAG_LABELS` (`youtubeManagement: "YouTube Channel"`).
  - `src/pages/admin/AdminFeatureFlags.tsx`: one entry in the feature list (`{ key: "feature_youtube_management", label: "YouTube Channel", description: "Show the YouTube channel browser in the sidebar", icon: Music }`, using an icon the file already imports). Do NOT look for a category map in this file: `AdminFeatureFlags.tsx` builds its categories from the `app_settings` row `feature_flag_categories`, which is edited in the admin UI, and sends unlisted flags to "Uncategorized". The new flag therefore starts as "Uncategorized"; after enabling it, the owner assigns the "Analytics" category in Admin → Feature Flags (this is a manual step recorded in the PR body, not code).
  - The `DashboardLayout.tsx` hit is handled in step 5.

- [ ] **Step 4: create the page** `src/pages/youtube/YouTubeManagementPage.tsx`:

```tsx
import { useMemo } from "react";
import { Navigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { toYouTubeAccountOptions, YouTubeManagementScreen } from "@/features/youtube-management";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";

export default function YouTubeManagementPage() {
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { data: accounts = [], isLoading } = useSocialAccounts();
  const options = useMemo(() => toYouTubeAccountOptions(accounts), [accounts]);

  if (!flagsLoading && !flags.youtubeManagement) return <Navigate to="/dashboard" replace />;
  return (
    <DashboardLayout>
      <YouTubeManagementScreen accounts={options} accountsLoading={isLoading || flagsLoading} />
    </DashboardLayout>
  );
}
```

- [ ] **Step 5: register the route and the sidebar entry.**
  - `src/components/AnimatedRoutes.tsx`: next to the `CommentManagerPage` lazy import add `const YouTubeManagementPage = lazyWithRetry(() => import("@/pages/youtube/YouTubeManagementPage"), "YouTubeManagementPage");` and next to the `/comments` route add `<Route path="/youtube" element={<ProtectedRoute><AnimatedPage><YouTubeManagementPage /></AnimatedPage></ProtectedRoute>} />`.
  - `src/components/layout/DashboardLayout.tsx`: in `navEntries`, inside the initial `entries` array directly after the `Users` link (`path: "/profiles"`), add `...(flags.youtubeManagement ? [{ type: "link" as const, icon: Video, label: t("sidebar.youtubeManagement", "YouTube Channel"), path: "/youtube" }] : []),` and add `flags.youtubeManagement` to that `useMemo` dependency array. `Video` is already imported in the file.
  - `src/i18n/locales/ar/nav.json`: under `"sidebar"` add `"youtubeManagement": "قناة YouTube"` in alphabetical position.

- [ ] **Step 6: verify.**

```bash
npx vitest run src/features/youtube-management
npm run typecheck
npm run check:i18n
npx eslint src/features/youtube-management src/pages/youtube src/hooks/useFeatureFlags.tsx src/components/AnimatedRoutes.tsx src/components/layout/DashboardLayout.tsx
git grep -n "YouTubeManagementScreen" -- src/pages    # the production call site
```

- [ ] **Step 7: commit.**

```bash
git add src/pages/youtube/YouTubeManagementPage.tsx src/features/youtube-management/tests/wiring.test.tsx src/hooks/useFeatureFlags.tsx src/components/admin/FeatureFlagIndicator.tsx src/pages/admin/AdminFeatureFlags.tsx src/components/AnimatedRoutes.tsx src/components/layout/DashboardLayout.tsx src/i18n/locales/ar/nav.json
git commit -m "feat(youtube-management): flagged page, route and sidebar entry" -- src/pages/youtube/YouTubeManagementPage.tsx src/features/youtube-management/tests/wiring.test.tsx src/hooks/useFeatureFlags.tsx src/components/admin/FeatureFlagIndicator.tsx src/pages/admin/AdminFeatureFlags.tsx src/components/AnimatedRoutes.tsx src/components/layout/DashboardLayout.tsx src/i18n/locales/ar/nav.json
```

## Task 2c-8: pull request for stage 2c (orchestrator)

**Tier:** Medium (frontend only; no auth rule, money or migration).

- [ ] Inspect the full diff, run `clean-code-guard` and `test-guard`. Run `npm run test`, `npm run typecheck`, `npm run check:i18n`, `npm run lint` and `npm run build`.
- [ ] `git push origin HEAD:T3-CODE/youtube-stage2c-management-ui`. PR title `feat(youtube): channel browser page (stage 2c)`. The body states "Tier: MEDIUM", names the production call sites (`src/pages/youtube/YouTubeManagementPage.tsx` renders `YouTubeManagementScreen`; `src/components/AnimatedRoutes.tsx` registers `/youtube`), states that the flag is off by default, and ends with the Claude Code attribution line.
- [ ] Merge on green CI for the exact head commit and after the review rounds of the tier.
- [ ] After the frontend deploys: confirm a non-admin session can read `feature_youtube_management` from `app_settings` once the owner has toggled it; open `/youtube` with the flag on and walk the acceptance checklist of the spec (section 11).
- [ ] Update `CLAUDE.md` "Pages" with `/youtube` in a follow-up docs commit if the owner wants it listed.

---

## If a decision changes

| Decision (spec) | Other option | What changes in this plan |
|---|---|---|
| D1 cache | Database cache | New Heavy task before 2b-3: migration, RLS, SQL suite in `scripts/db-harness.sh`, a cache port in `handler.ts`. Apply the migration to prod before merging 2b. A retention decision is required first |
| D2 list fields | Duration and views in the list | 2b-1 adds two fields to `YouTubeVideoListItem`; 2b-2 makes `listUploads` call `videos.list` for the page's IDs; 2c-5 shows them; every page costs 2 units and `unit_costs.videos_page` becomes 2 |
| D3 Composio | Hide Composio accounts | 2c-1 `toYouTubeAccountOptions` drops `auth_provider === "composio"`; the `provider_unsupported` notice key in 2c-4 is removed |
| D4 guard | Project ledger | New Heavy migration task; 2b-3 and 2b-6 replace `rateLimit` with a ledger port |
| D4 guard | No guard | Remove `rateLimit` from 2b-3 and 2b-6 and the `rate_limited` tests and notice key |
| D5 unknown scopes | Refuse and ask to reconnect | 2a-2 rule 1 returns `unavailable/missing_scope` for an empty recorded list; the 2b-3 test "allowed to try" becomes a 403 test |
| D6 gating | Reuse `feature_tab_youtube` or no flag | 2c-7 step 3 disappears; the page and the sidebar use `flags.tabYoutube` or no condition |
| D7 PRs | One or two PRs | Only the PR tasks and branch names change |
| D8 playlists | Include playlists | Three new tasks: `listPlaylists` in the read client, a `playlists` operation in the handler, a list in the UI |

## Review gate for every stage

After the implementer finishes a stage, the orchestrator inspects the full diff, runs the Deno and Vitest suites itself, runs the guard skills, reads every bot comment, and merges only on green CI for the exact head commit. Findings that are right are fixed in one consolidated push per round.
