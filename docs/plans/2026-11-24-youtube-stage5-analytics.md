# YouTube Stage 5 — implementation and acceptance plan

24 November 2026 · tier **Heavy**, with one database migration · one delivery, one release candidate, one rollback plan · second revision: the owner's decisions are built in and two automated review rounds are answered (specification §§11, 13, 14). Contracts, provider citations and the design are in the [Stage 5 specification](../specs/2026-11-24-youtube-stage5-analytics.md); this plan does not restate them.

The plan follows the owner's decisions and no other option: probe first (D1); read on demand, store nothing (D2); overview, daily trend, top ten videos and one-video view (D3); periods of 7, 14, 30 and 90 days (D4); a page at `/analytics/youtube` plus a link from each video (D5); the per-channel switch protected as in Stage 4, by a migration (D6); shared daily ceilings of 1,000 Data API units and 2,000 Analytics requests (D8); test registration in the product PR by recorded exception (D9). One decision is still open, D7, and applies only if the probe shows the analytics permission is needed (step 7).

## 1. Tier, baseline and what this plan does not authorise

- **Tier: Heavy.** Two reasons under `CLAUDE.md` "Delivery tiers", each sufficient: the delivery contains **a migration**, and it adds a new authenticated endpoint that checks ownership and uses stored OAuth tokens to read a user's private channel data, which is permissions/auth and security work.
- **Merge gate: Waleed's card.** `CLAUDE.md`: "A PR that contains a migration, money or permissions/auth merges only after Waleed's card approval, once all other gates pass." The card is asked after CI is green on the exact head and shows the migration file's hash and object list. Applying the migration and merging are asked together and answered separately. Approval of the public disclosure wording (step 6) is a third question on the same card.
- **Migration before merge.** A merge to `main` deploys the edge functions within about two minutes and does not wait for migrations (`docs/runbooks/deploy-edge-function.md`). The Stage 5 function calls SQL functions that the migration creates, so the order is fixed: **production snapshot → apply the migration → verify → merge** (§5).
- **Tier duties.** Claude Fable 5.2 (medium) writes the plan — this document. Codex Astra 6.2 (medium) debates it for one round before implementation starts; the manager opens that session with `delegate_task`. The implementer runs `clean-code-guard`, `test-guard` and `waleed-security-reviewer`. The manager runs `/code-review` once on the whole PR with a different model from the implementer's. CI is green on the exact head. At most three review rounds; after the third, P2/P3 findings become issues and P0/P1 block. After the merge the manager deploys nothing further by hand: there is no staging stack, and "deploy to staging alone" is read, as in Stage 4, as "production with the rollout policy absent".
- **Baseline.** `main` at `f7d49921`. The commits since the Stage 4 merge are documents only. The manager confirmed on 2026-11-24 that the Stage 4 migration is applied in production and that a real token refresh succeeded through `store_youtube_refreshed_token_with_lease_neutral`.
- **Not authorised by this document:** any code, any migration, any call to a Google API, any production access, a branch, a push, a PR, a deployment, a flag or policy change, any part of probe P1, or rehearsal R1. Each of the last six keeps its own approval (§5).

## 2. Work in dependency order

Every delegation brief names `ARCHITECTURE.md` as required reading, with §§3–4 (feature layering), §§12–17 (edge function shape, authentication, validation, errors, logging), §§22–26 (one contract, database and migration rules, service role, CORS, external HTTP), §§33–34 (testing), §§37–38 (tokens, quota), plus `CLAUDE.md` "Task Execution Workflow" and the tier and exceptions chosen on the tier card.

### Step 0 — Preconditions (no code)

| Item | Owner | Result |
|---|---|---|
| Enable the YouTube Analytics API in the Google Cloud project. | Waleed | Needed by P1 and by the feature. |
| Read in the Cloud Console: the daily limit of the Analytics API and of the Data API; the existing features' recent daily peak on the Data API; the consent-screen status (Testing or In production); the sensitivity mark of `yt-analytics.readonly`. | Waleed | Facts the public pages do not give. The limits and the peak are needed before `mode: "all"` (D8), not before the pilot. |
| Read Google's documentation of the token information endpoint and record how the token is passed and what the answer contains. | Manager | The probe depends on it (spec §7.2); it was not fetched for the specification. |
| Read-only confirmation in production that `check_rate_limit` exists and returns `allowed`, `remaining`, `retry_after`. | Manager, under Waleed's approval | Every limiter depends on it. |
| **Probe P1**, procedure below. | **Waleed approves each part when it is about to run**; the manager runs it under that approval | The required scope set, and branch A or B. |

**P1 procedure.** Each part makes two read-only requests to Google: one to the token information endpoint, one to the Analytics API. It writes nothing to YouTube.

*P1-a — a production token.*

