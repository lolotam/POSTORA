# YouTube Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give YouTube channels (native Google OAuth and Composio-managed) the Comment Manager tile, the AI agent surface, and comment-workflow funnels, fed by a 5-minute poller, so the feature is live on postora.cloud and recordable for Google's `youtube.force-ssl` verification.

**Architecture:** One provider adapter (`_shared/youtubeComments.ts`) hides native-vs-Composio behind six operations; a new `youtube-poll-comments` cron function normalises `commentThreads.list` into the existing `social_inbox_events` → workflow → agent pipeline through a platform-neutral copy of the Threads ingest door; the three UI surfaces widen their platform unions and read a pure capability rule (`youtubeCommentCapability`) to show "reconnect" instead of a broken channel.

**Tech Stack:** Deno edge functions (Supabase self-hosted), YouTube Data API v3, Composio REST v3.1 (`toolkitVersion 20260721_00`), React 18 + TanStack Query + vitest/RTL (fireEvent only), Postgres migrations rehearsed on `scripts/db-harness.sh`.

**Spec:** `docs/superpowers/specs/2026-09-04-youtube-comments-design.md` — read it first; every task below cites its section.

## Global Constraints

- Worktree: `F:\Postora-comment-workflow`, branch `feat/youtube-comments` (off `main` at `65f8c9f9`). Never touch `F:\Postora_new`'s HEAD.
- Commit per task, scoped: `git commit -- <files>`. Never commit `b64.txt`, logs, backups, `.env*`, secrets. Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UUCnMriAJafsYQyfFFaeRM
  ```
- Deno tests: `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto <path>` (CI shape). Run `deno check <file>` on every new edge module too: `--no-check` hides type errors. Run Deno **before** `bun install`/vitest: `--node-modules-dir=auto` breaks vitest's `node_modules`.
- Frontend gates: `bun run test` (vitest), `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`, `bun run lint`, `bun run build`. `userEvent` is unusable in this repo; use `fireEvent`. Radix `SelectContent` does not render in jsdom.
- Scope string: `https://www.googleapis.com/auth/youtube.force-ssl`. Composio tool slugs (all exist at `20260721_00`, probed 2026-09-04): `YOUTUBE_LIST_COMMENT_THREADS`, `YOUTUBE_LIST_COMMENTS`, `YOUTUBE_CREATE_COMMENT_REPLY`, `YOUTUBE_SET_COMMENT_MODERATION_STATUS`, `YOUTUBE_DELETE_COMMENT`, `YOUTUBE_GET_VIDEO_DETAILS_BATCH`, `YOUTUBE_LIST_PLAYLIST_ITEMS`. Never invent another.
- Poll cadence `*/5 * * * *`; one `commentThreads.list` per channel per run, `maxResults=50`.
- Known sweep limits, to be stated in code comments where the sweep is built (Task 7) and in the runbook: only the ≤5 replies YouTube inlines per thread are ingested, and `order=time` sorts by the top-level comment's time, so a new reply on a thread older than the newest 50 is not seen by the sweep (the Comment Manager still shows it on demand).
- Copy: account noun for YouTube is **channel**; reconnect line "Reconnect this channel on Profiles to enable comments"; delete refusal "YouTube only lets you delete your own comments — hide it instead."; no-DM line "YouTube has no private messages — this workflow replies publicly only."
- Feature flag `feature_youtube_comments` ↔ `flags.youtubeComments`, default `false`.
- Health columns (`needs_reauth`, `failure_count`, `last_refresh_error`) are written only on a failed token refresh (`invalid_grant`), never on a scope or quota error.
- Delegation lanes: Tasks 10–11 (migration + harness) → OpenCode Muse Spark; code tasks → Codex `gpt-5.6-sol` medium, or Claude subagents in isolated worktrees if the Codex window is closed. Every brief names `ARCHITECTURE.md` as required reading. The orchestrator reviews, runs `clean-code-guard` / `test-guard` / `docs-guard`, commits and lands.

---

## File map

| Path | Responsibility |
|---|---|
| `supabase/functions/_shared/youtubeCommentCapability.ts` (+ `.test.ts`) | pure: capable vs reconnect_required; scope helpers |
| `src/lib/youtubeCommentCapability.ts` (+ `__tests__`) | identical client copy |
| `supabase/functions/_shared/youtubePollEligibility.ts` (+ `.test.ts`) | pure: which rows to poll, composio-over-native dedupe |
| `supabase/functions/_shared/youtubeApiErrors.ts` (+ `.test.ts`) | pure: Google/Composio error → class |
| `supabase/functions/_shared/youtubeGrantedScopes.ts` | persist `granted_scopes` into `account_metadata` (merge, never overwrite) |
| `supabase/functions/youtube-oauth/index.ts` | three scopes; record scopes on connect and refresh |
| `supabase/functions/_shared/social-auth.ts` | `refreshYouTubeToken` returns `scope` |
| `supabase/functions/_shared/connectorRegistry.ts` | seven comment tools on the youtube entry |
| `supabase/functions/_shared/youtubeComments.ts` (+ `.test.ts`) | the provider adapter (native + Composio) |
| `supabase/functions/_shared/youtubeCommentNormalize.ts` (+ `.test.ts`) | `commentThreads.list` items → `CommentPayloadInput` shapes + Comment Manager shape |
| `supabase/functions/_shared/commentActions.ts` (+ test) | youtube branch + unknown-platform refusal |
| `supabase/functions/_shared/commentAuthor.ts` (+ test) | youtube own-comment rule |
| `supabase/functions/_shared/n8nMessagingDispatch.ts` | `CommentPlatform` adds youtube |
| `supabase/functions/_shared/commentPlatforms.ts` (+ `.test.ts`) | `platformSupportsPrivateReply` shared by workflow + form copy (server side) |
| `supabase/functions/_shared/commentWorkflow.ts` | uses `platformSupportsPrivateReply` |
| `supabase/functions/_shared/polledCommentIngest.ts` | platform-neutral ingest door (extracted from threadsCommentIngest) |
| `supabase/functions/_shared/threadsCommentIngest.ts` | thin caller, unchanged API |
| `supabase/functions/youtube-poll-comments/index.ts` (+ `poll.ts`, `poll.test.ts`) | the cron function |
| `supabase/functions/comment-manager/index.ts` | `get_youtube_comments`, `get_youtube_videos`, token-less Composio rows |
| `supabase/functions/messaging-api/index.ts` | allow-list |
| `supabase/functions/n8n-api/index.ts` | `comment.youtube` |
| `supabase/migrations/20260904150000_youtube_comments.sql` | CHECKs, constraint, cron, flag |
| `supabase/tests/youtube_comments.sql` + `scripts/db-harness.sh` | harness suite |
| `src/hooks/useSocialAccounts.tsx` | `auth_provider` on the interface |
| `src/hooks/useFeatureFlags.tsx`, `src/components/admin/FeatureFlagIndicator.tsx` | flag plumbing |
| `src/hooks/useCommentInbox.ts` (+ test) | youtube parse + query |
| `src/components/comments/CommentManagerPanel.tsx`, `CommentActions.tsx`, `src/pages/comments/CommentManagerPage.tsx` (+ tests) | tile, picker, banner, actions |
| `src/hooks/useAiAgentConfig.ts`, `src/hooks/useMessengerAutoReplies.ts`, `src/components/messaging/AutomationHandlerCard.tsx`, `AutoReplyManager.tsx`, `src/pages/automation/UnifiedAgentSetupPage.tsx` | agent surface |
| `src/features/comment-workflow/**` | platform union, copy, capability-aware picker, video list |
| `src/pages/admin/oauth-verification/checklist-data/google.ts`, `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`, `docs/OAUTH-TOKEN-REFRESH-GUIDE.md`, `API_REFERENCE.md`, `src/pages/Privacy.tsx`, `CLAUDE.md`, `docs/runbooks/youtube-comments-rollout.md` | docs |

---

## Slice A — backend foundation (Deno)

### Task 1: Capability rule (shared + client copy)

**Files:**
- Create: `supabase/functions/_shared/youtubeCommentCapability.ts`
- Create: `supabase/functions/_shared/youtubeCommentCapability.test.ts`
- Create: `src/lib/youtubeCommentCapability.ts`
- Create: `src/lib/__tests__/youtubeCommentCapability.test.ts`

**Interfaces:**
- Produces: `YOUTUBE_COMMENT_SCOPE: string`, `type YouTubeCommentCapability = "capable" | "reconnect_required"`, `grantedScopes(metadata: unknown): string[]`, `youtubeCommentCapability(account: { auth_provider?: string | null; account_metadata?: unknown }): YouTubeCommentCapability`, `splitScopeString(scope: unknown): string[]`. Same names in both copies.

- [ ] **Step 1: Write the failing Deno test**

```ts
// supabase/functions/_shared/youtubeCommentCapability.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { grantedScopes, splitScopeString, YOUTUBE_COMMENT_SCOPE, youtubeCommentCapability } from "./youtubeCommentCapability.ts";

// The production shape on 2026-09-04: four native rows with `{}` metadata (connected before
// scopes were recorded) and one Composio row. Both providers must be judged by what they can
// actually do, not by whether a token column is filled — Composio rows have none.
const cases: Array<[string, Parameters<typeof youtubeCommentCapability>[0], string]> = [
  ["composio row is capable regardless of metadata", { auth_provider: "composio", account_metadata: {} }, "capable"],
  ["native row with force-ssl granted", { auth_provider: "native", account_metadata: { granted_scopes: ["https://www.googleapis.com/auth/youtube.upload", YOUTUBE_COMMENT_SCOPE] } }, "capable"],
  ["native row connected before scopes were recorded", { auth_provider: "native", account_metadata: {} }, "reconnect_required"],
  ["native row with the old two scopes", { auth_provider: "native", account_metadata: { granted_scopes: ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"] } }, "reconnect_required"],
  ["auth_provider absent means native", { account_metadata: null }, "reconnect_required"],
];

for (const [name, account, expected] of cases) {
  Deno.test(`youtubeCommentCapability: ${name}`, () => assertEquals(youtubeCommentCapability(account), expected));
}

Deno.test("grantedScopes ignores malformed metadata", () => {
  assertEquals(grantedScopes(null), []);
  assertEquals(grantedScopes({ granted_scopes: "not-an-array" }), []);
  assertEquals(grantedScopes({ granted_scopes: ["a", 1, "b"] }), ["a", "b"]);
});

Deno.test("splitScopeString splits Google's space-separated scope field", () => {
  assertEquals(splitScopeString(" a  b "), ["a", "b"]);
  assertEquals(splitScopeString(undefined), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test --allow-env --allow-read --no-check --node-modules-dir=auto supabase/functions/_shared/youtubeCommentCapability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/youtubeCommentCapability.ts
// Whether a YouTube row can read and write comments. Every comment endpoint needs
// youtube.force-ssl (probed 2026-09-04: a readonly+upload token gets 403 insufficientPermissions
// even on commentThreads.list). Composio's managed Google app already holds that scope, so a
// Composio row is capable by construction; a native row is capable only if the scope was
// recorded when it connected or refreshed — rows connected before that recording existed carry
// `{}` and must reconnect.
export const YOUTUBE_COMMENT_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

export type YouTubeCommentCapability = "capable" | "reconnect_required";

export interface YouTubeCapabilityAccount {
  auth_provider?: string | null;
  account_metadata?: unknown;
}

export function grantedScopes(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).granted_scopes;
  return Array.isArray(raw) ? raw.filter((scope): scope is string => typeof scope === "string") : [];
}

export function splitScopeString(scope: unknown): string[] {
  return typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [];
}

export function youtubeCommentCapability(account: YouTubeCapabilityAccount): YouTubeCommentCapability {
  if (account.auth_provider === "composio") return "capable";
  return grantedScopes(account.account_metadata).includes(YOUTUBE_COMMENT_SCOPE) ? "capable" : "reconnect_required";
}
```

`src/lib/youtubeCommentCapability.ts` is the same file with the import extension dropped (no `.ts`), and `src/lib/__tests__/youtubeCommentCapability.test.ts` is the same table using `describe/it/expect` from vitest (`it.each(cases)`).

- [ ] **Step 4: Run both tests**

Run the Deno command above, then `bun run test -- src/lib/__tests__/youtubeCommentCapability.test.ts`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/youtubeCommentCapability.ts supabase/functions/_shared/youtubeCommentCapability.test.ts src/lib/youtubeCommentCapability.ts src/lib/__tests__/youtubeCommentCapability.test.ts
git commit -m "feat(youtube): capability rule for comments, shared and client"
```

---

### Task 2: Poll eligibility and error classification (pure)

**Files:**
- Create: `supabase/functions/_shared/youtubePollEligibility.ts` (+ `.test.ts`)
- Create: `supabase/functions/_shared/youtubeApiErrors.ts` (+ `.test.ts`)

**Interfaces:**
- Consumes: `youtubeCommentCapability`, `resolveCommentAutomationHandler` (`_shared/automationHandler.ts`).
- Produces:
  ```ts
  export interface PollCandidate { id: string; user_id: string; platform_user_id: string | null; auth_provider?: string | null; account_metadata?: unknown }
  export interface PollSelection<T> { eligible: T[]; skipped: { handler_off: number; reconnect_required: number; duplicate_channel: number } }
  export function selectPollableChannels<T extends PollCandidate>(rows: readonly T[]): PollSelection<T>
  export type YouTubeErrorClass = "scope_missing" | "quota" | "unauthorized" | "not_found" | "forbidden" | "upstream"
  export function classifyGoogleError(status: number, body: unknown): YouTubeErrorClass
  export function classifyComposioError(message: string | undefined): YouTubeErrorClass
  ```

- [ ] **Step 1: Failing tests**

```ts
// supabase/functions/_shared/youtubePollEligibility.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { selectPollableChannels } from "./youtubePollEligibility.ts";

const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, user_id: "u1", platform_user_id: "UC1", auth_provider: "native",
  account_metadata: { comment_automation_handler: "internal", granted_scopes: SCOPES }, ...over,
});

Deno.test("polls capable channels whose handler is on, and counts what it left out", () => {
  const selection = selectPollableChannels([
    row("ok"),
    row("off", { account_metadata: { comment_automation_handler: "off", granted_scopes: SCOPES } }),
    row("unset", { account_metadata: { granted_scopes: SCOPES } }), // handler absent resolves to off
    row("stale", { platform_user_id: "UC2", account_metadata: { comment_automation_handler: "n8n" } }),
  ]);
  assertEquals(selection.eligible.map((r) => r.id), ["ok"]);
  assertEquals(selection.skipped, { handler_off: 2, reconnect_required: 1, duplicate_channel: 0 });
});

// Production 2026-09-04: channel UCGDSIW3C… exists as a native and a Composio row for the same
// user. Polling both would ingest every comment twice under two social_account_ids, and the
// inbox unique key is per account, so nothing downstream would dedupe it.
Deno.test("one row per user+channel, preferring the Composio row", () => {
  const selection = selectPollableChannels([
    row("native"),
    row("composio", { auth_provider: "composio", account_metadata: { comment_automation_handler: "internal" } }),
    row("other-user", { user_id: "u2" }),
  ]);
  assertEquals(selection.eligible.map((r) => r.id), ["composio", "other-user"]);
  assertEquals(selection.skipped.duplicate_channel, 1);
});

Deno.test("a row with no channel id is never polled", () => {
  assertEquals(selectPollableChannels([row("x", { platform_user_id: null })]).eligible, []);
});
```

```ts
// supabase/functions/_shared/youtubeApiErrors.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { classifyComposioError, classifyGoogleError } from "./youtubeApiErrors.ts";

const google = (reason: string, code = 403) => ({ error: { code, message: "x", errors: [{ reason, domain: "youtube" }] } });

// Three 403s that must be told apart: one means reconnect, one means wait, one means the
// comment is not ours. Treating any of them as an expired token would flip needs_reauth on a
// healthy channel — the Meta false-reauth incident, again.
const cases: Array<[number, unknown, string]> = [
  [403, google("insufficientPermissions"), "scope_missing"],
  [403, google("quotaExceeded"), "quota"],
  [403, google("dailyLimitExceeded"), "quota"],
  [429, google("rateLimitExceeded", 429), "quota"],
  [401, google("authError", 401), "unauthorized"],
  [404, google("commentNotFound", 404), "not_found"],
  [403, google("forbidden"), "forbidden"],
  [500, {}, "upstream"],
  [200, null, "upstream"],
];
for (const [status, body, expected] of cases) {
  Deno.test(`classifyGoogleError ${status} ${JSON.stringify(body)?.slice(0, 40)} -> ${expected}`, () =>
    assertEquals(classifyGoogleError(status, body), expected));
}

Deno.test("classifyComposioError reads the Google reason out of Composio's message", () => {
  assertEquals(classifyComposioError('Request had insufficient authentication scopes. {"reason":"insufficientPermissions"}'), "scope_missing");
  assertEquals(classifyComposioError("The request cannot be completed because you have exceeded your quota."), "quota");
  assertEquals(classifyComposioError("401 Unauthorized: invalid_grant"), "unauthorized");
  assertEquals(classifyComposioError(undefined), "upstream");
});
```

- [ ] **Step 2: Run, expect module-not-found failures.**

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/youtubePollEligibility.ts
import { resolveCommentAutomationHandler } from "./automationHandler.ts";
import { youtubeCommentCapability } from "./youtubeCommentCapability.ts";

export interface PollCandidate {
  id: string;
  user_id: string;
  platform_user_id: string | null;
  auth_provider?: string | null;
  account_metadata?: unknown;
}

export interface PollSelection<T> {
  eligible: T[];
  skipped: { handler_off: number; reconnect_required: number; duplicate_channel: number };
}

// Which YouTube rows a sweep reads. Handler-off rows would spend quota to reach a handler that
// discards the result; reconnect_required rows would 403 on every call; and the same channel
// held twice by one user (native + Composio) must be read once — through Composio, which
// costs Postora's Google project nothing and needs no token refresh.
export function selectPollableChannels<T extends PollCandidate>(rows: readonly T[]): PollSelection<T> {
  const skipped = { handler_off: 0, reconnect_required: 0, duplicate_channel: 0 };
  const byChannel = new Map<string, T>();

  for (const row of rows) {
    if (!row.platform_user_id) continue;
    if (resolveCommentAutomationHandler(row.account_metadata) === "off") { skipped.handler_off += 1; continue; }
    if (youtubeCommentCapability(row) !== "capable") { skipped.reconnect_required += 1; continue; }

    const key = `${row.user_id}:${row.platform_user_id}`;
    const held = byChannel.get(key);
    if (!held) { byChannel.set(key, row); continue; }
    skipped.duplicate_channel += 1;
    if (row.auth_provider === "composio" && held.auth_provider !== "composio") byChannel.set(key, row);
  }

  return { eligible: [...byChannel.values()], skipped };
}
```

```ts
// supabase/functions/_shared/youtubeApiErrors.ts
export type YouTubeErrorClass = "scope_missing" | "quota" | "unauthorized" | "not_found" | "forbidden" | "upstream";

const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"]);

function firstReason(body: unknown): string {
  const errors = (body as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error?.errors;
  return Array.isArray(errors) && typeof errors[0]?.reason === "string" ? errors[0].reason : "";
}

export function classifyGoogleError(status: number, body: unknown): YouTubeErrorClass {
  const reason = firstReason(body);
  if (reason === "insufficientPermissions") return "scope_missing";
  if (status === 429 || QUOTA_REASONS.has(reason)) return "quota";
  if (status === 401 || reason === "authError") return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 403) return "forbidden";
  return "upstream";
}

// Composio surfaces the upstream failure as one string; the Google reason is usually inside it.
export function classifyComposioError(message: string | undefined): YouTubeErrorClass {
  const text = message ?? "";
  if (/insufficientPermissions|insufficient authentication scopes/i.test(text)) return "scope_missing";
  if (/quota|rateLimitExceeded|dailyLimitExceeded/i.test(text)) return "quota";
  if (/\b401\b|unauthori[sz]ed|invalid_grant|authError/i.test(text)) return "unauthorized";
  if (/\b404\b|not ?found/i.test(text)) return "not_found";
  if (/\b403\b|forbidden/i.test(text)) return "forbidden";
  return "upstream";
}
```

- [ ] **Step 4: Run both test files; expect PASS. Run `deno check` on both modules.**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/youtubePollEligibility.ts supabase/functions/_shared/youtubePollEligibility.test.ts supabase/functions/_shared/youtubeApiErrors.ts supabase/functions/_shared/youtubeApiErrors.test.ts
git commit -m "feat(youtube): poll eligibility with channel dedupe, and API error classes"
```

---

### Task 3: Record granted scopes; request `force-ssl` on connect

**Files:**
- Create: `supabase/functions/_shared/youtubeGrantedScopes.ts` (+ `.test.ts`)
- Modify: `supabase/functions/youtube-oauth/index.ts` (scopes L150-153; exchange L364-368; upsert L404-428; refresh L241-275)
- Modify: `supabase/functions/_shared/social-auth.ts:126-160`

**Interfaces:**
- Produces: `recordGrantedScopes(admin, accountId: string, scope: unknown): Promise<void>` (merge into `account_metadata.granted_scopes`), `dropGrantedScope(admin, accountId: string, scope: string): Promise<void>`. `refreshYouTubeToken` returns `{ access_token, expires_in, scope?: string }`.

- [ ] **Step 1: Failing test**

```ts
// supabase/functions/_shared/youtubeGrantedScopes.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { dropGrantedScope, recordGrantedScopes } from "./youtubeGrantedScopes.ts";

function fakeAdmin(existing: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { account_metadata: existing }, error: null }) }) }),
      update: (patch: Record<string, unknown>) => { writes.push(patch); return { eq: () => Promise.resolve({ error: null }) }; },
    }),
  };
}

// A reconnect must not wipe comment_automation_handler: the metadata is merged, and the
// scope list replaces only itself.
Deno.test("recordGrantedScopes merges into existing metadata", async () => {
  const admin = fakeAdmin({ comment_automation_handler: "internal", granted_scopes: ["old"] });
  await recordGrantedScopes(admin, "acc", "a b");
  assertEquals(admin.writes[0].account_metadata, { comment_automation_handler: "internal", granted_scopes: ["a", "b"] });
});

Deno.test("recordGrantedScopes writes nothing for an empty scope field", async () => {
  const admin = fakeAdmin({});
  await recordGrantedScopes(admin, "acc", undefined);
  assertEquals(admin.writes, []);
});