1. Waleed names one connected native channel and approves P1-a for it.
2. On the production host the access token is obtained through `refreshYouTubeAccountToken` **with `healthNeutral: true`**. Possible database writes, and no others: the refresh lease taken and released; if the token had to be refreshed, `access_token`, `token_expires_at`, a rotated `refresh_token` and `updated_at` through the health-neutral store. No health column and no recorded grant is touched, on success or on refusal.
3. **Effective scopes.** The helper does not report them in this mode (`supabase/functions/_shared/youtubeTokenRefresh.ts:906`). The probe asks Google's token information endpoint about **that exact access token** and takes the `scope` list from the answer. If the answer is not a `200` with a `scope` field, P1-a is **inconclusive and stops here**; no Analytics request is made.
4. **Suitability.** The token counts as evidence only if every effective scope is one of the three the connect flow requests (`youtube.readonly`, `youtube.upload`, `youtube.force-ssl`; `supabase/functions/youtube-oauth/handler.ts:414-417`) and `yt-analytics.readonly` is absent. Any other scope on the token → this channel is unsuitable; choose another or stop.
5. The request: `GET https://youtubeanalytics.googleapis.com/v2/reports` with `ids=channel==<that channel's ID>`, `startDate=<10 days ago>`, `endDate=<3 days ago>`, `metrics=views`.
6. The token is never printed and never copied into a chat, a file or a log.

*P1-b — optional, only after `ok` in P1-a.* Waleed obtains, for his own channel, a token from a consent that requests only `youtube.readonly`. Its effective scopes are read as in step 3. If they are anything other than exactly `youtube.readonly`, P1-b is abandoned. Otherwise the same Analytics request is sent.

*P1-c — only after `insufficient_permission` in P1-a.* Waleed re-consents for his own channel with the analytics scope added. The token used is one **minted from the stored refresh token after that re-consent**, not the one returned by the consent callback (spec §7.2 explains why). Its effective scopes must be exactly the P1-a set plus `yt-analytics.readonly`; any other difference → inconclusive. Then the same Analytics request is sent.

*What is recorded, in the PR and in `mem0`, and nothing else:* the part, the date, the HTTP status of each of the two requests, the token's effective scope list, and one classification from the fixed list in spec §7.2. On success, also the column header names and the number of rows. **No Google message text, no response body, no channel name, no token, no numbers.** Nothing from a production response becomes a fixture.

*Reading the result.*

| P1-a | Then | Conclusion |
|---|---|---|
| `ok` | optionally P1-b | Branch A. The required set is the P1-a scope list, or `youtube.readonly` alone if P1-b is `ok`. |
| `insufficient_permission` | P1-c | Branch B if P1-c is `ok`. If P1-c is refused, neither branch is established: stop and report. Decision D7 is then put to the owner. |
| `api_not_enabled` | enable the API, repeat P1-a once | — |
| inconclusive, or anything else | stop | Report to Waleed; do not retry. |

**If P1 has not been run when implementation starts**, the code is built for branch A with a *provisional* required set of all three existing scopes, and the PR says so in its description. That does not open a path to the pilot: **gate G-P1 (§5) blocks the first enablement** until P1 has a recorded conclusion and the deployed required set equals it.

### Step 1 — Freeze facts and fixtures

- On `main`, repeat the citations of spec §2.1 and §2.2 and correct any that moved.
- Re-read, word for word, the YouTube developer policy on stored and derived data (III.E.2, III.E.4) and record the sentences in the PR. If the policy forbids anything in spec §4.1, stop and report to the manager before writing code.
- Confirm from the `videos.list` reference how many IDs one call accepts. If fewer than ten, the title lookup is batched or reduced accordingly, and each batch is its own budget debit.
- Write offline fixtures **by hand, from the documented response shapes**: a totals answer; a daily answer; a daily answer missing its last two days; a daily answer missing a middle day; a non-empty top-videos answer with string IDs; an answer with no `rows`; a header mismatch; an explicit `null` cell; a wrong row width; an ID that fails the pattern; `The query is not supported`; one synthetic error body per classification in spec §7.2. No text from a real response is used.
- Run as green before anything changes: the `youtube-resources` capability and handler suites; the `youtube-oauth` suite; `_shared/youtubeTokenRefresh.test.ts`; every existing SQL suite.
- Inventory, on the implementation head: every policy on `app_settings`, and every reader and writer of that table in `supabase/functions` and `src`. The new policy must leave each of them unchanged (step 2).

Exit: fixtures committed, the compatibility suites green on the base, the re-read policy passage and the `app_settings` inventory attached to the PR.

Files: `supabase/functions/youtube-analytics/fixtures/*.ts` (new).

### Step 2 — The one migration and its SQL proof

One forward-only file, `supabase/migrations/<timestamp>_youtube_stage5_analytics_rollout.sql`, containing exactly the objects of spec §5.2 and nothing else:

- the RESTRICTIVE policy `app_settings_youtube_stage5_rollout_private` for the two keys `youtube_analytics_stage5_rollout` and `youtube_analytics_stage5_consent`, modelled on `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql:728-741`;
- `youtube_analytics_stage5_rollout_state()`, `youtube_analytics_stage5_capability_status(uuid, uuid)`, `youtube_analytics_stage5_credentials(uuid, uuid, text, bigint)`, `youtube_analytics_stage5_admits(uuid, uuid, text, bigint)`, each `SECURITY DEFINER`, `SET search_path = public, pg_temp`, revoked from `PUBLIC`, `anon`, `authenticated`, granted to `service_role` (model: same file `:754`, `:914`, `:1048`, `:1895-1907`);
- a closing assertion block that fails the migration if a function is not `SECURITY DEFINER` with the pinned path, if a browser role holds `EXECUTE`, or if either key exists (model: same file `:2103-2150`).

It creates **no table**, alters **no existing table, function, trigger or policy**, and seeds **no row**. Each of the three account functions decides inside one SQL statement that reads the account row and the policy row together (spec §5.2, "One snapshot per decision"). It is applied as `supabase_admin`. `src/integrations/supabase/types.ts` (generated database types) gains the four function signatures.

New suite `supabase/tests/youtube_analytics_stage5_rollout.sql`, **registered in `SUITES` in `scripts/db-harness.sh`** (`:107`). The assertions are the table in spec §9.2: old-code compatibility, privacy of both keys, privileges, policy parsing, tenant isolation, binding, no credential leak, one snapshot (two real sessions over `dblink`), and no seeding.

Exit: the suite and every existing suite are green in the disposable database; the migration's object list and SHA-256 are recorded for the approval card.

### Step 3 — Contract, window, capability, limits (pure or thin code)

- `supabase/functions/youtube-analytics/contracts.ts`: operations, envelopes (`connection_revision`, `requested_window`, `daily.coverage`), metric keys and units, the one top-videos metric list, the video-ID pattern, error codes with status **and page scope**, periods, limits, the two ceilings, the required-scope set. Runtime-neutral.
- `window.ts`: the requested Pacific-time window, three days back.
- `rollout.ts`: a thin adapter over the SQL functions, modelled on `supabase/functions/comment-manager/stage4/rollout.ts`. No policy logic; a failed call is an error.
- `capability.ts`: the pure rule over the admission answer. **`youtube-resources` is not edited.**
- `limits.ts`: the admission limiter, the per-user data limiter and the shared budget, all on `check_rate_limit`, all failing closed, modelled on `supabase/functions/comment-manager/stage4/rateLimit.ts`. The budget exposes one operation, "debit one unit for this Google API now", and nothing that reserves in advance.

Tests: `contracts.test.ts`, `window.test.ts`, `rollout.test.ts`, `capability.test.ts`, `limits.test.ts`.

### Step 4 — Provider client and bound credentials

- `analyticsReadClient.ts`: three report requests, the ownership lookup and the title lookup. 15-second timeout; every request built from structured URL parameters; `ids` from the admission answer; per-report row validation; the error mapping of spec §5.3; no database access; no import of `dropGrantedScope`. The ownership lookup returns exactly one of: *owned*, *not owned* (only from a valid `200`), or a classified failure.
- A private classifier that wraps `classifyGoogleError` (`supabase/functions/_shared/youtubeApiErrors.ts`) without changing it.
- `credentials.ts`: the bound refresh store — `createSupabaseYouTubeRefreshStore(admin)` with `readAccount` replaced by a call to `youtube_analytics_stage5_credentials` carrying the admitted channel and generation (spec §5.4). **`_shared/youtubeTokenRefresh.ts` is not edited.**

Tests: `analyticsReadClient.test.ts` with a fake `fetch`; `credentials.test.ts`.

### Step 5 — Handler, audit, wiring, CI step

- `handler.ts` with injected ports (auth, rollout, limits, credentials, tokens, provider, audit, clock, IDs) and the fixed order of spec §5.3: admission limit → validation → SQL admission → capability → per-user data limit → bound credentials → token → [budget debit → ownership lookup] → budget debit → Analytics → validation → [budget debit → titles] → **final recheck as the last step before the response** → response. The `401` rule of spec §5.3: at most one forced refresh per request, never for a token this request refreshed itself; every other `401` is `reconnect_required`.
- Every response, success or refusal, sets `Cache-Control: no-store`.
- `audit.ts`: no row and no second database call for an admission refusal; other refusals at most 20 rows per user per minute through a shared bucket; the suppressed count is best effort, one console line per worker per minute; one `info` row per successful data operation; nothing for anonymous callers (spec §6, rule 7).
- `index.ts`: builds the ports. Tokens only through `refreshYouTubeAccountToken` with `healthNeutral: true` and the bound store. `restrictedCorsHeaders`.
- `supabase/config.toml`: register the function with the same JWT setting as `youtube-resources`, if that file lists functions on the implementation head (it did not match a search at the baseline; check before editing).
- `.github/workflows/ci.yml`: a named step "Typecheck and test youtube-analytics" next to the `youtube-resources` step (`:464-469`), under the recorded exception D9 (§4).

Tests: `handler.test.ts` with fake ports (every row of the provider-call table, with token, Data, Analytics and debit counters), the binding-race suite (a)–(e), revocation in flight, the audit bound with two handler instances, the health-neutrality suite, the `no-store` assertion, and a composition test for `index.ts` (spec §9.1).

Exit of steps 2–5: the function is complete and dark; nothing in the browser calls it yet. Per ARCHITECTURE §1 it must not merge alone — steps 2–6 and 8 are one PR.

### Step 6 — The page

- `src/features/youtube-analytics/` with `domain`, `application`, `infrastructure`, `ui`, `tests`, `index.ts` (spec §5.7).
- Query keys are `[user, account, connection_revision, period, video]`; no data query runs before `status` returns a revision; a new revision removes the old one's reports.
- `useAccessLease.ts`: `status` every 60 seconds while visible; reports displayed only within 90 seconds of a successful check; hidden when the lease lapses; removed on an account-scoped code; nothing shown after a hidden tab or an offline period until a check succeeds. `video_not_found` touches the video panel only.
- No automatic retry, no refetch on network return, on remount of a failed block, or on focus. Confirm the option names against the installed `@tanstack/react-query` 5.x (`package.json:52`) and record them in the PR.
- `domain/trendSeries.ts`: one chart point per requested day, `null` where Google returned no row; the line is drawn with `connectNulls={false}`, as in `src/features/analytics-contract/ui/SavedAnalyticsReport.tsx:69-71`. The period line, the last-returned-day line and the "did not return" note follow spec §5.8.
- `src/pages/analytics/YouTubeAnalytics.tsx`; route `/analytics/youtube` in `src/components/AnimatedRoutes.tsx`; sidebar child in `src/components/layout/DashboardLayout.tsx`; flag `feature_analytics_youtube` → `analyticsYoutube` in `src/hooks/useFeatureFlags.tsx` (default `false`, label, admin list).
- "View analytics" link in `src/features/youtube-management/ui/YouTubeVideoDetail.tsx`, shown only with the flag on. Frontend only.
- Arabic: a `youtube` group in `src/i18n/locales/ar/analytics.json`; the sidebar label in `src/i18n/locales/ar/nav.json`. English inline.

Tests: Vitest and Testing Library per spec §9.3, the layering test, the route and flag wiring test, and the shared request fixture used by both the Deno handler test and the Vitest gateway test.

Public text and documents, in the same PR:

- `src/pages/GoogleApiDisclosure.tsx`, as **two separate commits**:
  1. *Scope-list correction.* List the scopes Postora really requests today, including `youtube.force-ssl`, and remove "exactly two". True whatever happens to Stage 5; never reverted with it.
  2. *Analytics wording.* Replace the sentences that say Postora never reads YouTube Analytics with an accurate description: read-only, the owner's own channel, shown to that owner only, not stored, and only for accounts where analytics is enabled.
  **Both wordings are sent to Waleed for approval on the merge card.**
- `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`: the scope table, the privacy-policy block and the consent-screen status as read in step 0. The `/privacy` page gets the same sentence if it describes Google data.
- New runbook `docs/runbooks/youtube-analytics-rollout.md`: applying and verifying the migration; the switches and which one is the access switch; the policy JSON with examples; gate G-P1; how to add and remove a channel; how to switch everything off; the incident steps of §6; P1 and R1 as numbered procedures; what to check after the merge.
- `CLAUDE.md`: one row for `youtube-analytics` in the Edge Functions table. `docs/developer/analytics.md`: one line stating that YouTube analytics is on demand through `youtube-analytics` and is not served by `get_account_analytics`.
- `docs-guard` on every document touched, including this plan and the specification.

### Step 7 — Only if P1 leads to branch B, and only after decision D7

Not built unless the probe requires it. Written for the recommended option D7-A (spec §7.4); the owner has not yet been asked.

- A **second small migration**: `youtube_analytics_stage5_consent_admits(uuid)`, service-only, same rules as step 2; and a replacement of the rollout state and capability-status functions that adds the consent-before-data rule (`rollout_blocked_by_consent`; an allow-listed account whose owner the consent gate does not admit is not admitted). The policy already covers the consent key. SQL suite extended accordingly. Snapshot, apply before merge, owner's card — the same sequence as §5.
- `supabase/functions/youtube-oauth/handler.ts`: the authorise action adds `https://www.googleapis.com/auth/yt-analytics.readonly` **only when the consent function admits the signed-in user**. A failed or negative answer → today's three scopes, and the connection proceeds.
- The required-scope set in `youtube-analytics/contracts.ts` gains that scope.
- Tests: with the consent key absent, `off`, malformed or unreadable, the authorise URL is **byte-identical** to today's; with `users`, only a listed user gets four scopes; with `all`, everyone does; a grant that omits the analytics scope is recorded as given and yields `missing_scope`; rollout `all` with consent not `all` denies everyone; publishing and comment capabilities are unchanged for every fixture.
- The disclosure page and the verification guide describe the fourth scope as requested only where analytics is enabled.
- If the Cloud Console marks the scope sensitive: Waleed submits it for Google verification. Until Google approves, consent stays at `users` with the named pilot, and data rollout stays at `allowlist`.
- After the first pilot owner reconnects, P1-c is repeated on that account before it is added to the rollout policy.