Deno.test("dropGrantedScope removes one scope and keeps the rest", async () => {
  const admin = fakeAdmin({ granted_scopes: ["a", "b"] });
  await dropGrantedScope(admin, "acc", "b");
  assertEquals(admin.writes[0].account_metadata, { granted_scopes: ["a"] });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/youtubeGrantedScopes.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { grantedScopes, splitScopeString } from "./youtubeCommentCapability.ts";

async function readMetadata(admin: any, accountId: string): Promise<Record<string, unknown>> {
  const { data, error } = await admin.from("social_accounts").select("account_metadata").eq("id", accountId).maybeSingle();
  if (error) throw new Error(`granted_scopes read failed: ${error.message}`);
  const metadata = data?.account_metadata;
  return metadata && typeof metadata === "object" ? { ...(metadata as Record<string, unknown>) } : {};
}

async function writeScopes(admin: any, accountId: string, scopes: string[]): Promise<void> {
  const metadata = await readMetadata(admin, accountId);
  const { error } = await admin.from("social_accounts")
    .update({ account_metadata: { ...metadata, granted_scopes: scopes }, updated_at: new Date().toISOString() })
    .eq("id", accountId);
  if (error) throw new Error(`granted_scopes write failed: ${error.message}`);
}

/** Google returns `scope` on every token response; this is the only place it is kept. */
export async function recordGrantedScopes(admin: any, accountId: string, scope: unknown): Promise<void> {
  const scopes = splitScopeString(scope);
  if (scopes.length === 0) return;
  await writeScopes(admin, accountId, scopes);
}

/** Self-heal after a 403 insufficientPermissions: the row flips to reconnect_required. */
export async function dropGrantedScope(admin: any, accountId: string, scope: string): Promise<void> {
  const metadata = await readMetadata(admin, accountId);
  await writeScopes(admin, accountId, grantedScopes(metadata).filter((granted) => granted !== scope));
}
```

Then in `youtube-oauth/index.ts`:

```ts
// L150-153
const scopes = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
  // Comments: commentThreads.list, comments.insert, setModerationStatus, delete all require it.
  "https://www.googleapis.com/auth/youtube.force-ssl",
].join(" ");

// L364-368: keep the scope field
const { access_token, refresh_token, expires_in, scope } = tokenData as {
  access_token: string; refresh_token?: string; expires_in: number; scope?: string;
};

// upsert: add `.select("id").single()` and then
const { data: savedAccount, error: dbError } = await supabase.from("social_accounts").upsert({ ...same fields... }, { onConflict: "user_id,platform,platform_user_id" }).select("id").single();
if (dbError) { ...existing handling... }
await recordGrantedScopes(supabase, savedAccount.id, scope);

// refresh action: after the update succeeds
await recordGrantedScopes(supabase, accountId, tokenData.scope);
```

`social-auth.ts` `refreshYouTubeToken`: return `{ access_token: data.access_token, expires_in: data.expires_in || 3600, scope: typeof data.scope === "string" ? data.scope : undefined }` and widen the return type.

- [ ] **Step 4: Run the new test; `deno check supabase/functions/youtube-oauth/index.ts supabase/functions/_shared/social-auth.ts`. Run the existing `youtube-oauth` tests if any (`ls supabase/functions/youtube-oauth/*.test.ts`).**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/youtubeGrantedScopes.ts supabase/functions/_shared/youtubeGrantedScopes.test.ts supabase/functions/youtube-oauth/index.ts supabase/functions/_shared/social-auth.ts
git commit -m "feat(youtube-oauth): request force-ssl and record granted scopes on connect and refresh"
```

---

### Task 4: Provider adapter `youtubeComments.ts`

**Files:**
- Create: `supabase/functions/_shared/youtubeComments.ts` (+ `.test.ts`)
- Modify: `supabase/functions/_shared/connectorRegistry.ts:643-651`

**Interfaces:**
- Consumes: `refreshYouTubeToken`, `recordGrantedScopes`, `dropGrantedScope`, `classifyGoogleError`, `classifyComposioError`, `ComposioClient.executeTool`, `loadActiveConnection`, `withConnectorCall`, `composioBinding("youtube")`, `YOUTUBE_COMMENT_SCOPE`.
- Produces:
  ```ts
  export interface YouTubeCommentAccount {
    id: string; user_id: string; platform: string; auth_provider?: string | null;
    access_token: string | null; refresh_token?: string | null; token_expires_at?: string | null;
    platform_user_id?: string | null; connection_id?: string | null; workspace_id?: string | null;
    account_metadata?: Record<string, unknown> | null;
  }
  export interface YouTubeCommentsDeps { admin: any; fetcher?: typeof fetch; composio?: ComposioClient | null; now?: () => number }
  export type YouTubeResult<T> = { ok: true; value: T } | { ok: false; kind: YouTubeErrorClass; message: string }
  export interface YouTubeCommentItem { id: string; videoId: string; parentId: string | null; text: string; authorChannelId: string | null; authorName: string; authorAvatar: string | null; publishedAt: string; likeCount: number; moderationStatus: string | null }
  export interface YouTubeThreadItem extends YouTubeCommentItem { totalReplyCount: number; replies: YouTubeCommentItem[] }
  export function listThreads(account, deps, args: { channelId?: string; videoId?: string; pageToken?: string; maxResults?: number }): Promise<YouTubeResult<{ items: YouTubeThreadItem[]; nextPageToken: string | null }>>
  export function listReplies(account, deps, parentId: string): Promise<YouTubeResult<YouTubeCommentItem[]>>
  export function replyToThread(account, deps, parentId: string, text: string): Promise<YouTubeResult<{ id: string }>>
  export function setModerationStatus(account, deps, commentId: string, status: "published" | "heldForReview" | "rejected"): Promise<YouTubeResult<void>>
  export function deleteOwnComment(account, deps, commentId: string): Promise<YouTubeResult<void>>
  export function videoTitles(account, deps, videoIds: string[]): Promise<YouTubeResult<Map<string, { title: string; thumbnail: string | null }>>>
  export function listChannelVideos(account, deps, channelId: string): Promise<YouTubeResult<Array<{ id: string; title: string; publishedAt: string }>>>
  export function defaultYouTubeDeps(): YouTubeCommentsDeps   // service-role client + composioClientFromEnv()
  ```

- [ ] **Step 1: Failing tests**

```ts
// supabase/functions/_shared/youtubeComments.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deleteOwnComment, listThreads, replyToThread, setModerationStatus } from "./youtubeComments.ts";

type Call = { url: string; init?: RequestInit };
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const { status, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetcher };
}

function fakeAdmin() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { account_metadata: { granted_scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"] } }, error: null }) }) }),
      update: (patch: Record<string, unknown>) => { updates.push(patch); return { eq: () => Promise.resolve({ error: null }) }; },
    }),
  };
}

const IN_AN_HOUR = new Date(Date.now() + 3_600_000).toISOString();
const native = { id: "acc", user_id: "u", platform: "youtube", auth_provider: "native", access_token: "tok", refresh_token: "rt", token_expires_at: IN_AN_HOUR, platform_user_id: "UC-me" };

// Recorded 2026-09-04 from commentThreads.list?part=snippet,replies on a live channel.
const thread = {
  id: "t1",
  snippet: {
    videoId: "v1", totalReplyCount: 1,
    topLevelComment: { id: "t1", snippet: { videoId: "v1", textOriginal: "hello", authorDisplayName: "Ann", authorProfileImageUrl: "https://img/a.png", authorChannelId: { value: "UC-ann" }, publishedAt: "2026-09-01T00:00:00Z", likeCount: 2 } },
  },
  replies: { comments: [{ id: "r1", snippet: { videoId: "v1", parentId: "t1", textOriginal: "hi", authorDisplayName: "Me", authorChannelId: { value: "UC-me" }, publishedAt: "2026-09-01T01:00:00Z", likeCount: 0 } }] },
};

Deno.test("native listThreads asks for the whole channel, newest first, and flattens replies", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: { items: [thread], nextPageToken: "p2" } }));
  const result = await listThreads(native, { admin: fakeAdmin(), fetcher }, { channelId: "UC-me" });
  if (!result.ok) throw new Error(result.message);
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/youtube/v3/commentThreads");
  assertEquals(url.searchParams.get("allThreadsRelatedToChannelId"), "UC-me");
  assertEquals(url.searchParams.get("order"), "time");
  assertEquals(url.searchParams.get("part"), "snippet,replies");
  assertEquals((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer tok");
  assertEquals(result.value.nextPageToken, "p2");
  assertEquals(result.value.items[0].authorChannelId, "UC-ann");
  assertEquals(result.value.items[0].replies[0].parentId, "t1");
});

// YouTube only nests one level: a reply to a reply must be posted against the thread's
// top-level comment, or the API rejects it.
Deno.test("replyToThread posts comments.insert with the parent id", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: { id: "new" } }));
  const result = await replyToThread(native, { admin: fakeAdmin(), fetcher }, "t1", "thanks");
  assertEquals(result, { ok: true, value: { id: "new" } });
  assertEquals(JSON.parse(String(calls[0].init?.body)), { snippet: { parentId: "t1", textOriginal: "thanks" } });
});

Deno.test("hide is setModerationStatus=rejected, unhide is published", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 204, body: null }));
  await setModerationStatus(native, { admin: fakeAdmin(), fetcher }, "t1", "rejected");
  await setModerationStatus(native, { admin: fakeAdmin(), fetcher }, "t1", "published");
  assertEquals(new URL(calls[0].url).searchParams.get("moderationStatus"), "rejected");
  assertEquals(new URL(calls[1].url).searchParams.get("moderationStatus"), "published");
});

Deno.test("deleteOwnComment refuses somebody else's comment before calling delete", async () => {
  const { calls, fetcher } = fakeFetch((url) =>
    url.includes("/comments?") ? { status: 200, body: { items: [{ id: "c9", snippet: { authorChannelId: { value: "UC-ann" } } }] } } : { status: 204, body: null });
  const result = await deleteOwnComment(native, { admin: fakeAdmin(), fetcher }, "c9");
  assertEquals(result.ok, false);
  assertEquals(calls.length, 1);
});

// A scope 403 means the channel was connected before force-ssl was requested. The row is
// flipped to reconnect_required by dropping the scope; health columns are not touched.
Deno.test("a 403 insufficientPermissions drops the scope and reports scope_missing", async () => {
  const admin = fakeAdmin();
  const { fetcher } = fakeFetch(() => ({ status: 403, body: { error: { errors: [{ reason: "insufficientPermissions" }] } } }));
  const result = await listThreads(native, { admin, fetcher }, { channelId: "UC-me" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.kind, "scope_missing");
  assertEquals((admin.updates[0].account_metadata as { granted_scopes: string[] }).granted_scopes, []);
  assertEquals(admin.updates.some((u) => "needs_reauth" in u), false);
});

Deno.test("a quota 403 reports quota and writes nothing", async () => {
  const admin = fakeAdmin();
  const { fetcher } = fakeFetch(() => ({ status: 403, body: { error: { errors: [{ reason: "quotaExceeded" }] } } }));
  const result = await listThreads(native, { admin, fetcher }, { channelId: "UC-me" });
  if (result.ok) throw new Error("expected failure");
  assertEquals(result.kind, "quota");
  assertEquals(admin.updates, []);
});

// Composio returns Google's response body under `data`, so the same parser reads both.
Deno.test("composio listThreads executes the pinned tool and parses the same shape", async () => {
  const executed: Array<Record<string, unknown>> = [];
  const composio = { executeTool: (input: Record<string, unknown>) => { executed.push(input); return Promise.resolve({ successful: true, data: { items: [thread] } }); } };
  const admin = {
    from: (table: string) => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: table === "connector_connections" ? { id: "conn", workspace_id: "ws", connector_type: "youtube", toolkit: "youtube", composio_connected_account_id: "ca_1", tool_schema_cache: null, status: "active" } : null, error: null }) }) }) }),
      insert: () => Promise.resolve({ error: null }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  };
  const composioAccount = { ...native, auth_provider: "composio", access_token: null, refresh_token: null, connection_id: "conn", workspace_id: "ws" };
  // deno-lint-ignore no-explicit-any
  const result = await listThreads(composioAccount, { admin, composio: composio as any }, { channelId: "UC-me" });
  if (!result.ok) throw new Error(result.message);
  assertEquals(executed[0].slug, "YOUTUBE_LIST_COMMENT_THREADS");
  assertEquals(executed[0].version, "20260721_00");
  assertEquals(executed[0].connectedAccountId, "ca_1");
  assertEquals(result.value.items[0].id, "t1");
});
```

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Implement**

Registry first (`connectorRegistry.ts:645`):

```ts
composio: {
  toolkit: "youtube", toolkitVersion: "20260721_00",
  tools: [
    "YOUTUBE_LIST_CHANNELS", "YOUTUBE_MULTIPART_UPLOAD_VIDEO", "YOUTUBE_UPDATE_THUMBNAIL",
    "YOUTUBE_LIST_COMMENT_THREADS", "YOUTUBE_LIST_COMMENTS", "YOUTUBE_CREATE_COMMENT_REPLY",
    "YOUTUBE_SET_COMMENT_MODERATION_STATUS", "YOUTUBE_DELETE_COMMENT",
    "YOUTUBE_GET_VIDEO_DETAILS_BATCH", "YOUTUBE_LIST_PLAYLIST_ITEMS",
  ],
  mutating: ["YOUTUBE_MULTIPART_UPLOAD_VIDEO", "YOUTUBE_UPDATE_THUMBNAIL", "YOUTUBE_CREATE_COMMENT_REPLY", "YOUTUBE_SET_COMMENT_MODERATION_STATUS", "YOUTUBE_DELETE_COMMENT"],
},
```

Then the adapter:

```ts
// supabase/functions/_shared/youtubeComments.ts
// One door for every YouTube comment call, for both auth providers. A native row carries a
// Google refresh token and is called directly; a Composio row carries no token at all and is
// called through Composio's tool execution, whose `data` is Google's own response body — which
// is why one parser serves both halves.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type ComposioClient, composioClientFromEnv } from "./composioClient.ts";
import { loadActiveConnection } from "./composioConnections.ts";
import { composioBinding } from "./connectorRegistry.ts";
import { ConnectorRefusal, withConnectorCall } from "./connectorTelemetry.ts";
import { refreshYouTubeToken } from "./social-auth.ts";
import { classifyComposioError, classifyGoogleError, type YouTubeErrorClass } from "./youtubeApiErrors.ts";
import { YOUTUBE_COMMENT_SCOPE } from "./youtubeCommentCapability.ts";
import { dropGrantedScope, recordGrantedScopes } from "./youtubeGrantedScopes.ts";

const DATA_API = "https://www.googleapis.com/youtube/v3";
const REFRESH_WINDOW_MS = 30 * 60 * 1000;
const CALL_TIMEOUT_MS = 15_000;
const COMPOSIO_TIMEOUT_MS = 20_000;

export interface YouTubeCommentAccount { /* as in Interfaces */ }
export interface YouTubeCommentsDeps { admin: any; fetcher?: typeof fetch; composio?: ComposioClient | null; now?: () => number }
export type YouTubeResult<T> = { ok: true; value: T } | { ok: false; kind: YouTubeErrorClass; message: string };
export interface YouTubeCommentItem { /* as in Interfaces */ }
export interface YouTubeThreadItem extends YouTubeCommentItem { totalReplyCount: number; replies: YouTubeCommentItem[] }

interface Call {
  method: "GET" | "POST" | "DELETE";
  path: string;                       // "commentThreads", "comments", "comments/setModerationStatus", "videos", "search"
  query: Record<string, string>;
  body?: unknown;
  composio: { slug: string; arguments: Record<string, unknown> };
}

export function defaultYouTubeDeps(): YouTubeCommentsDeps {
  return {
    admin: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    composio: composioClientFromEnv(),
  };
}

function fail(kind: YouTubeErrorClass, message: string): YouTubeResult<never> { return { ok: false, kind, message }; }

// --- native -------------------------------------------------------------------------------

async function nativeToken(account: YouTubeCommentAccount, deps: YouTubeCommentsDeps): Promise<YouTubeResult<string>> {
  const now = deps.now?.() ?? Date.now();
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && expiresAt - now > REFRESH_WINDOW_MS) return { ok: true, value: account.access_token };

  const refreshed = await refreshYouTubeToken(account as any);
  if (!refreshed) {
    await deps.admin.from("social_accounts").update({
      needs_reauth: true, last_refresh_error: "YouTube refresh failed", updated_at: new Date().toISOString(),
    }).eq("id", account.id);
    return fail("unauthorized", "The YouTube connection expired. Reconnect the channel in Profiles.");
  }
  await deps.admin.from("social_accounts").update({
    access_token: refreshed.access_token,
    token_expires_at: new Date(now + refreshed.expires_in * 1000).toISOString(),
    needs_reauth: false, failure_count: 0, last_refresh_error: null, updated_at: new Date().toISOString(),
  }).eq("id", account.id);
  await recordGrantedScopes(deps.admin, account.id, refreshed.scope);
  account.access_token = refreshed.access_token;
  return { ok: true, value: refreshed.access_token };
}