Under D7-B this step is a separate later PR after Google's approval, and the feature stays dark until then. D7-C is not planned.

### Step 8 — Journey, integrate, review, hand over

- `e2e/fixtures/youtubeStage5Server.ts`, `e2e/youtube-stage5.spec.ts`, `scripts/stage5-e2e.mjs` (spec §9.4): the real handler and the real SQL functions on the disposable database with the Stage 5 migration applied, a counting fake provider, English and Arabic; the command, head SHA and result go in the PR.
- Run every gate of §3 on the actual head. Implementer guards; the manager's single whole-PR `/code-review`; CI and bot rounds under the round cap; then §5.
- `graphify update .` after the code lands.

## 3. Acceptance evidence

All automated evidence is offline. Each case asserts the visible result and the count of requests to the token endpoint, the Data API and the Analytics API, and the number of budget debits.

| Layer | Required observations |
|---|---|
| **Isolated SQL** | The table of spec §9.2, run by the `db-harness` job, with the one-snapshot case in two real sessions. Every pre-existing suite still green. |
| **Deno: contract, window, rollout adapter, limits** | Spec §9.1 rows 1–4. The budget is debited once immediately before every Google call, including a repeat after `401` and a title lookup; a debit refused mid-request gives the answers of spec §5.6. |
| **Deno: bound credentials** | With the binding changed before the helper's read, no token exchange starts. |
| **Deno: provider client** | Structured URL parameters; `ids` from the admission answer; per-report row validation including string video IDs, explicit `null`, missing days and out-of-window dates; each error class; no provider text in a result; titles only for rows whose channel matches. |
| **Deno: handler** | **Counts exactly as in the provider-call table of spec §5.3.** Zero calls of any kind for every refusal decided before provider access. One Data call and zero Analytics calls for a video that is not owned and for a failed ownership lookup. The three `401` cases that end in `reconnect_required` without a repeat. `video_not_found` only after a successful lookup. `Cache-Control: no-store` on every response. No token in any response or log line. |
| **Deno: binding and revocation** | The five injection points of spec §9.1, with zero token-endpoint and zero YouTube calls after a change at (a), (b) and (d), nothing stored at (c), and the result discarded at (e). The policy switched off mid-request → `not_enabled`. The residual after the final recheck is documented by a test, not denied. |
| **Deno: audit** | Two handler instances: 20 rows in total for 30 refusals in a minute; an admission refusal writes no row and makes no second database call; one `info` row per successful data operation; no anonymous rows. |
| **Deno: health neutrality** | No path writes `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`; an expired token leads to exactly one write, through the neutral store; the function does not import `dropGrantedScope`. |
| **Deno: compatibility** | The step 1 suites replayed unchanged. No file of `youtube-resources`, `youtube-oauth` or `_shared` is edited (branch A). |
| **Vitest** | Spec §9.3: connection revision in keys and purge on change with no request in flight; the access lease in all its cases; `video_not_found` scoped to the panel; no request after a refusal on network return or remount; chart breaks at missing days and no zero; account switch never shows the previous account's numbers; every state has its own message; no net-subscriber or comparison figure; Arabic and right-to-left. |
| **Playwright, English and Arabic, real local handler and SQL** | The sixteen journey steps of spec §9.4, with the provider counts asserted at each and a failure on any unexpected external request. |
| **Documents** | `docs-guard` clean on every touched document. |

### Denied effects — each must be shown impossible, not merely untested

1. A provider request for an account that is not owned, not active, not YouTube, not native, or not admitted by the rollout policy.
2. A channel ID or video owner taken from the browser; a video ID sent to Google without passing the format check.
3. **A credential read, a token exchange or a YouTube request started for a connection other than the admitted one** — after a disconnect, a reconnect on the same row, or a provider switch.
4. Numbers of one channel shown to another user, or to the same user under another selected channel or a previous connection of the same channel.
5. A number returned by a request whose final recheck saw a changed connection or a withdrawn rollout.
6. Reports displayed without a successful access check in the last 90 seconds; reports displayed on return from a hidden tab or an offline period before a check succeeds.
7. **Storage.** Any analytics value, video title or provider body in a database table or a log. Any token in a log, a response, or any table other than the account row. **Permitted, and the only permitted token write:** the existing health-neutral store saving a refreshed access token (and a rotated refresh token, if Google sends one) to the account row under the refresh lease. Any response without `Cache-Control: no-store`.
8. Any write to `needs_reauth`, `failure_count`, `last_refresh_error` or recorded grants caused by an analytics request.
9. A number computed by Postora from YouTube numbers; a day drawn as zero, or two days joined across a day Google did not return.
10. A failed or refused read shown as an empty report; a failed ownership lookup shown as a missing video; a missing video removing the channel's reports.
11. A Google request made without its own budget debit; more YouTube requests in a day than the two ceilings; a request the owner did not ask for after a refusal.
12. The rollout or consent key readable or writable by a non-admin browser session; any of the four functions executable by a browser role.
13. Any change in the behaviour of another `app_settings` key, or in the responses or files of `youtube-resources`, `youtube-oauth` (branch A), publishing, comments, the Partner API, n8n or MCP.
14. Unbounded audit rows, or unbounded audit work, from one caller.
15. A channel enabled while the scope question is open (gate G-P1).

## 4. CI facts this plan must respect

| Fact at the baseline | Consequence |
|---|---|
| Each YouTube function has its own named Deno step (`.github/workflows/ci.yml:457-485`). | Add "Typecheck and test youtube-analytics"; confirm in the job log on the final head that every new test file ran. |
| SQL suites run only if listed in `SUITES` in `scripts/db-harness.sh` (`:107`), on the baseline plus every migration; a suite on disk but not listed fails the harness. | Register the new suite; record its run on the final head. |
| Playwright is not a CI job. | The journeys are local evidence recorded in the PR, as in Stage 4. Making Playwright a job is a separate CI PR. |
| Vitest runs in two shards behind a required aggregate; lint and i18n are compared with the immutable base. | New copy keys must not regress the comparison; every new English string has its Arabic entry. |
| `.github/workflows/owner-analytics-local.yml` triggers on `supabase/functions/_shared/**`. | This delivery edits no file under `_shared`; if a reviewer asks for one, expect that workflow to run. |
| Live suites never run in CI. | No Stage 5 test calls Google. |

**The CI rule and the recorded exception (D9).** `CLAUDE.md` ("CI critical path and measurement") asks for CI changes in a dedicated reviewed PR. The owner recorded an exception on one point only: **where** the registration lands. The Deno step and the SQL suite are registered in the product PR, because a test for code that does not yet exist cannot be registered first and a registration made afterwards would not gate the merge that introduces the code.

The exception does not change **how** the effect is measured. The rule's measurement applies as written:

- **Before:** links to five comparable successful **first-attempt** runs of code PRs from before this change.
- **After:** aim for five such runs of code PRs after it; if volume is low, report the available sample and its limits.
- Runs on `main`, reruns, different runners and differing cache conditions are kept **separate**, never pooled with the PR cohort. This PR's own runs are supporting evidence, not the "after" cohort.
- For each cohort: wall time to the required gate, aggregate runner minutes, failures, retries, and any observed resource pressure. Per-job times of "Deno service and publishing suites" and the database harness are supporting detail.
- A responsible owner and a due date are entered in the project tracker when the PR opens.
- Two weeks after the merge, one report goes to Waleed with sample sizes, medians, absolute and percentage changes, and the cost and reliability trade-offs.

Details of the procedure: `docs/runbooks/ci-critical-path.md`.

## 5. Release sequence

There is no staging stack; the environment is production.