async function callNative(account: YouTubeCommentAccount, deps: YouTubeCommentsDeps, call: Call): Promise<YouTubeResult<any>> {
  const token = await nativeToken(account, deps);
  if (!token.ok) return token;
  const fetcher = deps.fetcher ?? fetch;
  const url = `${DATA_API}/${call.path}?${new URLSearchParams(call.query)}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: call.method,
      headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    return fail("upstream", `Could not reach YouTube: ${(error as Error)?.message || "network error"}`);
  }
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.ok) return { ok: true, value: body };
  const kind = classifyGoogleError(response.status, body);
  if (kind === "scope_missing") await dropGrantedScope(deps.admin, account.id, YOUTUBE_COMMENT_SCOPE);
  return fail(kind, body?.error?.message || `YouTube returned ${response.status}.`);
}

// --- composio -----------------------------------------------------------------------------

// A tool that ran but failed upstream. Thrown from inside withConnectorCall so the connector
// ledger records the call as a failure — returning a value from the callback would log it as
// a success — and converted back into a YouTubeResult by the caller.
class YouTubeToolFailure extends Error {
  constructor(readonly kind: YouTubeErrorClass, message: string) { super(message); }
}

async function callComposio(account: YouTubeCommentAccount, deps: YouTubeCommentsDeps, call: Call): Promise<YouTubeResult<any>> {
  const binding = composioBinding("youtube");
  if (!deps.composio || !binding) return fail("upstream", "Composio is not configured.");
  if (!account.connection_id || !account.workspace_id) return fail("unauthorized", "The Composio connection is inactive. Reconnect the channel in Profiles.");
  try {
    const data = await withConnectorCall(
      deps.admin,
      // Build this object with the same helper process-post/youtubeComposio.ts uses (its
      // `meta(tool)`), so ConnectorCallMeta's required fields (workspaceId, connectorType,
      // authStrategy, connectionId, socialAccountId, toolId) are filled the way the ledger expects.
      connectorCallMeta(account, call.composio.slug),
      async (signal) => {
        const lookup = await loadActiveConnection(deps.admin, account.connection_id!, account.workspace_id!);
        if (!lookup.ok) throw new ConnectorRefusal(lookup.code);
        const executed = await deps.composio!.executeTool({
          slug: call.composio.slug, version: binding.toolkitVersion,
          workspaceId: lookup.connection.workspaceId, connectedAccountId: lookup.connection.composioConnectedAccountId,
          arguments: call.composio.arguments, signal,
        });
        if (!executed.successful) throw new YouTubeToolFailure(classifyComposioError(executed.error), executed.error || "Composio call failed.");
        return executed.data;
      },
      { timeoutMs: COMPOSIO_TIMEOUT_MS },
    );
    return { ok: true, value: data };
  } catch (error) {
    if (error instanceof YouTubeToolFailure) return fail(error.kind, error.message);
    if (error instanceof ConnectorRefusal) return fail("unauthorized", `Composio connection: ${error.code}`);
    return fail("upstream", (error as Error)?.message || "Composio call failed.");
  }
}

async function callYouTube(account: YouTubeCommentAccount, deps: YouTubeCommentsDeps, call: Call): Promise<YouTubeResult<any>> {
  return account.auth_provider === "composio" ? callComposio(account, deps, call) : callNative(account, deps, call);
}

// --- parsing (one shape for both providers) ---------------------------------------------

function parseComment(item: any): YouTubeCommentItem {
  const snippet = item?.snippet ?? {};
  return {
    id: String(item?.id ?? ""),
    videoId: String(snippet.videoId ?? ""),
    parentId: snippet.parentId ? String(snippet.parentId) : null,
    text: String(snippet.textOriginal ?? snippet.textDisplay ?? ""),
    authorChannelId: snippet.authorChannelId?.value ? String(snippet.authorChannelId.value) : null,
    authorName: String(snippet.authorDisplayName ?? "Unknown"),
    authorAvatar: snippet.authorProfileImageUrl ? String(snippet.authorProfileImageUrl) : null,
    publishedAt: String(snippet.publishedAt ?? new Date().toISOString()),
    likeCount: Number(snippet.likeCount ?? 0),
    moderationStatus: snippet.moderationStatus ? String(snippet.moderationStatus) : null,
  };
}

function parseThread(item: any): YouTubeThreadItem {
  const top = parseComment(item?.snippet?.topLevelComment ?? { id: item?.id, snippet: {} });
  return {
    ...top,
    id: String(item?.id ?? top.id),
    videoId: String(item?.snippet?.videoId ?? top.videoId),
    totalReplyCount: Number(item?.snippet?.totalReplyCount ?? 0),
    replies: Array.isArray(item?.replies?.comments) ? item.replies.comments.map(parseComment) : [],
  };
}

// --- operations ---------------------------------------------------------------------------

export async function listThreads(account, deps, args: { channelId?: string; videoId?: string; pageToken?: string; maxResults?: number }) {
  const query: Record<string, string> = { part: "snippet,replies", order: "time", textFormat: "plainText", maxResults: String(args.maxResults ?? 50) };
  if (args.channelId) query.allThreadsRelatedToChannelId = args.channelId;
  if (args.videoId) query.videoId = args.videoId;
  if (args.pageToken) query.pageToken = args.pageToken;
  const result = await callYouTube(account, deps, {
    method: "GET", path: "commentThreads", query,
    composio: { slug: "YOUTUBE_LIST_COMMENT_THREADS", arguments: { ...query, maxResults: args.maxResults ?? 50 } },
  });
  if (!result.ok) return result;
  const items = Array.isArray(result.value?.items) ? result.value.items.map(parseThread) : [];
  return { ok: true as const, value: { items, nextPageToken: result.value?.nextPageToken ? String(result.value.nextPageToken) : null } };
}

export async function listReplies(account, deps, parentId: string) {
  const result = await callYouTube(account, deps, {
    method: "GET", path: "comments", query: { part: "snippet", parentId, maxResults: "100", textFormat: "plainText" },
    composio: { slug: "YOUTUBE_LIST_COMMENTS", arguments: { part: "snippet", parentId, maxResults: 100, textFormat: "plainText" } },
  });
  if (!result.ok) return result;
  return { ok: true as const, value: (Array.isArray(result.value?.items) ? result.value.items : []).map(parseComment) };
}

// YouTube nests one level: a reply is always posted against the thread's top-level comment, so
// replying to a reply first reads that reply's own parentId (one comments.list call, 1 unit).
export async function replyToThread(account, deps, commentId: string, text: string) {
  const snippet = await commentSnippet(account, deps, commentId);   // { authorChannelId, parentId }, shared with deleteOwnComment
  if (!snippet.ok) return snippet;
  const parentId = snippet.value.parentId ?? commentId;
  const result = await callYouTube(account, deps, {
    method: "POST", path: "comments", query: { part: "snippet" }, body: { snippet: { parentId, textOriginal: text } },
    composio: { slug: "YOUTUBE_CREATE_COMMENT_REPLY", arguments: { parentId, textOriginal: text } },
  });
  if (!result.ok) return result;
  const id = result.value?.id ?? result.value?.response_data?.id;
  return id ? { ok: true as const, value: { id: String(id) } } : fail("upstream", "YouTube did not return the reply id.");
}

export async function setModerationStatus(account, deps, commentId: string, status: "published" | "heldForReview" | "rejected") {
  const result = await callYouTube(account, deps, {
    method: "POST", path: "comments/setModerationStatus", query: { id: commentId, moderationStatus: status },
    composio: { slug: "YOUTUBE_SET_COMMENT_MODERATION_STATUS", arguments: { id: commentId, moderationStatus: status } },
  });
  return result.ok ? { ok: true as const, value: undefined } : result;
}

async function commentAuthor(account, deps, commentId: string): Promise<YouTubeResult<string | null>> {
  const result = await callYouTube(account, deps, {
    method: "GET", path: "comments", query: { part: "snippet", id: commentId },
    composio: { slug: "YOUTUBE_LIST_COMMENTS", arguments: { part: "snippet", id: commentId } },
  });
  if (!result.ok) return result;
  const item = Array.isArray(result.value?.items) ? result.value.items[0] : null;
  return item ? { ok: true, value: parseComment(item).authorChannelId } : fail("not_found", "That comment no longer exists.");
}

// comments.delete only works on the authenticated channel's own comments; for anyone else's
// the moderation status is the tool. Checked here so the refusal is a sentence, not a 403.
export async function deleteOwnComment(account, deps, commentId: string) {
  const author = await commentAuthor(account, deps, commentId);
  if (!author.ok) return author;
  if (!author.value || author.value !== account.platform_user_id) {
    return fail("forbidden", "YouTube only lets you delete your own comments — hide it instead.");
  }
  const result = await callYouTube(account, deps, {
    method: "DELETE", path: "comments", query: { id: commentId },
    composio: { slug: "YOUTUBE_DELETE_COMMENT", arguments: { id: commentId } },
  });
  return result.ok ? { ok: true as const, value: undefined } : result;
}

export async function videoTitles(account, deps, videoIds: string[]) {
  const titles = new Map<string, { title: string; thumbnail: string | null }>();
  if (videoIds.length === 0) return { ok: true as const, value: titles };
  const ids = videoIds.slice(0, 50).join(",");
  const result = await callYouTube(account, deps, {
    method: "GET", path: "videos", query: { part: "snippet", id: ids },
    composio: { slug: "YOUTUBE_GET_VIDEO_DETAILS_BATCH", arguments: { videoIds: videoIds.slice(0, 50), part: "snippet" } },
  });
  if (!result.ok) return result;
  for (const item of Array.isArray(result.value?.items) ? result.value.items : []) {
    titles.set(String(item.id), { title: String(item?.snippet?.title ?? ""), thumbnail: item?.snippet?.thumbnails?.default?.url ?? null });
  }
  return { ok: true as const, value: titles };
}

// search.list costs 100 units per call; the channel's uploads playlist (id = "UU" + the
// channel id without its "UC" prefix) lists the same videos, newest first, for 1 unit.
export function uploadsPlaylistId(channelId: string): string {
  return channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : channelId;
}

export async function listChannelVideos(account, deps, channelId: string) {
  const playlistId = uploadsPlaylistId(channelId);
  const result = await callYouTube(account, deps, {
    method: "GET", path: "playlistItems", query: { part: "snippet", playlistId, maxResults: "25" },
    composio: { slug: "YOUTUBE_LIST_PLAYLIST_ITEMS", arguments: { playlistId, part: "snippet", maxResults: 25 } },
  });
  if (!result.ok) return result;
  return {
    ok: true as const,
    value: (Array.isArray(result.value?.items) ? result.value.items : []).map((item: any) => ({
      id: String(item?.snippet?.resourceId?.videoId ?? ""),
      title: String(item?.snippet?.title ?? ""),
      publishedAt: String(item?.snippet?.publishedAt ?? ""),
    })).filter((video: { id: string }) => video.id),
  };
}
```

Before running: open `supabase/functions/_shared/connectorTelemetry.ts` (`ConnectorCallMeta`: `workspaceId`, `connectorType`, `authStrategy`, optional `toolId`/`connectionId`/`socialAccountId`/`partnerKeyId`, …) and `process-post/youtubeComposio.ts`'s `meta` helper; write `connectorCallMeta(account, slug)` in the adapter the same way. Check `YOUTUBE_GET_VIDEO_DETAILS_BATCH`'s and `YOUTUBE_LIST_PLAYLIST_ITEMS`'s input parameter names with `GET https://backend.composio.dev/api/v3.1/tools/<slug>` (header `x-api-key`, key from the functions container env) and correct the `arguments` objects if they differ from `videoIds`/`playlistId`. Add a test that `uploadsPlaylistId("UCabc") === "UUabc"`.

- [ ] **Step 4: Run the adapter tests; `deno check` the module. Expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/youtubeComments.ts supabase/functions/_shared/youtubeComments.test.ts supabase/functions/_shared/connectorRegistry.ts
git commit -m "feat(youtube): comment adapter for native and Composio channels"
```

---

### Task 5: Wire the adapter into the shared comment path

**Files:**
- Create: `supabase/functions/_shared/commentPlatforms.ts` (+ `.test.ts`)
- Modify: `supabase/functions/_shared/commentActions.ts` (+ `.test.ts`)
- Modify: `supabase/functions/_shared/commentAuthor.ts` (+ `.test.ts`)
- Modify: `supabase/functions/_shared/n8nMessagingDispatch.ts:138`
- Modify: `supabase/functions/_shared/commentWorkflow.ts:273`

**Interfaces:**
- Produces: `platformSupportsPrivateReply(platform: string): boolean` (`facebook` | `instagram` only). `replyToComment/hideComment/deleteComment` gain a 4th/5th optional `youtubeDeps?: YouTubeCommentsDeps` parameter; `CommentActionAccount` gains `id?, user_id?, auth_provider?, refresh_token?, token_expires_at?, connection_id?, workspace_id?`.

- [ ] **Step 1: Failing tests**

```ts
// supabase/functions/_shared/commentPlatforms.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { platformSupportsPrivateReply } from "./commentPlatforms.ts";
Deno.test("only Meta comment platforms can answer privately", () => {
  assertEquals(platformSupportsPrivateReply("facebook"), true);
  assertEquals(platformSupportsPrivateReply("instagram"), true);
  assertEquals(platformSupportsPrivateReply("threads"), false);
  assertEquals(platformSupportsPrivateReply("youtube"), false);
});
```

Append to `commentActions.test.ts`:

```ts
// Before this branch existed, a youtube row fell through to graph.facebook.com and failed
// only when Meta rejected it — and a platform nobody has added yet still would.
Deno.test("an unknown platform is refused, not sent to Meta", async () => {
  const calls: Call[] = [];
  const result = await replyToComment({ platform: "bluesky", access_token: "tok", platform_user_id: "x", ig_auth_type: null, account_metadata: {} }, "c1", "hi", fakeFetch(calls));
  assertEquals(result.success, false);
  assertEquals(calls.length, 0);
});

Deno.test("youtube reply goes through the adapter with the account's provider", async () => {
  const calls: Call[] = [];
  const ytAccount = { id: "acc", user_id: "u", platform: "youtube", auth_provider: "native", access_token: "tok", refresh_token: "rt", token_expires_at: new Date(Date.now() + 3_600_000).toISOString(), platform_user_id: "UC-me", ig_auth_type: null, account_metadata: {} };
  const admin = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { account_metadata: {} }, error: null }) }) }), update: () => ({ eq: () => Promise.resolve({ error: null }) }) }) };
  const result = await replyToComment(ytAccount, "t1", "hi", fakeFetch(calls, { id: "new-yt" }), { admin });
  assertEquals(result, { success: true, platform_comment_id: "new-yt" });
  assertEquals(calls[0].url.startsWith("https://www.googleapis.com/youtube/v3/comments"), true);
});

Deno.test("youtube hide maps to moderation rejected, unhide to published", async () => {
  const calls: Call[] = [];
  const admin = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { account_metadata: {} }, error: null }) }) }), update: () => ({ eq: () => Promise.resolve({ error: null }) }) }) };
  const ytAccount = { id: "acc", user_id: "u", platform: "youtube", auth_provider: "native", access_token: "tok", refresh_token: "rt", token_expires_at: new Date(Date.now() + 3_600_000).toISOString(), platform_user_id: "UC-me", ig_auth_type: null, account_metadata: {} };
  await hideComment(ytAccount, "t1", true, fakeFetch(calls, null, 204), { admin });
  await hideComment(ytAccount, "t1", false, fakeFetch(calls, null, 204), { admin });
  assertEquals(new URL(calls[0].url).searchParams.get("moderationStatus"), "rejected");
  assertEquals(new URL(calls[1].url).searchParams.get("moderationStatus"), "published");
});
```

Append to `commentAuthor.test.ts`:

```ts
Deno.test("a youtube comment by the channel itself is the account's own", () => {
  const account = { platform: "youtube", platform_user_id: "UC-me", platform_username: "Me" };
  assertEquals(isOwnComment(account, { id: "UC-me", username: null }), true);
  assertEquals(isOwnComment(account, { id: "UC-ann", username: "Me" }), false); // display names collide; ids do not
});
```

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/commentPlatforms.ts
/** Threads and YouTube have no private messages: a funnel there replies publicly or not at all. */
export function platformSupportsPrivateReply(platform: string): boolean {
  return platform === "facebook" || platform === "instagram";
}
```

`commentActions.ts`: widen `CommentActionAccount` with the optional fields listed above; add `import { defaultYouTubeDeps, deleteOwnComment, replyToThread, setModerationStatus, type YouTubeCommentAccount, type YouTubeCommentsDeps } from "./youtubeComments.ts";` and:

```ts
const META_PLATFORMS = new Set(["facebook", "instagram"]);

function unsupported(platform: string): CommentActionResult {
  return { success: false, error: `Comments are not supported on ${platform}.` };
}

function asYouTubeAccount(account: CommentActionAccount): YouTubeCommentAccount {
  return { id: account.id ?? "", user_id: account.user_id ?? "", ...account } as YouTubeCommentAccount;
}

function fromYouTube<T>(result: { ok: true; value: T } | { ok: false; kind: string; message: string }, id: (value: T) => string): CommentActionResult {
  if (result.ok) return { success: true, platform_comment_id: id(result.value) };
  return { success: false, error: result.message, upstreamUnavailable: result.kind === "upstream" };
}

export async function replyToComment(account, commentId, message, fetcher = fetch, youtubeDeps?: YouTubeCommentsDeps) {
  if (account.platform === "youtube") {
    return fromYouTube(await replyToThread(asYouTubeAccount(account), { ...(youtubeDeps ?? defaultYouTubeDeps()), fetcher }, commentId, message), (v) => v.id);
  }
  if (account.platform !== "threads" && !META_PLATFORMS.has(account.platform)) return unsupported(account.platform);
  ...existing body...
}
```

Same pattern in `hideComment` (`setModerationStatus(..., hide ? "rejected" : "published")`, id = `commentId`) and `deleteComment` (`deleteOwnComment`). Put the `youtube` check before `requireToken` — a Composio row has no token.

`commentAuthor.ts`: no change to `ownIds` is needed (`platform_user_id` is already in the set); the test documents the rule. Add the comment `// YouTube: snippet.authorChannelId.value is the commenter's channel id, compared to platform_user_id.` above `ownIds`.

`n8nMessagingDispatch.ts:138`: `export type CommentPlatform = "facebook" | "instagram" | "threads" | "youtube";`

`commentWorkflow.ts:273`: `wantsDm: platformSupportsPrivateReply(account.platform) && !!rule.dm_message,` with the import.

- [ ] **Step 4: Run `deno test` on `_shared/` (whole folder) — the Threads/Meta suites must stay green. `deno check` the touched modules.**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/commentPlatforms.ts supabase/functions/_shared/commentPlatforms.test.ts supabase/functions/_shared/commentActions.ts supabase/functions/_shared/commentActions.test.ts supabase/functions/_shared/commentAuthor.ts supabase/functions/_shared/commentAuthor.test.ts supabase/functions/_shared/n8nMessagingDispatch.ts supabase/functions/_shared/commentWorkflow.ts
git commit -m "feat(comments): youtube branch in the shared actions, and refuse unknown platforms"
```

---

### Task 6: Platform-neutral ingest door

**Files:**
- Create: `supabase/functions/_shared/polledCommentIngest.ts`
- Modify: `supabase/functions/_shared/threadsCommentIngest.ts` (becomes a thin caller)

**Interfaces:**
- Produces: `ingestPolledComment(admin, account: CommentAutomationAccount, platform: CommentPlatform, comment: PolledCommentInput, options: PolledIngestOptions): Promise<PolledCommentOutcome>` where `PolledCommentInput = Omit<CommentPayloadInput, "platform" | "socialAccountId" | "account">`, `PolledIngestOptions = { rawPayload: unknown; dispatch?: boolean }`, `PolledCommentOutcome` = the existing `ThreadsCommentOutcome` union. `threadsCommentIngest.ts` keeps exporting `ingestThreadsComment`, `ThreadsCommentInput`, `ThreadsIngestOptions`, `ThreadsCommentOutcome`.

- [ ] **Step 1: The existing suite is the test.** Run `deno test ... supabase/functions/_shared/threadsCommentIngest.test.ts` and note the count (it must be identical after the refactor).

- [ ] **Step 2: Move the body**

`polledCommentIngest.ts` is the current `threadsCommentIngest.ts` with: the `platform: "threads"` literal in the upsert replaced by the `platform` parameter; `buildCommentPayload({ platform: "threads", ...})` → `platform`; log prefixes `[threads-ingest]` → `[${platform}-ingest]`; the background task label `"threads comment routing"` → `` `${platform} comment routing` ``; types renamed as above. Keep every comment.

`threadsCommentIngest.ts` becomes:

```ts
import { ingestPolledComment, type PolledCommentInput, type PolledCommentOutcome, type PolledIngestOptions } from "./polledCommentIngest.ts";
import type { CommentAutomationAccount } from "./commentAutomation.ts";

export type ThreadsCommentOutcome = PolledCommentOutcome;
export type ThreadsCommentInput = PolledCommentInput;
export type ThreadsIngestOptions = PolledIngestOptions;

/** The Threads door. See polledCommentIngest.ts for the invariants; they are per platform, not per source. */
export function ingestThreadsComment(admin: any, account: CommentAutomationAccount, comment: ThreadsCommentInput, options: ThreadsIngestOptions): Promise<ThreadsCommentOutcome> {
  return ingestPolledComment(admin, account, "threads", comment, options);
}
```

- [ ] **Step 3: Run the Threads suite again — same count, all green. `deno check` both files.**

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/polledCommentIngest.ts supabase/functions/_shared/threadsCommentIngest.ts
git commit -m "refactor(comments): platform-neutral polled ingest door; Threads becomes a caller"
```

---

### Task 7: The poller `youtube-poll-comments`

**Files:**
- Create: `supabase/functions/_shared/youtubeCommentNormalize.ts` (+ `.test.ts`)
- Create: `supabase/functions/youtube-poll-comments/poll.ts` (+ `poll.test.ts`)
- Create: `supabase/functions/youtube-poll-comments/index.ts`

**Interfaces:**
- Consumes: `listThreads`, `selectPollableChannels`, `ingestPolledComment`, `verifyCronAuth`, `defaultYouTubeDeps`.
- Produces: `threadToInputs(thread: YouTubeThreadItem): PolledCommentInput[]` (top-level first, then its replies); `pollYouTubeComments(admin, deps: { youtube: YouTubeCommentsDeps; listThreads?: typeof listThreads; ingest?: typeof ingestPolledComment }): Promise<PollSummary>` with `PollSummary = { polled: number; dispatched: number; skipped: { handler_off; reconnect_required; duplicate_channel; quota; failed } }`.

- [ ] **Step 1: Failing tests**

```ts
// supabase/functions/_shared/youtubeCommentNormalize.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { threadToInputs } from "./youtubeCommentNormalize.ts";

const thread = {
  id: "t1", videoId: "v1", parentId: null, text: "hello", authorChannelId: "UC-ann", authorName: "Ann", authorAvatar: null,
  publishedAt: "2026-09-01T00:00:00Z", likeCount: 2, moderationStatus: null, totalReplyCount: 1,
  replies: [{ id: "r1", videoId: "v1", parentId: "t1", text: "hi", authorChannelId: "UC-me", authorName: "Me", authorAvatar: null, publishedAt: "2026-09-01T01:00:00Z", likeCount: 0, moderationStatus: null }],
};

Deno.test("a thread becomes one comment input plus one per inlined reply", () => {
  const inputs = threadToInputs(thread);
  assertEquals(inputs.map((i) => [i.comment.id, i.comment.kind, i.comment.parentCommentId]), [["t1", "comment", null], ["r1", "reply", "t1"]]);
  assertEquals(inputs[0].post, { id: "v1", url: "https://www.youtube.com/watch?v=v1", caption: null });
  assertEquals(inputs[0].author, { id: "UC-ann", name: "Ann", username: null });
  assertEquals(inputs[0].timestamp, "2026-09-01T00:00:00Z");
});
```

```ts
// supabase/functions/youtube-poll-comments/poll.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { pollYouTubeComments } from "./poll.ts";

const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const rows = [
  { id: "a", user_id: "u", platform: "youtube", platform_user_id: "UC-a", auth_provider: "native", access_token: "t", refresh_token: "r", token_expires_at: null, account_metadata: { comment_automation_handler: "internal", granted_scopes: SCOPES } },
  { id: "b", user_id: "u", platform: "youtube", platform_user_id: "UC-b", auth_provider: "native", access_token: "t", refresh_token: "r", token_expires_at: null, account_metadata: { comment_automation_handler: "n8n", granted_scopes: SCOPES } },
];
const thread = { id: "t1", videoId: "v1", parentId: null, text: "x", authorChannelId: "UC-ann", authorName: "Ann", authorAvatar: null, publishedAt: "2026-09-01T00:00:00Z", likeCount: 0, moderationStatus: null, totalReplyCount: 0, replies: [] };

function fakeAdmin(inboxCounts: Record<string, number>) {
  return {
    from: (table: string) => ({
      select: (_cols: string, opts?: { count?: string }) => ({
        eq: (col: string, value: string) => {
          if (table === "social_accounts") return { eq: () => Promise.resolve({ data: rows, error: null }) };
          if (table === "social_inbox_events" && opts?.count) return Promise.resolve({ count: inboxCounts[value] ?? 0, error: null });
          return Promise.resolve({ data: [], error: null });
        },
      }),
    }),
  };
}

Deno.test("first pass over a channel seeds without dispatching; a seen channel dispatches", async () => {
  const ingested: Array<{ account: string; dispatch: boolean | undefined }> = [];
  const summary = await pollYouTubeComments(fakeAdmin({ a: 0, b: 3 }), {
    youtube: { admin: null },
    listThreads: async () => ({ ok: true, value: { items: [thread], nextPageToken: null } }),
    ingest: async (_admin, account, _platform, _comment, options) => { ingested.push({ account: account.id, dispatch: options.dispatch }); return options.dispatch === false ? "seeded" : "dispatched_n8n"; },
  });
  assertEquals(ingested, [{ account: "a", dispatch: false }, { account: "b", dispatch: true }]);
  assertEquals(summary.polled, 2);
  assertEquals(summary.dispatched, 1);
});

Deno.test("a quota failure on one channel is counted and the sweep continues", async () => {
  let calls = 0;
  const summary = await pollYouTubeComments(fakeAdmin({ a: 1, b: 1 }), {
    youtube: { admin: null },
    listThreads: async (account) => { calls += 1; return account.id === "a" ? { ok: false, kind: "quota", message: "q" } : { ok: true, value: { items: [], nextPageToken: null } }; },
    ingest: async () => "duplicate",
  });
  assertEquals(calls, 2);
  assertEquals(summary.skipped.quota, 1);
});
```

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/youtubeCommentNormalize.ts
import type { PolledCommentInput } from "./polledCommentIngest.ts";
import type { YouTubeCommentItem, YouTubeThreadItem } from "./youtubeComments.ts";

export function videoUrl(videoId: string): string { return `https://www.youtube.com/watch?v=${videoId}`; }

function toInput(item: YouTubeCommentItem, kind: "comment" | "reply"): PolledCommentInput {
  return {
    comment: { id: item.id, kind, text: item.text, parentCommentId: item.parentId, mediaUrl: null },
    post: { id: item.videoId || null, url: item.videoId ? videoUrl(item.videoId) : null, caption: null },
    author: { id: item.authorChannelId, name: item.authorName, username: null },
    timestamp: item.publishedAt,
  };
}

/** Top-level first so a reply never reaches the door before the comment it answers. */
export function threadToInputs(thread: YouTubeThreadItem): PolledCommentInput[] {
  return [toInput(thread, "comment"), ...thread.replies.map((reply) => toInput(reply, "reply"))];
}
```

```ts
// supabase/functions/youtube-poll-comments/poll.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ingestPolledComment } from "../_shared/polledCommentIngest.ts";
import { threadToInputs } from "../_shared/youtubeCommentNormalize.ts";
import { listThreads as listThreadsLive, type YouTubeCommentAccount, type YouTubeCommentsDeps } from "../_shared/youtubeComments.ts";
import { selectPollableChannels } from "../_shared/youtubePollEligibility.ts";

export const ACCOUNT_SELECT =
  "id, user_id, platform, platform_user_id, platform_username, auth_provider, access_token, refresh_token, token_expires_at, connection_id, workspace_id, account_metadata";

export interface PollDeps {
  youtube: YouTubeCommentsDeps;
  listThreads?: typeof listThreadsLive;
  ingest?: typeof ingestPolledComment;
}

export interface PollSummary {
  polled: number;
  dispatched: number;
  skipped: { handler_off: number; reconnect_required: number; duplicate_channel: number; quota: number; failed: number };
}