| # | Step | Owner | Gate |
|---|---|---|---|
| 0 | Step 0 of §2: API enabled, Console readings, token-information reading, `check_rate_limit` confirmation. P1 if approved. | Waleed, manager | Before implementation, except P1, which may come later but not after G-P1 |
| 1 | Implementation, guards, whole-PR review, CI and bots green on the exact head. | Implementer, manager | — |
| 2 | **Approval card after CI is green on that head.** It shows the migration file's SHA-256 and object list, and the two disclosure wordings. Applying the migration and merging are asked together and answered separately. | **Waleed** | **Required** |
| 3 | **Production database snapshot.** Keep the receipt. | Waleed, or the manager under that approval | Before any DDL |
| 4 | **Apply the migration as `supabase_admin`.** Verify: the policy exists and names exactly the two keys; the four functions exist, are `SECURITY DEFINER` with the pinned `search_path`, and are executable by `service_role` only; neither key exists; a non-admin session still reads every `feature_*` key and the eleven allow-listed keys; an admin still reads and writes settings. Run the no-provider probes: `capability_status` for an owned synthetic account answers "not admitted", for a random ID "not found". | Same | **Before the merge** |
| 5 | **Merge.** Verify the synced `youtube-analytics` files by SHA-256 against `git show <merge>:<path>`. | Manager | Policy absent → no channel can reach Google through Stage 5 |
| 6 | Verify in production with everything off: `status` answers `not_enabled` for an owned channel and `not_found` for a random ID, each with `Cache-Control: no-store` **on the deployed route**; the YouTube Channel page, publishing and comments are unchanged; the connect flow asks for the same three scopes; the disclosure page shows the approved text; the analytics page is not visible. | Manager | — |
| **G-P1** | **Scope gate.** P1 has a recorded conclusion (step 0), and the required-scope set in `git show <deployed head>:supabase/functions/youtube-analytics/contracts.ts` equals it. If the code was built with a provisional set and the conclusion differs, the constant is changed by a reviewed PR and this row is checked again on the new head. Under a branch B conclusion, step 7 and decision D7 come first. | Manager records; **Waleed confirms** | **Blocks row 7.** No channel is added to the rollout policy before it. |
| 7 | Enablement, one step per approval: **(a)** rollout policy `allowlist` with one named channel — the go-live for that channel; **(b)** flag `feature_analytics_youtube` on; **(c)** rehearsal R1, read-only; **(d)** the remaining pilot channels, by adding their IDs; **(e)** `mode: "all"`, only after both Google limits and the existing features' peak have been read and the two ceilings reviewed against them. | **Waleed** | Never implied by the merge or by an earlier approval |
| 8 | Plan summary after the merge in the `CLAUDE.md` format («ما تم»، «الباقي»، «التوصية»), and a `mem0` record. | Manager | — |

**Branch B changes row 7.** Before (a): the consent gate is set to `users` with the named pilot users; each pilot owner reconnects and grants the scope; P1-c is repeated on the first of them. Steps (a)–(d) then proceed for those owners' channels only. **Data stays at `allowlist` until consent is `all`.** The order at the end is: Google approves the scope → consent gate `all` (its own approval) → rollout `mode: "all"` (its own approval). The SQL rule of spec §7.4 refuses the opposite order.

## 6. Rollback

Containment and recovery are different things.

**Containment — stopping further disclosure.**

1. **Set the policy `mode` to `off`, or remove the key.** From the next request, every channel is refused before any credential is read or any provider is called, in running instances too.
2. A request already in flight has its result discarded **if its final recheck sees the change**. A response whose final recheck passed a few milliseconds earlier is delivered; that window cannot be closed and is not claimed to be.
3. Pages already open: reports leave the screen at the next status check, at most about 60 seconds later; if that check cannot complete, they are hidden when the access lease lapses, at most 90 seconds after the last successful check; a tab in the background shows nothing on return until a check succeeds. Turning the flag off does not shorten any of this and does not stop access; it only hides the page on the next navigation.
4. If a faster cut is needed for a wrong-channel incident, revert the frontend build; a reload then no longer contains the page. This is a deploy, not a switch.

**Recovery — after an incident in which numbers reached someone who should not have seen them.** Switching the policy off does not undo that.

1. From the `info` audit rows in `system_logs` (source `youtube-analytics`), list which accounts received which operations in the window. The rows hold no numbers.
2. Establish the cause before re-enabling anything. The policy stays off.
3. Waleed decides what the affected owners are told.

**Triggers:** numbers shown for the wrong channel or a previous connection; any change to account health or grants traced to analytics; Google quota pressure on publishing or comments; provider errors surfacing as empty reports; any change in an existing response or in another setting's visibility.

**Code rollback.** Revert the feature commits. The frontend redeploys on push and the schedule removes the function directory on its next run. There is no stored data to clean up. An old frontend against the new backend never calls the function; a new frontend against an old backend gets a failed `status` call and shows the temporary-failure state.

**The migration is not rolled back.** The policy and the four functions stay: with the code reverted nothing calls the functions, and the policy only keeps two unused keys private. Removing them would be a second migration with its own snapshot and approval. If the policy itself is the fault (another setting became unreadable), the immediate action is `DROP POLICY app_settings_youtube_stage5_rollout_private` under Waleed's approval, with the rollout key removed first; the keys then fall back to the allow-list, which already hides them from non-admin sessions (`supabase/migrations/20261029170000_media_upload_limits.sql:17-39`).

**The disclosure text after a rollback** must describe what the running system does:

- The scope-list correction (step 6, commit 1) is not reverted. It was already true before Stage 5.
- The analytics wording (commit 2) is reverted together with the feature code, whether or not a pilot ever ran.
- If only the policy is switched off and the code stays, the analytics wording stays: it says analytics is read only where enabled.
- Branch B: while the consent gate admits anyone, the page lists four scopes. When the gate is set to `off`, or the scope code is reverted, the page goes back to three in the same change.

**Branch B.** Setting the consent gate to `off` restores today's consent request at the next click. Channels that already granted the scope keep the grant until they disconnect or revoke it.

## 7. Acceptance gates

The delivery is accepted when all of these hold on the merged head:

- [ ] Every row of §3 is green, with the commands and results attached to the PR.
- [ ] Every denied effect in §3 is covered by a named test.
- [ ] The migration was applied before the merge, after a snapshot whose receipt is kept; its SHA-256 matches the file on the merged head; the checks of §5 row 4 are recorded.
- [ ] With the policy absent, production behaves exactly as before the merge (§5 row 6), including every other setting's visibility.
- [ ] Gate G-P1 was recorded before the first channel was enabled.
- [ ] The owner of an admitted native channel sees the overview cards, the daily trend and the ten most viewed videos for 7, 14, 30 and 90 days, in English and in Arabic, at `/analytics/youtube` from the Analytics menu.
- [ ] The owner sees the overview and trend for one video, reached from the list and from "View analytics" on the YouTube Channel page; another channel's video ID shows "not available on this channel" in the video panel, with one Data call and no Analytics call per read, and leaves the channel reports on screen.
- [ ] A channel that is not admitted, a Composio channel, a channel needing reconnect and a channel without the permission each get their own message and cause zero requests to Google.
- [ ] The page shows the requested period and, separately, the last day Google returned; a day not returned breaks the line and is never zero; the note says only that Google did not return it.
- [ ] No request follows a quota, capacity, rate-limit or permission refusal unless the owner asks for one, including after the network returns.
- [ ] Switching the policy off removes reports from an open page at the next check; a failing check hides them within 90 seconds; a reconnect in another tab removes the old connection's reports.
- [ ] No analytics request changes `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`; a request with an expired token stores the refreshed token and nothing else.
- [ ] Each ceiling refuses with `capacity_reached` when spent, including for a repeat after `401`, and refuses when its counter cannot be read.
- [ ] The rollout key is unreadable and unwritable by non-admin sessions, by policy.
- [ ] Every response from the deployed route carries `Cache-Control: no-store`.
- [ ] The public disclosure lists the scopes actually requested and describes the analytics read.
- [ ] The new tests ran in CI on the final head; the "before" cohort links, the tracker entry with owner and due date, and the plan for the two-week report are attached.
- [ ] R1 has been run on the pilot channel; what it actually observed is recorded; the owner has compared one period with YouTube Studio.
- [ ] The runbook exists and its migration and enablement commands were executed once.

Under branch B, in addition: with the consent gate off, the connect flow asks for exactly today's three scopes; rollout `all` with consent not `all` admits nobody; P1-c was repeated on the first pilot account.

## 8. Design verification performed

- Code read through `git show` at `f7d49921`; nothing was checked out, and no file in the repository was written. The list is in spec §12.
- Google pages fetched on 2026-11-23; none was re-fetched since. Passages that could only be summarised are marked in the specification and re-read in step 1. Google's token information endpoint was not fetched and is read in step 0.
- Review round 1: 33 comments on pull request #472 (spec §13). Review round 2: 21 comments, GitHub issue #473 (spec §14).
- Not done, by instruction: code, migration, branch, commit, PR, production access, any call to a Google API. `mem0` was not consulted from the design session.

## 9. Contract summary for the implementer

One migration adds a RESTRICTIVE policy that keeps two rollout keys private and four service-only SQL functions; no table, no change to anything that exists. One new read-only function, `youtube-analytics`, with four operations (`status`, `summary`, `daily`, `top_videos`), serves a new page at `/analytics/youtube`. It reads the YouTube Analytics API on demand for one owned, native, admitted channel and stores nothing new.

Admission — ownership, the rollout policy and the connection's generation — is decided in SQL from one snapshot. Credentials are released only by a function that requires the admitted channel and generation, and the shared refresh helper is given a store that reads through that function, so no token exchange can start for a replacement connection. The same conditions are rechecked as the last step before a response is written, and a result that fails the recheck is discarded. A request may force one token refresh at most; any other `401` is `reconnect_required`.

A video is used only after a successful ownership lookup; a failed lookup is never "not found", and a missing video never clears the channel's reports. Rows are validated per report; the top-videos report has one fixed metric list. The requested period and the days Google actually returned are reported separately, and a day not returned breaks the chart line.

Limits fail closed: admission per user, data per user, and a shared daily ceiling per Google API that is debited once immediately before every Google call, including repeats. The ceiling limits Stage 5's own draw; it reserves nothing for other features.

In the browser, every report is keyed by the connection revision and shown only under an access check that succeeded in the last 90 seconds. Nothing is fetched again after a refusal unless the owner asks. Every response is `no-store`. No analytics path changes account health or recorded grants; the only token write is the existing health-neutral store.

The rollout policy is the access switch; the flag only shows the page. The required permission set is one constant, set by probe P1 from the effective scopes of the token it sent, and no channel is enabled until that is recorded and deployed. If the analytics scope is needed, it waits for decision D7. The order of release is snapshot, migration, merge, and the merge needs the owner's card.