async function pollChannel(admin: any, account: YouTubeCommentAccount, deps: PollDeps, summary: PollSummary): Promise<void> {
  const listThreads = deps.listThreads ?? listThreadsLive;
  const ingest = deps.ingest ?? ingestPolledComment;

  // First pass over a channel: record history, fire nothing (see polledCommentIngest).
  const { count } = await admin.from("social_inbox_events").select("id", { count: "exact", head: true }).eq("social_account_id", account.id);
  const dispatch = (count ?? 0) > 0;

  const threads = await listThreads(account, deps.youtube, { channelId: account.platform_user_id! });
  if (!threads.ok) {
    if (threads.kind === "quota") summary.skipped.quota += 1; else summary.skipped.failed += 1;
    console.warn(`[youtube-poll] ${account.id}: ${threads.kind}: ${threads.message}`);
    return;
  }
  for (const thread of threads.value.items) {
    for (const input of threadToInputs(thread)) {
      const outcome = await ingest(admin, account as any, "youtube", input, { rawPayload: thread, dispatch });
      if (outcome === "dispatched_n8n" || outcome === "automated_internally") summary.dispatched += 1;
    }
  }
}

export async function pollYouTubeComments(admin: any, deps: PollDeps): Promise<PollSummary> {
  const { data, error } = await admin.from("social_accounts").select(ACCOUNT_SELECT).eq("platform", "youtube").eq("is_active", true);
  if (error) throw new Error(`account_listing_failed: ${error.message}`);

  const selection = selectPollableChannels((data ?? []) as YouTubeCommentAccount[]);
  const summary: PollSummary = { polled: selection.eligible.length, dispatched: 0, skipped: { ...selection.skipped, quota: 0, failed: 0 } };
  for (const account of selection.eligible) {
    try {
      await pollChannel(admin, account, deps, summary);
    } catch (err) {
      summary.skipped.failed += 1;
      console.error(`[youtube-poll] ${account.id} failed: ${(err as Error).message}`);
    }
  }
  console.log(`[youtube-poll] polled ${summary.polled}, dispatched ${summary.dispatched}, skipped ${JSON.stringify(summary.skipped)}`);
  return summary;
}
```

```ts
// supabase/functions/youtube-poll-comments/index.ts
// YouTube comment poller — cron-invoked, service role, no user auth. YouTube has no comment
// webhook at all (PubSubHubbub covers uploads only), so Postora is the source of the event:
// one commentThreads.list per channel per run, deduped by the inbox insert, handed to the same
// door the Threads poller uses. Cost: 1 quota unit per channel per run.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { defaultYouTubeDeps } from "../_shared/youtubeComments.ts";
import { pollYouTubeComments } from "./poll.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const summary = await pollYouTubeComments(admin, { youtube: defaultYouTubeDeps() });
    return new Response(JSON.stringify({ success: true, ...summary }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error(`[youtube-poll] ${(error as Error).message}`);
    return new Response(JSON.stringify({ error: "account_listing_failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
```

- [ ] **Step 4: Run both test files and `deno check` all three modules. Expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/youtubeCommentNormalize.ts supabase/functions/_shared/youtubeCommentNormalize.test.ts supabase/functions/youtube-poll-comments/
git commit -m "feat(youtube): comment poller feeding the shared ingest door"
```

---

### Task 8: `comment-manager` actions for YouTube

**Files:**
- Modify: `supabase/functions/comment-manager/index.ts` (account load L131-149; switch L150-266)
- Create: `supabase/functions/comment-manager/youtubeCommentsView.ts` (+ `.test.ts`)

**Interfaces:**
- Produces: actions `get_youtube_comments { social_account_id, page_token? }` → `{ videos: Array<{ id, title, url, threads: YouTubeThreadView[] }>, next_page_token }` and `get_youtube_videos { social_account_id }` → `{ videos: Array<{ id, title, published_at }> }`; failures as `{ error_type: "MISSING_SCOPE" | "QUOTA" | "TOKEN_EXPIRED" | "YOUTUBE_ERROR", error: string }` (200 body, the FB/IG convention). `groupThreadsByVideo(items, titles, ownChannelId): VideoGroup[]` is the pure helper. `YouTubeThreadView = { id, text, author: { id, name, avatar_url }, published_at, like_count, moderation_status, is_own, total_reply_count, replies: YouTubeReplyView[] }`.

- [ ] **Step 1: Failing test**

```ts
// supabase/functions/comment-manager/youtubeCommentsView.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { errorTypeFor, groupThreadsByVideo } from "./youtubeCommentsView.ts";

const item = (id: string, videoId: string, author = "UC-ann") => ({
  id, videoId, parentId: null, text: id, authorChannelId: author, authorName: "n", authorAvatar: null,
  publishedAt: "2026-09-01T00:00:00Z", likeCount: 0, moderationStatus: null, totalReplyCount: 0, replies: [],
});

Deno.test("threads are grouped per video, in the order first seen, with the title looked up", () => {
  const groups = groupThreadsByVideo([item("a", "v1"), item("b", "v2"), item("c", "v1", "UC-me")], new Map([["v1", { title: "One", thumbnail: null }]]), "UC-me");
  assertEquals(groups.map((g) => [g.id, g.title, g.threads.length]), [["v1", "One", 2], ["v2", "", 1]]);
  assertEquals(groups[0].threads[1].is_own, true);
  assertEquals(groups[0].url, "https://www.youtube.com/watch?v=v1");
});

Deno.test("adapter error classes map onto the comment manager's error_type vocabulary", () => {
  assertEquals(errorTypeFor("scope_missing"), "MISSING_SCOPE");
  assertEquals(errorTypeFor("unauthorized"), "TOKEN_EXPIRED");
  assertEquals(errorTypeFor("quota"), "QUOTA");
  assertEquals(errorTypeFor("upstream"), "YOUTUBE_ERROR");
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```ts
// supabase/functions/comment-manager/youtubeCommentsView.ts
import { videoUrl } from "../_shared/youtubeCommentNormalize.ts";
import type { YouTubeCommentItem, YouTubeThreadItem } from "../_shared/youtubeComments.ts";
import type { YouTubeErrorClass } from "../_shared/youtubeApiErrors.ts";

export interface YouTubeReplyView { id: string; text: string; author: { id: string | null; name: string; avatar_url: string | null }; published_at: string; like_count: number; moderation_status: string | null; is_own: boolean }
export interface YouTubeThreadView extends YouTubeReplyView { total_reply_count: number; replies: YouTubeReplyView[] }
export interface VideoGroup { id: string; title: string; url: string; threads: YouTubeThreadView[] }

function view(item: YouTubeCommentItem, ownChannelId: string | null): YouTubeReplyView {
  return {
    id: item.id, text: item.text,
    author: { id: item.authorChannelId, name: item.authorName, avatar_url: item.authorAvatar },
    published_at: item.publishedAt, like_count: item.likeCount, moderation_status: item.moderationStatus,
    is_own: !!ownChannelId && item.authorChannelId === ownChannelId,
  };
}

export function groupThreadsByVideo(items: YouTubeThreadItem[], titles: Map<string, { title: string }>, ownChannelId: string | null): VideoGroup[] {
  const groups = new Map<string, VideoGroup>();
  for (const item of items) {
    const group = groups.get(item.videoId) ?? { id: item.videoId, title: titles.get(item.videoId)?.title ?? "", url: videoUrl(item.videoId), threads: [] };
    group.threads.push({ ...view(item, ownChannelId), total_reply_count: item.totalReplyCount, replies: item.replies.map((reply) => view(reply, ownChannelId)) });
    groups.set(item.videoId, group);
  }
  return [...groups.values()];
}

export function errorTypeFor(kind: YouTubeErrorClass): "MISSING_SCOPE" | "TOKEN_EXPIRED" | "QUOTA" | "YOUTUBE_ERROR" {
  if (kind === "scope_missing") return "MISSING_SCOPE";
  if (kind === "unauthorized") return "TOKEN_EXPIRED";
  if (kind === "quota") return "QUOTA";
  return "YOUTUBE_ERROR";
}
```

In `comment-manager/index.ts`:
- Account select becomes `"id, user_id, access_token, refresh_token, token_expires_at, platform, platform_user_id, auth_provider, connection_id, workspace_id, ig_auth_type, account_metadata"`; the 404 guard becomes `if (!account || (account.auth_provider !== "composio" && !account.access_token))`. `accessToken` may now be null for Composio rows; the Meta branches already guard on it.
- New cases before `reply_comment`:

```ts
case "get_youtube_comments": {
  if (!socialAccount || socialAccount.platform !== "youtube") return json400("a youtube social_account_id is required");
  const deps = defaultYouTubeDeps();
  const threads = await listThreads(socialAccount, deps, { channelId: socialAccount.platform_user_id!, pageToken: body.page_token || undefined });
  if (!threads.ok) { result = { error_type: errorTypeFor(threads.kind), error: threads.message }; break; }
  const titles = await videoTitles(socialAccount, deps, [...new Set(threads.value.items.map((t) => t.videoId))]);
  result = {
    videos: groupThreadsByVideo(threads.value.items, titles.ok ? titles.value : new Map(), socialAccount.platform_user_id ?? null),
    next_page_token: threads.value.nextPageToken,
  };
  break;
}
case "get_youtube_videos": {
  if (!socialAccount || socialAccount.platform !== "youtube") return json400("a youtube social_account_id is required");
  const videos = await listChannelVideos(socialAccount, defaultYouTubeDeps(), socialAccount.platform_user_id!);
  result = videos.ok ? { videos: videos.value.map((v) => ({ id: v.id, title: v.title, published_at: v.publishedAt })) } : { error_type: errorTypeFor(videos.kind), error: videos.message };
  break;
}
```

Add a `json400(message)` helper for the repeated 400 response and use it in the new cases only (do not refactor the Meta cases — separate change). The three action cases (`reply_comment`, `hide_comment`, `delete_comment`) drop `!accessToken` from their guard (the shared actions decide per platform); they already pass `socialAccount` through.

- [ ] **Step 4: Run the new test; `deno check supabase/functions/comment-manager/index.ts`. Expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/comment-manager/
git commit -m "feat(comment-manager): list YouTube comments per video and the channel's videos"
```

---

### Task 9: Server allow-lists

**Files:**
- Modify: `supabase/functions/messaging-api/index.ts:367`
- Modify: `supabase/functions/n8n-api/index.ts:34-40`

- [ ] **Step 1:** `const supportedAiAgentPlatforms = ["whatsapp", "facebook", "instagram", "threads", "youtube"];` and update the comment above it: "Threads and YouTube have no DM API, so their agents only ever answer public comments."
- [ ] **Step 2:** add `'comment.youtube'` after `'comment.threads'` in `ALLOWED_WEBHOOK_EVENTS`.
- [ ] **Step 2b (ai-agent-reply):** `supabase/functions/ai-agent-reply/index.ts:290` `buildCommentReplySender` selects only `platform, access_token, platform_user_id, ig_auth_type, account_metadata`, so the youtube branch of `replyToComment` would receive a row that can authenticate neither provider. Widen it to `"id, user_id, platform, auth_provider, access_token, refresh_token, token_expires_at, platform_user_id, connection_id, workspace_id, ig_auth_type, account_metadata"`. It has no `access_token` guard (good — Composio rows have none); keep it that way. `deno check` the file.
- [ ] **Step 3:** Run the two functions' existing test files (`ls supabase/functions/messaging-api/*.test.ts supabase/functions/n8n-api/*.test.ts`) — if a test enumerates the allowed events, extend it with `comment.youtube`.
- [ ] **Step 4: Commit**

```bash
git add supabase/functions/messaging-api/index.ts supabase/functions/n8n-api/index.ts supabase/functions/ai-agent-reply/index.ts
git commit -m "feat(api): admit youtube on the agent config door, comment.youtube on n8n, full row for agent comment replies"
```

---

## Slice B — database (Muse Spark lane)

### Task 10: Migration `20260904150000_youtube_comments.sql`

**Files:**
- Create: `supabase/migrations/20260904150000_youtube_comments.sql`

- [ ] **Step 1: Write the migration**

```sql
-- YouTube joins the comment surfaces. Every table below pins `platform` with a CHECK that
-- stops at 'threads'; each is widened by lookup on its definition, the way
-- 20260822180000_threads_agent_platform.sql did, because the inline constraints carry
-- generated names that differ between environments.
DO $migration$
DECLARE
  v_table text;
  v_conname text;
  v_allowed text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'social_inbox_events',
    'messenger_auto_replies',
    'ai_agent_configs',
    'ai_conversation_modes',
    'ai_threads',
    'ai_agent_logs',
    'comment_workflow_rules'
  ]
  LOOP
    v_allowed := CASE
      WHEN v_table IN ('messenger_auto_replies', 'comment_workflow_rules', 'social_inbox_events')
        THEN '''facebook'', ''instagram'', ''threads'', ''youtube'''
      ELSE '''whatsapp'', ''facebook'', ''instagram'', ''threads'', ''youtube'''
    END;

    -- Postgres renders `platform IN (...)` as `platform = ANY (ARRAY[...])`, and
    -- comment_workflow_rules has a second CHECK mentioning platform (cwr_threads_has_no_dm),
    -- so the match is on the ANY form and every match is dropped, not the first one found.
    FOR v_conname IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = format('public.%I', v_table)::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%platform = ANY%'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', v_table, v_conname);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (platform IN (%s))',
      v_table, v_table || '_platform_check', v_allowed
    );
  END LOOP;
END
$migration$;

-- YouTube has no private messages, exactly as Threads has none: a rule labelled youtube can
-- never carry DM copy or a file, whatever the form sends.
ALTER TABLE public.comment_workflow_rules
  DROP CONSTRAINT IF EXISTS cwr_youtube_has_no_dm,
  ADD CONSTRAINT cwr_youtube_has_no_dm
    CHECK (platform <> 'youtube' OR (dm_message IS NULL AND media_file_id IS NULL));

-- Every five minutes: one commentThreads.list per eligible channel (1 quota unit each against
-- Google's 10,000/day default), so 5 minutes keeps ~30 channels under budget.
DO $$
BEGIN
  PERFORM cron.unschedule('poll-youtube-comments');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'poll-youtube-comments',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://api.postora.cloud/functions/v1/youtube-poll-comments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || get_cron_secret()
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Off by default; admins receive every non-visibility flag regardless (useFeatureFlags).
INSERT INTO public.app_settings (key, value, description)
VALUES ('feature_youtube_comments', 'false'::jsonb, 'YouTube comments (Comment Manager, agent, workflows)')
ON CONFLICT (key) DO NOTHING;
```

Verified on production 2026-09-04: `comment_workflow_rules_platform_check` renders as `CHECK ((platform = ANY (ARRAY['facebook'::text, 'instagram'::text, 'threads'::text])))`, and `cwr_threads_has_no_dm` renders with `platform <> 'threads'` — only the first matches `'%platform = ANY%'`.

- [ ] **Step 2: Rehearse on the harness** — `bash scripts/db-harness.sh` (needs PG17 + the psql shim; see memory `postora-db-harness-needs-pg17`). Expected: migration applies; existing suites green.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260904150000_youtube_comments.sql
git commit -m "feat(db): admit youtube on the comment tables, schedule the poller, add the flag"
```

---

### Task 11: Harness suite `youtube_comments.sql`

**Files:**
- Create: `supabase/tests/youtube_comments.sql`
- Modify: `scripts/db-harness.sh:111-112` (add the suite to the list)

- [ ] **Step 1: Write the suite** in the style of `supabase/tests/comment_workflow.sql` (`\set ON_ERROR_STOP on`, temp id table, `\echo` markers, cleans its rows). It must prove:
  1. an `INSERT` of a `platform = 'youtube'` row succeeds on each of the seven widened tables (minimal NOT NULL columns; copy each table's required columns from `comment_workflow.sql` and `20260822180000`'s tables);
  2. `INSERT INTO comment_workflow_rules (... platform='youtube', dm_message='x' ...)` fails with `cwr_youtube_has_no_dm` (use a `DO` block that catches `check_violation` and raises if it did NOT fail);
  2b. after the migration, `comment_workflow_rules` still carries BOTH `cwr_threads_has_no_dm` and `comment_workflow_rules_platform_check` (`SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'public.comment_workflow_rules'::regclass AND conname IN (...)`), and a `threads` row with `dm_message` is still rejected — the lookup must never have dropped the wrong constraint;
  3. `SELECT count(*) = 1 FROM cron.job WHERE jobname = 'poll-youtube-comments' AND schedule = '*/5 * * * *'`;
  4. `SELECT value = 'false'::jsonb FROM app_settings WHERE key = 'feature_youtube_comments'`.

  Each assertion is `DO $$ BEGIN IF NOT (...) THEN RAISE EXCEPTION 'youtube_comments: <what>'; END IF; END $$;`.

- [ ] **Step 2:** add `youtube_comments.sql` after `youtube_composio_provider.sql` in `scripts/db-harness.sh`'s suite list.
- [ ] **Step 3:** `bash scripts/db-harness.sh` — green, with the new suite's `\echo` markers in the output.
- [ ] **Step 4: Commit**

```bash
git add supabase/tests/youtube_comments.sql scripts/db-harness.sh
git commit -m "test(db): harness suite for the youtube comment tables, constraint, cron and flag"
```

---

## Slice C — frontend

### Task 12: `SocialAccount.auth_provider` and the flag

**Files:**
- Modify: `src/hooks/useSocialAccounts.tsx:7-25`
- Modify: `src/hooks/useFeatureFlags.tsx` (8 sites: L71, L149, L225, L296, L379, L451, L570, and `VISIBILITY_FLAG_KEYS` near L630 — `youtubeComments` DOES go into `VISIBILITY_FLAG_KEYS`, right after `"commentWorkflow"`, for the same reason that one is there: the frontend auto-deploys on merge while the migration and the poller are applied by hand, and an admin would otherwise see the tile before the CHECKs admit youtube rows. Copy the comment above `"commentWorkflow"` and name YouTube in it.)
- Modify: `src/components/admin/FeatureFlagIndicator.tsx:64`

- [ ] **Step 1:** add `auth_provider: "native" | "composio";` to `SocialAccount` (the select already fetches it — the Slice F trap).
- [ ] **Step 2:** add `youtubeComments: boolean;` / `youtubeComments: false,` / `"feature_youtube_comments",` / `feature_youtube_comments: "youtubeComments",` / `youtubeComments: "YouTube Comments",` / `youtubeComments: true,` (admin defaults) / `youtubeComments: globalFlagMap["feature_youtube_comments"] ?? DEFAULT_FLAGS.youtubeComments,` in order, each directly after the `commentWorkflow` line. Same label in `FeatureFlagIndicator.tsx`.
- [ ] **Step 3:** `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json` clean; `bun run test -- src/hooks` green.
- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSocialAccounts.tsx src/hooks/useFeatureFlags.tsx src/components/admin/FeatureFlagIndicator.tsx
git commit -m "feat(flags): feature_youtube_comments, and auth_provider on SocialAccount"
```

---

### Task 13: Comment Manager — hook, panel, page, actions

**Files:**
- Modify: `src/hooks/useCommentInbox.ts` (+ `src/hooks/__tests__/useCommentInbox.test.ts`)
- Modify: `src/components/comments/CommentManagerPanel.tsx`
- Modify: `src/components/comments/CommentActions.tsx`
- Modify: `src/pages/comments/CommentManagerPage.tsx`
- Create: `src/components/comments/__tests__/CommentManagerPanel.test.tsx`

**Interfaces:**
- Produces: `Comment.platform: "facebook" | "instagram" | "youtube"`, `Comment.is_own?: boolean`, `Comment.moderation_status?: string | null`; `parseYouTubeComments(data): Comment[]`; `UseCommentsOptions.platform` widened; `CommentManagerPanel` prop `platform: "facebook" | "instagram" | "youtube"`.

- [ ] **Step 1: Failing tests**

Append to `src/hooks/__tests__/useCommentInbox.test.ts`:

```ts
import { parseYouTubeComments } from "../useCommentInbox";

describe("parseYouTubeComments", () => {
  it("flattens videos → threads → replies into the inbox shape, video title as the post label", () => {
    const comments = parseYouTubeComments({
      videos: [{
        id: "v1", title: "Launch day", url: "https://www.youtube.com/watch?v=v1",
        threads: [{
          id: "t1", text: "hello", author: { id: "UC-ann", name: "Ann", avatar_url: null }, published_at: "2026-09-01T00:00:00Z",
          like_count: 2, moderation_status: "rejected", is_own: false, total_reply_count: 1,
          replies: [{ id: "r1", text: "hi", author: { id: "UC-me", name: "Me", avatar_url: null }, published_at: "2026-09-01T01:00:00Z", like_count: 0, moderation_status: null, is_own: true }],
        }],
      }],
    });
    expect(comments.map((c) => [c.id, c.is_reply, c.parent_id, c.is_hidden, c.is_own, c.post_message])).toEqual([
      ["r1", true, "t1", false, true, "Launch day"],
      ["t1", false, undefined, true, false, "Launch day"],
    ]);
    expect(comments.every((c) => c.platform === "youtube")).toBe(true);
  });
});
```

`src/components/comments/__tests__/CommentManagerPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [
      { id: "yt-old", platform: "youtube", platform_username: "Old Channel", platform_user_id: "UC-old", avatar_url: null, is_active: true, auth_provider: "native", account_metadata: {} },
      { id: "yt-cx", platform: "youtube", platform_username: "Composio Channel", platform_user_id: "UC-cx", avatar_url: null, is_active: true, auth_provider: "composio", account_metadata: {} },
    ],
  }),
}));
const useComments = vi.fn(() => ({ data: [], isLoading: false, error: null, refetch: vi.fn(), isFetching: false }));
vi.mock("@/hooks/useCommentInbox", () => ({ useComments: (opts: unknown) => useComments(opts) }));
vi.mock("react-router-dom", async (orig) => ({ ...(await orig<typeof import("react-router-dom")>()), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { CommentManagerPanel } from "../CommentManagerPanel";

describe("CommentManagerPanel for YouTube", () => {
  // The four native channels in production connected before force-ssl was requested. Loading
  // them would 403; the banner names the fix and the query is not even started.
  it("shows the reconnect banner for a channel without the comments scope and does not query", () => {
    render(<CommentManagerPanel platform="youtube" />);
    expect(screen.getByText(/Reconnect this channel on Profiles to enable comments/)).toBeInTheDocument();
    expect(useComments).toHaveBeenLastCalledWith(expect.objectContaining({ platform: "youtube", socialAccountId: "yt-old", enabled: false }));
  });
});
```

- [ ] **Step 2: Run both; expect failures.**

- [ ] **Step 3: Implement**

`useCommentInbox.ts`:
- `Comment.platform: "facebook" | "instagram" | "youtube"`, add `is_own?: boolean; moderation_status?: string | null;`.
- `UseCommentsOptions.platform` widened.
- Add:

```ts
export function parseYouTubeComments(data: any): Comment[] {
  const comments: Comment[] = [];
  for (const video of Array.isArray(data?.videos) ? data.videos : []) {
    const label = video.title || `Video ${String(video.id).slice(-6)}`;
    const toComment = (row: any, parentId?: string): Comment => ({
      id: row.id,
      author_name: row.author?.name || "Unknown",
      author_id: row.author?.id ?? undefined,
      author_avatar: row.author?.avatar_url ?? null,
      message: row.text || "",
      like_count: row.like_count,
      created_time: row.published_at,
      // rejected and heldForReview are both invisible to the public; published (or null on a
      // comment YouTube did not annotate) is visible.
      is_hidden: row.moderation_status === "rejected" || row.moderation_status === "heldForReview",
      moderation_status: row.moderation_status ?? null,
      is_own: row.is_own === true,
      is_reply: Boolean(parentId),
      parent_id: parentId,
      post_id: video.id,
      post_message: label,
      platform: "youtube",
    });
    for (const thread of video.threads ?? []) {
      comments.push(toComment(thread));
      for (const reply of thread.replies ?? []) comments.push(toComment(reply, thread.id));
    }
  }
  return comments.sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());
}
```

- In `useComments`: `const action = platform === "facebook" ? "get_page_comments" : platform === "instagram" ? "get_ig_comments" : "get_youtube_comments";`, parse with a three-way switch, `enabled: enabled && !!socialAccountId && (platform === "youtube" || !!pageId || !!igUserId)`, and `refetchInterval: platform === "youtube" ? false : 30_000` — each YouTube read is 2 quota units (list + titles), so a 30 s poll from one open tab would burn ~5,800 of the 10,000 daily units; the poller's `social_inbox_events` writes already invalidate the query, and the Refresh button covers the rest. Add a vitest case asserting the youtube query is created with `refetchInterval: false` (mock `@tanstack/react-query`'s `useQuery` and inspect the options, the way the file's existing tests do).

`CommentManagerPanel.tsx`:
- prop union add `"youtube"`; import `Youtube` from `lucide-react` and `youtubeCommentCapability` from `@/lib/youtubeCommentCapability`.
- `const needsReconnect = platform === "youtube" && !!activeAccount && youtubeCommentCapability(activeAccount) === "reconnect_required";`
- pass `enabled: !needsReconnect` to `useComments`.
- copy: `EmptyIcon` → `Youtube` for youtube; `emptyLabel` "No YouTube channels connected"; `emptyHint` "Connect a YouTube channel to manage comments."; the error card title uses `getPlatformName(platform)` instead of the hard-coded "Instagram" (`import { getPlatformName } from "@/components/PlatformIcon"`).
- banner (same markup as the IG one, rendered when `needsReconnect`): title "This channel needs reconnecting", body "Reconnect this channel on Profiles to enable comments — YouTube now asks for comment access when you connect.", button `Reconnect` → `/profiles`.
- account rows: after the username, `{a.auth_provider === "composio" && <Badge variant="outline" className="ms-1 text-[10px]">Composio</Badge>}`.

`CommentActions.tsx`: `const canDelete = comment.platform !== "youtube" || comment.is_own === true;` and render the delete trigger `disabled={!canDelete}` with `title={canDelete ? undefined : "YouTube only lets you delete your own comments — hide it instead."}`; the dialog description for youtube says "This removes your comment from YouTube." (no reply-count sentence — YouTube deletes only the one comment).

`CommentManagerPage.tsx`: `CommentPlatform` add `"youtube"`; `PlatformOption.colorPreset` add `"rose"` reuse (or `"red"` if `GradientRingCard`'s `GradientKey` has one — check `src/components/fx/GradientRingCard.tsx` GRADIENTS); `PLATFORMS` add `{ id: "youtube", label: "YouTube", colorPreset: "rose" }` guarded by the flag: build the list as `const platforms = PLATFORMS.filter((p) => p.id !== "youtube" || flags.youtubeComments)` inside the component and use `platforms` everywhere `PLATFORMS` was used; add the render branch:

```tsx
{platform === "youtube" && (
  <>
    <AutomationHandlerCard platform="youtube" surface="comments" />
    <CommentManagerPanel platform="youtube" />
  </>
)}
```

- [ ] **Step 4: Run the tests; tsc; expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCommentInbox.ts src/hooks/__tests__/useCommentInbox.test.ts src/components/comments/CommentManagerPanel.tsx src/components/comments/CommentActions.tsx src/components/comments/__tests__/CommentManagerPanel.test.tsx src/pages/comments/CommentManagerPage.tsx
git commit -m "feat(comments): YouTube tile, channel picker, reconnect banner, and own-only delete"
```

---

### Task 14: AI agent surface

**Files:**
- Modify: `src/hooks/useAiAgentConfig.ts:6`
- Modify: `src/hooks/useMessengerAutoReplies.ts:3`
- Modify: `src/components/messaging/AutomationHandlerCard.tsx:14,94-96`
- Modify: `src/components/messaging/AutoReplyManager.tsx:139-142`
- Modify: `src/pages/automation/UnifiedAgentSetupPage.tsx:24,32-37,43-48`
- Create/modify: `src/pages/automation/__tests__/UnifiedAgentSetupPage.test.tsx` (extend if it exists)

- [ ] **Step 1: Failing test** — render `UnifiedAgentSetupPage` at `?platform=youtube` with `useFeatureFlags` mocked to `{ youtubeComments: true, msgWhatsapp: true, ... }` and `useSocialAccounts` returning one youtube row; assert the "Comments" surface checkbox is checked and the "DMs" one is absent or disabled, and the platform tile "YouTube" is present. Follow the file's existing mocking pattern (look at `src/pages/automation/__tests__/` first).

- [ ] **Step 2: Implement**
  - `AiAgentPlatform = "whatsapp" | "facebook" | "instagram" | "threads" | "youtube"`.
  - `MessengerPlatform = "facebook" | "instagram" | "threads" | "youtube"`.
  - `AutomationHandlerCard` platform union add `"youtube"`; `showMessages = (surface === "dms" || surface === "both") && platform !== "youtube"` (YouTube has no inbox); description branch: `platform === "youtube" ? "Chooses which agent replies to comments on this channel's videos." : ...`.
  - `copyFor`: `return platform === "threads" || platform === "youtube" ? COPY.commentOnly : COPY.messageAndComment;`
  - `UnifiedAgentSetupPage`: `colorPreset` union add `"rose"` reuse or `"red"`; `PLATFORMS` add `{ id: "youtube", label: "YouTube", supportsComments: true, colorPreset: "rose", description: "Video comment replies and moderation", commentsLabel: "Comments" }`; `PLATFORM_FLAG.youtube = "youtubeComments"`. The page's surface checkboxes: when `platform === "youtube"`, force `surface="comments"` — add `const commentsOnly = platform === "youtube";` and pass `surface={commentsOnly ? "comments" : effectiveSurface}` to `AiAgentManager`/`AutomationHandlerCard`, and hide the DMs checkbox when `commentsOnly`. (`resolveAgentSurface` is unchanged: it models "no comments", not "no DMs"; the page owns this one exception.)

- [ ] **Step 3: Run tests + tsc. Commit**

```bash
git add src/hooks/useAiAgentConfig.ts src/hooks/useMessengerAutoReplies.ts src/components/messaging/AutomationHandlerCard.tsx src/components/messaging/AutoReplyManager.tsx src/pages/automation/UnifiedAgentSetupPage.tsx src/pages/automation/__tests__/
git commit -m "feat(agent): YouTube on the agent setup page, comments only"
```

---

### Task 15: Comment workflows

**Files:**
- Modify: `src/features/comment-workflow/domain/rule.ts:10-22`
- Modify: `src/features/comment-workflow/domain/accountChoices.ts` (+ test)
- Modify: `src/features/comment-workflow/infrastructure/commentWorkflowApi.ts:91-115` (+ test)
- Modify: `src/features/comment-workflow/ui/WorkflowRuleForm.tsx:124,497-501` (+ test)
- Modify: `src/features/comment-workflow/ui/WorkflowPool.tsx:26-31`
- Modify: `src/features/comment-workflow/domain/__tests__/ruleForm.test.ts` (Threads no-DM case gets a youtube twin)

**Interfaces:**
- `SelectableAccount` gains `auth_provider?: string | null; account_metadata?: unknown`. `isAccountConnected` for youtube: `is_active && !needs_reauth && youtubeCommentCapability(account) === "capable"` (expiry ignored). `fetchRecentPosts("youtube", ...)` calls `get_youtube_videos`.

- [ ] **Step 1: Failing tests**

Append to `accountChoices.test.ts`:

```ts
// Production 2026-09-04: every native YouTube row has token_expires_at in the past because
// YouTube refreshes just-in-time and is excluded from the refresh cron. Reading expiry as
// "disconnected" would hide every channel; the scope is what actually decides.
it("judges YouTube by the comments scope, not by token expiry", () => {
  const scope = "https://www.googleapis.com/auth/youtube.force-ssl";
  const rows = [
    account({ id: "yt-capable", platform: "youtube", token_expires_at: YESTERDAY, auth_provider: "native", account_metadata: { granted_scopes: [scope] } }),
    account({ id: "yt-old", platform: "youtube", token_expires_at: NEXT_YEAR, auth_provider: "native", account_metadata: {} }),
    account({ id: "yt-composio", platform: "youtube", token_expires_at: null, auth_provider: "composio", account_metadata: {} }),
  ];
  expect(connectedAccountsFor(rows, "youtube").map((r) => r.id)).toEqual(["yt-capable", "yt-composio"]);
  expect(reconnectNeededCount(rows, "youtube")).toBe(1);
  expect(connectedCountByPlatform(rows).youtube).toBe(2);
  expect(accountPlaceholder("youtube")).toBe("Choose a YouTube channel");
  expect(accountNoun("youtube", 2)).toBe("channels");
});
```

Append to `ruleForm.test.ts`: the Threads no-DM test duplicated for `platform: "youtube"` (drops DM and file; requires a public reply).

Append to `infrastructure/__tests__/commentWorkflowApi.test.ts`: `fetchRecentPosts("youtube", "acc", "UC1")` invokes `comment-manager` with `{ action: "get_youtube_videos", social_account_id: "acc" }` and maps `{ videos: [{ id: "v1", title: "Launch" }] }` to `[{ id: "v1", label: "Launch" }]`.

Extend `ui/__tests__/WorkflowRuleForm.test.tsx`'s mocked accounts with a capable youtube row and assert the YouTube tile reads "1 channel connected" and, once clicked, the form shows "YouTube has no private messages — this workflow replies publicly only."

- [ ] **Step 2: Run; expect failures.**

- [ ] **Step 3: Implement**
  - `rule.ts`: union + array add `"youtube"`; `supportsPrivateReply` unchanged (already fb/ig only); comment updated: "Threads and YouTube have no private messages".
  - `accountChoices.ts`: import `youtubeCommentCapability`; `isAccountConnected`:
    ```ts
    export function isAccountConnected(account: SelectableAccount): boolean {
      if (!account.is_active || account.needs_reauth) return false;
      // YouTube tokens refresh just-in-time (the platform is excluded from the refresh cron), so
      // expiry says nothing; what a funnel needs there is the comments scope.
      if (account.platform === "youtube") return youtubeCommentCapability(account) === "capable";
      return !isTokenExpired(account.token_expires_at);
    }
    ```
    `counts` seed adds `youtube: 0`; `ACCOUNT_NOUN.youtube = "channel"`; placeholder "Choose a YouTube channel".
  - `commentWorkflowApi.ts`: youtube branch — `{ action: "get_youtube_videos", social_account_id }`, throw on `data?.error`, map `data.videos` to `{ id, label: title || \`Video ${id.slice(-6)}\` }`.
  - `WorkflowRuleForm.tsx`: the effect guard `accountPlatform === "threads"` stays (YouTube does fetch); the no-DM paragraph becomes `!canDm && values.platform && (<p>{values.platform === "threads" ? "Threads" : "YouTube"} has no private messages — this workflow replies publicly only.</p>)`; the `ruleForm.ts` DM-drop rule uses `supportsPrivateReply` already — verify, else extend.
  - `WorkflowPool.tsx` FILTERS add `{ id: "youtube", label: "YouTube" }`.
  - `ruleForm.ts`: confirm the Threads branch is `!supportsPrivateReply(values.platform)` rather than `=== "threads"`; if not, change it (that is what makes the youtube twin test pass).

- [ ] **Step 4: Run the feature's tests (`bun run test -- src/features/comment-workflow`), tsc. PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/features/comment-workflow/
git commit -m "feat(comment-workflow): YouTube channels, scope-aware picker, video scope"
```

---

## Slice D — docs and rollout

### Task 16: Verification docs, privacy, project docs

**Files:**
- Modify: `src/pages/admin/oauth-verification/checklist-data/google.ts:54-73`
- Modify: `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md:66-76`, `docs/OAUTH-TOKEN-REFRESH-GUIDE.md:280-290`
- Modify: `API_REFERENCE.md` (the YouTube row ~L882 and the `youtube_thumbnail_skipped` row ~L1277)
- Modify: `src/pages/Privacy.tsx` (the data-use list near L85 and the OAuth paragraph near L170)
- Modify: `CLAUDE.md` Edge Functions table
- Create: `docs/runbooks/youtube-comments-rollout.md`

- [ ] **Step 1:** `google.ts` — add after `scope_youtube_readonly`:
```ts
{
  id: "scope_youtube_force_ssl",
  title: "youtube.force-ssl Scope Justification",
  description: "Sensitive scope (https://www.googleapis.com/auth/youtube.force-ssl) used to read comments on the user's own videos (commentThreads.list), reply to them (comments.insert), hide or unhide them (comments.setModerationStatus) and delete the user's own comments (comments.delete) from Postora's Comment Manager, auto-reply rules and AI agent — all on the user's own channel only.",
  category: "scopes",
  required: true,
},
```
and change `minimum_scopes` to "Exactly three narrow YouTube scopes requested (youtube.readonly, youtube.upload, youtube.force-ssl) — matching the OAuth request in code byte-for-byte. The broad youtube scope is intentionally not requested."
- [ ] **Step 2:** both guides: scope blocks become the three real scopes (drop `userinfo.profile`, which the code never requested); `API_REFERENCE.md` YouTube row: scopes `youtube.readonly`, `youtube.upload`, `youtube.force-ssl`, notes "All three requested at connect; `granted_scopes` recorded in `account_metadata`; comments need force-ssl." Remove the `youtube_thumbnail_skipped` "JIT escalate" row's claim (thumbnails use `upload`; there is no JIT escalation) — replace the cause with "comment scope missing on a channel connected before 2026-09 — reconnect".
- [ ] **Step 3:** Privacy: add to the list near L85 "Read, reply to, hide and delete comments on your own videos and posts when you use the Comment Manager, auto-replies or the AI agent" and, in the OAuth paragraph, "...post content, comments on your own posts and videos, and page analytics".
- [ ] **Step 4:** `CLAUDE.md` table row: `| youtube-poll-comments | Cron (every 5 min): reads new YouTube comments per channel and hands them to workflows/agent |`.
- [ ] **Step 5:** runbook `docs/runbooks/youtube-comments-rollout.md` with the exact order: (1) apply `20260904150000` via `ssh-contabo-mcp` (`docker exec -i postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -v ON_ERROR_STOP=1 < file`); (2) merge the PR; (3) deploy functions from the runtime checkout (`docs/runbooks/deploy-edge-function.md`) — new dir `youtube-poll-comments` plus every `_shared` file touched; (4) `POST /functions/v1/composio-connect/refresh-schema` for the existing YouTube connection as its owner (or reconnect); (5) enable `feature_youtube_comments` for the admin in `/admin/settings`; (6) reconnect the admin's native channel on Profiles; (7) `curl -X POST https://api.postora.cloud/functions/v1/youtube-poll-comments -H "Authorization: Bearer $CRON_SECRET"` and expect `polled ≥ 1`; (8) second call → `dispatched` counts once a fresh comment exists; (9) record the demo (spec §8.2). Include the verification queries: `select jobname, schedule from cron.job where jobname='poll-youtube-comments'` and `select count(*) from social_inbox_events where platform='youtube'`.
- [ ] **Step 6:** run `docs-guard` on the changed docs. Commit:

```bash
git add src/pages/admin/oauth-verification/checklist-data/google.ts docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md docs/OAUTH-TOKEN-REFRESH-GUIDE.md API_REFERENCE.md src/pages/Privacy.tsx CLAUDE.md docs/runbooks/youtube-comments-rollout.md
git commit -m "docs(youtube): three-scope truth, force-ssl justification, privacy, rollout runbook"
```

---

### Task 17: Gates, guards, PR, rollout

- [ ] **Step 1: Deno first** — `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/` green; `deno check` on every new/changed edge module.
- [ ] **Step 2:** `bun install` (restores `node_modules` after Deno), then `bun run test`, `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`, `bun run lint`, `bun run build` — all clean.
- [ ] **Step 3:** `clean-code-guard` on all production diffs; `test-guard` on all test diffs; fix findings; `graphify update .`.
- [ ] **Step 4:** push `feat/youtube-comments`, open the PR with the spec + plan links, the gate results, the migration note ("apply `20260904150000` before merge — the frontend auto-deploys on merge") and the trailer. Wait for the Codex bot round; address; re-run gates.
- [ ] **Step 5:** rollout per `docs/runbooks/youtube-comments-rollout.md`, in that order. Verify live in the admin browser session: YouTube tile on `/comments`, the reconnect banner on an old native channel, the Composio channel listing comments, a reply landing on YouTube, the agent page showing YouTube with comments only, the workflow tile reading "N channels connected".
- [ ] **Step 6:** mem0 `add_memory` task summary; final report to the user; hand over the demo-recording checklist (spec §8.2).

---

## Self-review

- **Spec coverage:** §1 → Tasks 1, 3, 12; §2 → Tasks 2, 6, 7, 10; §3 → Tasks 4, 5; §4 → Tasks 8, 13; §5 → Tasks 9, 14; §6 → Tasks 5, 15; §7 → Tasks 9, 10, 12; §8 → Tasks 16, 17; §9 → every task's tests + Task 11; §10 → Global Constraints.
- **Placeholders:** none — every task carries its code; the two "check the exact field names first" notes (Task 4: `ConnectorCallMeta`, Composio argument names for the two video tools) are verification steps against files/APIs the implementer has, not deferred work.
- **Type consistency:** `YouTubeCommentAccount`, `YouTubeCommentsDeps`, `YouTubeResult`, `YouTubeThreadItem`/`YouTubeCommentItem` (Task 4) are what Tasks 5, 7, 8 consume; `PolledCommentInput`/`ingestPolledComment` (Task 6) are what Task 7 consumes; `errorTypeFor`'s vocabulary (Task 8) is what Task 13's `parseYouTubeComments` consumer's error path (`throwIfCommentManagerError`) already handles; `youtubeCommentCapability` has the same signature in both copies (Task 1) and is consumed by Tasks 2, 13, 15.
