# YouTube Stage 5 — implementation and acceptance plan

24 November 2026 · tier **Heavy**, with one database migration · one delivery, one release candidate, one rollback plan · third revision: the owner's decisions are built in, and the plan debate's seven blocking objections and a third automated review are answered (specification §14). Contracts, provider citations and the design are in the [Stage 5 specification](../specs/2026-11-24-youtube-stage5-analytics.md); this plan does not restate them.

The plan follows the owner's decisions and no other option: probe first (D1); read on demand, store nothing (D2); overview, daily trend, top ten videos and one-video view (D3); periods 7, 14, 30, 90 (D4); a page at `/analytics/youtube` plus a link from each video (D5); the per-channel switch protected as in Stage 4, by a migration (D6); shared ceilings of 1,000 Data API units and 2,000 Analytics attempts per Pacific day (D8); test registration in the product PR by recorded exception (D9). **Still open:** D10 (consent to the new purpose), D11 (a non-reusable connection identity), D7 and D12 (only if the probe requires the analytics permission). §8 says what changes if an open decision is answered otherwise.

## 1. Tier, baseline and what this plan does not authorise

- **Tier: Heavy.** Two reasons under `CLAUDE.md` "Delivery tiers", each sufficient: it contains **a migration**, and it adds an authenticated endpoint that checks ownership and uses stored OAuth tokens to read a user's private channel data (permissions/auth, security).
- **Merge gate: Waleed's card.** `CLAUDE.md`: "A PR that contains a migration, money or permissions/auth merges only after Waleed's card approval, once all other gates pass." The card is asked after CI is green on the exact head and shows the migration file's SHA-256 and object list. Applying the migration and merging are asked together and answered separately; the two disclosure wordings, D10 and D11 are on the same card.
- **Order: snapshot → apply the migration → verify → merge.** A merge to `main` deploys the edge functions within about two minutes and does not wait for migrations (`docs/runbooks/deploy-edge-function.md`). The function calls SQL that the migration creates.
- **Tier duties.** The implementer runs `clean-code-guard`, `test-guard` and `waleed-security-reviewer`; the manager runs `/code-review` once on the whole PR with a model different from the implementer's; CI is green on the exact head; at most three review rounds, after which P2/P3 findings become issues and P0/P1 block. This plan and the specification have had their Heavy debate (one round, Codex); the next debate, if any, is the manager's call. There is no staging stack: "deploy to staging alone" is read, as in Stage 4, as "production with the rollout policy absent".
- **Baseline.** `main` at `5d020ed`; code identical to the Stage 4 merge. The Stage 4 migration is applied in production (manager, 2026-11-24).
- **Not authorised by this document:** any code, any migration, any call to a Google API, any production access, a branch, a push, a PR, a deployment, a flag or policy change, any part of P1, or rehearsal R1. Each of those keeps its own approval (§5).

## 2. Work in dependency order

Every delegation brief names `ARCHITECTURE.md` as required reading, with §§3–4, §§12–17, §§22–26, §§33–34, §§37–38, plus `CLAUDE.md` "Task Execution Workflow" and the tier chosen on the tier card.

### Step 0 — Preconditions (no code)

| Item | Owner | Result |
|---|---|---|
| Enable the YouTube Analytics API in the Google Cloud project. | Waleed | Needed by P1 and by the feature. |
| Read in the Cloud Console: the daily limits of the Analytics and Data APIs; the existing features' recent daily peak on the Data API; the consent-screen status; the sensitivity mark of `yt-analytics.readonly`. | Waleed | The limits and the peak are needed before `mode: "all"` (D8), not before the pilot. |
| Read-only confirmation in production: `check_rate_limit` and `cleanup_rate_limit_buckets` exist as in the baseline and whether the cleanup is scheduled; `store_youtube_refreshed_token_with_lease_neutral` and `binding_generation` exist (done once on 2026-11-24 for the neutral store). | Manager, under Waleed's approval | Three objects the design depends on. |
| **Consent text.** Read what each intended pilot owner accepted when they signed up and connected (`src/pages/Privacy.tsx`, `src/pages/Terms.tsx`, the connect dialog) and record the version or date. | Manager | Input to D10 and G-consent. |
| Read Google's documentation of the token information endpoint and of the Playground's token response. | Manager | The probe depends on them (spec §7.2). |
| Answer D10 and D11. | Waleed | The migration and the enablement gate are written accordingly. |
| **Probe P1** (below). | Waleed approves **each part when it is about to run** | The required scope set and the branch. |

**P1 procedure** (design in spec §7.2). Every request is read-only; nothing is written to YouTube.

*Preparation.* Waleed names one channel he owns for P1-a. The manager prepares the four shipped shapes S1–S4 over a seven-day window ending at the current reporting end date.

*P1-a — production, the owner's own channel, attended.*

1. Obtain the access token. If the Stage 5 code does not exist yet, use `refreshYouTubeAccountToken` with `healthNeutral: true` on that one account, with Waleed not connecting or disconnecting it meanwhile. If it exists, use the bound path. Possible database writes: the lease row, taken and released; if a refresh was needed, the token columns through the neutral store. Nothing else.
2. **Effective scopes:** `POST https://oauth2.googleapis.com/tokeninfo` with the token in an `Authorization: Bearer` header; read the `scope` field. Not a `200` with `scope` → **inconclusive, stop**. Token never in a URL, log, chat or file; 10-second timeout.
3. **Eligibility:** every effective scope is one of `youtube.readonly`, `youtube.upload`, `youtube.force-ssl`, and `yt-analytics.readonly` is absent. Otherwise this channel is unsuitable.
4. Send S1–S4 with that token. Classify each from the fixed list.
5. Conclude by the table in spec §7.2: all four `ok` → branch A for exactly that set; refusal with a token that carries **all three** → go to P1-c; refusal with a proper subset, or anything else → inconclusive (repeat with a suitable token or stop and report; no automatic retry).

*P1-b (optional) and P1-c — isolated, decision D12.* Waleed runs them himself in Google's OAuth 2.0 Playground with a separate test OAuth client (recommended) on a channel he owns; the client secret is entered only by him and never shared. For P1-c: (i) authorise the three existing scopes and send S1–S4 — expect `insufficient_permission`; (ii) authorise those three plus `yt-analytics.readonly` — all four `ok` means branch B. The effective scopes of each token are read from the `scope` field of the token response the Playground shows. The same channel, client and requests throughout. Nothing is written to Postora.

*What is recorded, in the PR and in `mem0`, and nothing else:* the part, the date, the HTTP status of each request, the token's effective scope list, one classification each, and on success the column header names and row count. **No Google message text, no response body, no channel name, no token, no numbers.** Nothing from a production response becomes a fixture.

Exit: the required scope set and the branch are known. If P1 has not run when implementation starts, the code is built for branch A with a *provisional* required set of all three existing scopes and the PR says so; **gate G-P1 (§5) blocks the first enablement** until P1 has a recorded conclusion and the deployed constant equals it.

### Step 1 — Freeze facts and fixtures

- On `main`, repeat the citations of spec §2.1 and §2.2 and correct any that moved.
- Read word for word, and record in the PR: the developer policy III.E.2–4 and **III.E.3** (consent), and the channel-reports rule for the video report. If III.E.3 requires more than D10's recommended option provides, stop and report before writing code. If the policy forbids anything in spec §4.1, stop and report.
- Confirm from the `videos.list` reference how many IDs one call accepts. If fewer than ten, the title lookup sends fewer and never retries with a smaller list.
- Write offline fixtures **by hand, from the documented response shapes** (no text from a real response): totals; daily; daily missing its last two days; daily missing a middle day; a non-empty top-videos answer with string IDs; no `rows`; a header mismatch; an explicit `null`; a wrong width; an ID failing the pattern; `404 videoNotFound`; `The query is not supported`; one synthetic body per classification of spec §7.2.
- Run green before anything changes: the `youtube-resources` capability and handler suites; the `youtube-oauth` suite; `_shared/youtubeTokenRefresh.test.ts`; every existing SQL suite.
- **Inventories on the implementation head**, attached to the PR: every policy on `app_settings` and every reader and writer of that table in `supabase/functions` and `src`; and, for the added `social_accounts` column, Stage 4's list again — positional inserts, `%ROWTYPE`, `RETURNS … social_accounts`, `select("*")` readers, generated types, existing triggers on the table.

Exit: fixtures committed, compatibility suites green on the base, the re-read policy passages and both inventories in the PR.

### Step 2 — The one migration and its SQL proof

One forward-only file, `supabase/migrations/<timestamp>_youtube_stage5_analytics_rollout.sql`, with exactly the objects of spec §5.2 and nothing else:

- the RESTRICTIVE policy `app_settings_youtube_stage5_rollout_private` (both keys, `USING` and `WITH CHECK`), modelled on `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql:728-741`;
- **(D11)** `social_accounts.binding_incarnation uuid` (nullable, no default) and its `BEFORE INSERT OR UPDATE` trigger function, shaped like `youtube_stage4_assign_binding_generation` (same file `:374-440`);
- `youtube_analytics_stage5_parse_policy`, `youtube_analytics_stage5_decide`, `youtube_analytics_stage5_acquire_lease`, `youtube_analytics_stage5_store_token`, each `SECURITY DEFINER` with `SET search_path = public, pg_temp`, granted to `service_role` only (the parser to nobody), models at `:754-1082` and `:1895-1907`;
- a closing assertion block that fails the migration if a function lacks `SECURITY DEFINER` and the pinned path, if a browser role holds `EXECUTE`, if the narrow role `youtube_stage4_refresh` owns anything beyond the three Stage 4 functions, or if either key exists (model `:2103-2150`).

It creates no table, alters no existing function, trigger or policy, and seeds no row. It is applied as `supabase_admin`. `decide` is one SQL statement (spec §5.2). The two wrappers lock the account row first, never hold a lock across Google I/O, and call the existing lease and neutral-store functions unchanged (spec §5.3). The generated types in `src/integrations/supabase/types.ts` gain the new column and function signatures.

New suite `supabase/tests/youtube_analytics_stage5_rollout.sql`, **registered in `SUITES` in `scripts/db-harness.sh`** (`:107`): the table of spec §9.2 — old-code compatibility, privacy, privileges, incarnation, `decide`, the discriminating snapshot test with its mutant, the bound lease and store interleavings in two real sessions, the budget buckets against the real RPC, and no seeding.

Exit: the suite and every existing suite green in a disposable database; the object list and SHA-256 recorded for the card.

### Step 3 — Contract, window, decision adapter, limits

- `supabase/functions/youtube-analytics/contracts.ts`: operations, envelope (`connection_revision`, `requested_window`, `daily.coverage`), metric keys and units, **the one top-videos metric list**, the video-ID pattern, error codes with status **and page scope**, periods, limits, the two ceilings, the required-scope constant. Runtime-neutral.
- `window.ts`: the Pacific reporting end date, the accepted window set, the Pacific budget-day key.
- `decision.ts`: the adapter over `decide`; an RPC error is `settings_unavailable`; no policy logic. Do not copy `comment-manager/stage4/rollout.ts:61`.
- `limits.ts`: admission, per-user data and the shared budget on `check_rate_limit`, all failing closed, modelled on `comment-manager/stage4/rateLimit.ts`; the budget uses the Pacific-date key, a 48-hour window and the `count ≥ 1` rule, and exposes only "debit one unit now".

Tests: `contracts`, `window`, `decision`, `limits` (spec §9.1).

### Step 4 — Provider client and the bound refresh store

- `analyticsReadClient.ts`: three report requests, the ownership lookup and the title lookup; 15-second timeout; structured URL parameters; `ids` from the admitted binding; per-report row validation; error mapping; `404 videoNotFound` as "not found"; no database access; no import of `dropGrantedScope`. The ownership lookup returns *owned*, *not owned* (only from a valid `200` or `videoNotFound`) or a classified failure.
- A private classifier wrapping `classifyGoogleError` (`supabase/functions/_shared/youtubeApiErrors.ts`) without changing it.
- `credentials.ts`: `createSupabaseYouTubeRefreshStore(admin)` with `readAccount`, `acquireLease`, `storeTokenWithLease` and `recordFailureWithLease` replaced as in spec §5.3, and the per-request `lastDenial`. **`_shared/youtubeTokenRefresh.ts` is not edited.**

Tests: `analyticsReadClient`, `credentials`.

### Step 5 — Handler, audit, wiring, CI step

- `handler.ts` with injected ports, in the order of spec §5.4: caller → admission limiter → validation → admission decision → data limiter → credentials → token → **per attempt: debit, decision, send** → validation → final decision → response. The `401` rule exactly as written there (title lookup exempt; one forced refresh per request).
- Every response sets `Cache-Control: no-store`. The success audit row is written after the response and not awaited; nothing awaited sits between the final decision and the response.
- `audit.ts`: one row per user per minute for admission refusals (one extra bucket call, no other database call), 20 per user per minute for other refusals through a shared bucket, suppression count best effort, nothing for anonymous callers.
- `index.ts` builds the ports; tokens only through the helper with `healthNeutral: true` and the bound store; `restrictedCorsHeaders`.
- `supabase/config.toml`: register the function with the same JWT setting as `youtube-resources`, if that file lists functions on the implementation head (it did not match at the baseline; check).
- `.github/workflows/ci.yml`: a named step "Typecheck and test youtube-analytics" next to the `youtube-resources` step (`:464-469`), under D9 (§4).

Tests: `handler` (every row of the requests table of spec §5.4 with the token state pinned), binding races, revocation in flight, audit bound with two instances, health neutrality, composition.

Exit of steps 2–5: the function is complete and dark; nothing in the browser calls it. Per ARCHITECTURE §1 it must not merge alone — steps 2–6 and 8 are one PR.

### Step 6 — The page, public text and documents

- `src/features/youtube-analytics/` as in spec §5.7. Query keys `["youtube-analytics", user, account, connection_revision, operation, window_end, period_days, video | null]`. Data queries: `staleTime: Infinity`, no refetch on mount, focus or reconnect, `retry: false`, never unmounted while the page is open; **fetching never depends on the lease**. Confirm the option names against the installed `@tanstack/react-query` 5.x (`package.json:52`) and record them in the PR.
- `useAccessLease.ts`: single-flight `status` per user and account with a 20-second deadline; lease clock from the issue time; epoch increased on denial, hide, offline and identity change; answers from an older epoch discarded; resume requires a status issued after it; coalesced events; 5/15/45-second backoff; `retry_after_seconds` honoured; latch to the revision for provider-confirmed refusals.
- `domain/trendSeries.ts`: one point per requested day, `null` for a day not returned; `connectNulls={false}`.
- `src/pages/analytics/YouTubeAnalytics.tsx`; route `/analytics/youtube` in `src/components/AnimatedRoutes.tsx`; sidebar child in `src/components/layout/DashboardLayout.tsx`; flag `feature_analytics_youtube` → `analyticsYoutube` in `src/hooks/useFeatureFlags.tsx` (default `false`, label, admin list); "View analytics" link in `src/features/youtube-management/ui/YouTubeVideoDetail.tsx` with the flag on.
- Arabic: a `youtube` group in `src/i18n/locales/ar/analytics.json`; the sidebar label in `src/i18n/locales/ar/nav.json`.

Tests: Vitest and Testing Library per spec §9.3, the layering test, the route and flag test, the shared request fixture.

Public text and documents, same PR:

- `src/pages/GoogleApiDisclosure.tsx`, as **two separate commits**: (1) the scope-list correction (include `youtube.force-ssl`, drop "exactly two") — true whatever happens to Stage 5; (2) the analytics wording — read-only, the owner's own channel, shown to that owner only, not stored, only where enabled. `src/pages/Privacy.tsx` §§2.1 and 3.1 gain the same purpose in the same two-commit shape. **Both wordings go to Waleed on the merge card.** What D10 requires beyond this is a gate, not text.
- `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`: scope table, privacy block, consent-screen status as read in step 0.
- New runbook `docs/runbooks/youtube-analytics-rollout.md`: applying and verifying the migration; the switches and which is the access switch; the policy JSON; gates G-P1, G-consent (and G-B); adding and removing a channel; switching everything off; the incident steps of §6; P1 and R1 as numbered procedures; the deployment checkpoint.
- `CLAUDE.md`: a row for `youtube-analytics` in the Edge Functions table. `docs/developer/analytics.md`: one line stating that YouTube analytics is on demand and not served by `get_account_analytics`.
- `docs-guard` on every document touched, including this plan and the specification.

### Step 7 — Only if P1-c concludes branch B, and only after D7

Not built unless the probe requires it. Written for the recommended D7-A (spec §7.4).

- A **second small migration**: the private consent function and a `CREATE OR REPLACE` of `youtube_analytics_stage5_decide` that adds the consent predicate **inside the same statement** (so credentials, every attempt and the final decision all apply it), with the rollout-`all`-needs-consent-`all` rule. SQL suite extended: consent withdrawn between admission, credential release, a pending debit and the final decision. Snapshot, apply before the merge, owner's card — as in §5.
- `supabase/functions/youtube-oauth/handler.ts`: the authorise action adds `yt-analytics.readonly` **only when the consent function admits the signed-in user**; absent, negative or unreadable → today's three scopes and the connection proceeds. Nothing else in that function changes.
- The required-scope constant gains the scope.
- Tests: with the key absent, `off`, malformed or unreadable, the authorise URL is **byte-identical** to today's; `users` and `all` as specified; a grant that omits the scope is recorded as given and yields `missing_scope`; a recorded scope that Google still refuses yields `detail: "grant_not_effective"`; publishing and comment capabilities unchanged.
- **G-B, per connection:** before each pilot account is added to the rollout policy, a token minted from that account's stored refresh token is checked with the token information endpoint, under approval. The disclosure keeps describing the fourth scope while any grant can exist; closing the gate does not remove grants.
- If the Console marks the scope sensitive: Waleed submits it for verification; until Google approves, consent stays `users` and the rollout stays `allowlist` for those owners.

### Step 8 — Journey, integrate, review, hand over

- `e2e/fixtures/youtubeStage5Server.ts`, `e2e/youtube-stage5.spec.ts`, `scripts/stage5-e2e.mjs` (spec §9.4): the real handler, the **real refresh helper with the bound store** and the real SQL on the disposable database with the migration applied, a counting fake provider (token endpoint, information endpoint, both YouTube hosts), English and Arabic; command, head SHA and result in the PR.
- Run every gate of §3 on the actual head; implementer guards; the manager's single `/code-review`; CI and bot rounds under the round cap; then §5.
- `graphify update .` after the code lands.

## 3. Acceptance evidence

All automated evidence is offline. Each case asserts the visible result and the counts of token-endpoint, Data API and Analytics requests and of budget debits, with the token state pinned.

| Layer | Required observations |
|---|---|
| **Isolated SQL** (`db-harness`, two real sessions) | The table of spec §9.2. In particular: the incarnation differs after delete-and-re-insert; the snapshot test fails against its mutant; `store_token` refuses after an uncommitted browser disconnect commits; `acquire_lease` refuses after a disconnect without a token change; the budget refuses a vanished row. Every pre-existing suite still green. |
| **Deno: contract, window, decision, limits** | Spec §9.1. The budget: Pacific-date keys on both sides of midnight and both daylight-saving changes; exhaustion at exactly `N`; a repeat and a title lookup each debit. |
| **Deno: provider client, bound store** | Structured parameters; per-report validation including string video IDs; ownership outcomes incl. `videoNotFound`; the bound store never lets the helper exchange a token for a changed binding and never calls `recordFailureWithLease`. |
| **Deno: handler** | **The 23 rows of the requests table of spec §5.4**, counters exact. A failed ownership lookup is never `video_not_found`; a title `401` causes no token request; every response `no-store`; no token in any response or log. |
| **Deno: binding, revocation, audit, health** | The injection points (a)–(f) of spec §9.1; rollout withdrawn mid-exchange stores the token and refuses the next attempt; audit bound with two instances; no health or grant write. |
| **Vitest** | Spec §9.3: distinct keys per operation; zero data calls after a lapse longer than 30 minutes; no request after a refusal on network return or remount; epoch and issue-time lease; latch; revision purge with no request in flight; pinned window across midnight; chart breaks, no zero. |
| **Playwright, English and Arabic, real handler, helper and SQL** | The twenty journey steps of spec §9.4 with counts asserted. |
| **Documents** | `docs-guard` clean on every touched document. |

### Denied effects — each must be shown impossible, not merely untested

1. A request to Google for an account that is not owned, not active, not YouTube, not native or not admitted by the rollout policy (or, under branch B, the consent gate).
2. A channel ID or video owner taken from the browser; a video ID sent to Google without passing the format check.
3. **A lease taken, a credential read, a token exchange started or a token stored for a connection other than the admitted one** — after a reconnect, a disconnect (token change or not), a provider switch, or a delete and re-insert of the row with the same ID.
4. **A request to Google started after the account, the rollout or the scopes no longer admit it**, other than an attempt already authorized when the change happened.
5. Numbers of one channel shown to another user, or to the same user under another channel, a previous connection or a previous window.
6. A data response returned whose final decision refused; reports shown without a successful access check in the last 90 seconds, or after a hide or offline period before a fresh check; an old status answer renewing a lease.
7. **Storage.** Any analytics value, video title or provider body in a table or a log. Any token in a log, a response, or any table other than the account row. **Permitted:** the bound store saving a refreshed access token (and a rotated refresh token) to the account row under the lease. Any response without `Cache-Control: no-store`.
8. Any write to `needs_reauth`, `failure_count`, `last_refresh_error` or recorded grants caused by an analytics request.
9. A number computed by Postora from YouTube numbers; a day drawn as zero or two days joined across a missing day.
10. A failed or refused read shown as an empty report; a failed ownership lookup shown as a missing video; a missing video removing the channel's reports.
11. A Google request without its own budget debit; more requests per Pacific day than a ceiling; a debit accepted with a missing counter; any automatic request after a refusal.
12. The rollout or consent key readable or writable by a non-admin session; a new function executable by a browser role; a non-admin able to rename a row into a protected key.
13. Any change in the behaviour of another `app_settings` key, in the files or responses of `youtube-resources`, `_shared/youtubeTokenRefresh.ts`, the shared lease functions, publishing, comments, the Partner API, n8n or MCP, or in the narrow role's ownership.
14. Unbounded audit rows or unbounded audit work from one caller; an admission refusal with no log row at all.
15. A channel enabled while the scope question is open (G-P1) or before its owner has agreed (G-consent).

## 4. CI facts this plan must respect

| Fact at the baseline | Consequence |
|---|---|
| Each YouTube function has its own named Deno step (`.github/workflows/ci.yml:457-485`). | Add "Typecheck and test youtube-analytics"; confirm in the job log on the final head that every new test file ran. |
| SQL suites run only if listed in `SUITES` in `scripts/db-harness.sh` (`:107`), on the baseline plus every migration; a suite on disk but not listed fails the harness. | Register the new suite; record its run on the final head. |
| Playwright is not a CI job. | The journeys, and the helper-to-SQL composition they exercise, are local evidence recorded in the PR; the PR says so. |
| Vitest runs in two shards behind a required aggregate; lint and i18n are compared with the immutable base. | New copy keys must not regress the comparison; every new English string has its Arabic entry. |
| `.github/workflows/owner-analytics-local.yml` triggers on `supabase/functions/_shared/**`. | This delivery edits no file under `_shared`. |
| Live suites never run in CI. | No Stage 5 test calls Google. |

**The CI rule and the recorded exception (D9).** `CLAUDE.md` ("CI critical path and measurement") asks for CI changes in a dedicated reviewed PR. The owner recorded an exception on one point only: **where** the registration lands — the Deno step and the SQL suite go in the product PR, because a test for code that does not yet exist cannot be registered first and a later registration would not gate the merge that introduces the code. The rule's measurement still applies as written:

- **Before:** links to five comparable successful **first-attempt** runs of code PRs from before this change. **After:** aim for five such runs after it; if volume is low, report the available sample and its limits.
- Runs on `main`, reruns, different runners and differing cache conditions are kept **separate**, never pooled with the PR cohort. This PR's own runs are supporting evidence only.
- For each cohort: wall time to the required gate, aggregate runner minutes, failures, retries and any observed resource pressure; per-job times of "Deno service and publishing suites" and the database harness as detail.
- A responsible owner and a due date are entered in the project tracker when the PR opens; two weeks after the merge, one report goes to Waleed with sample sizes, medians, absolute and percentage changes and the cost and reliability trade-offs. Procedure: `docs/runbooks/ci-critical-path.md`.

## 5. Release sequence

There is no staging stack; the environment is production. Each checkpoint can fail at its own stage.

| # | Step | Owner | Evidence |
|---|---|---|---|
| 0 | Step 0 of §2: Console readings, consent text, production confirmations, D10 and D11 answered, P1 if approved. | Waleed, manager | Recorded in the PR |
| 1 | Implementation, guards, whole-PR review, CI and bots green on the exact head. | Implementer, manager | CI links |
| 2 | **The owner's card, after CI is green on that head:** the merge; the migration's SHA-256 and object list; the two disclosure wordings; D10 and D11 as answered. | **Waleed** | Approval |
| 3 | **Production database snapshot.** Keep the receipt. | Waleed, or the manager under that approval | Receipt |
| 4 | **Apply the migration as `supabase_admin`, then verify:** the policy names exactly the two keys; the five functions and the column and trigger exist; every function is `SECURITY DEFINER` with the pinned path and executable by `service_role` only; the narrow role owns exactly the three Stage 4 functions; neither key exists; a non-admin session still reads every `feature_*` key and the allow-listed keys; an admin still reads and writes settings; `decide` for an owned synthetic account answers `not_enabled`, for a random ID `not_found`. | Same | Verification output |
| 5 | **Merge, then the deployment checkpoint:** the frontend deployed; the `Edge Functions Sync (POSTORA)` schedule ran **for the merge commit and did not park it** (`docs/runbooks/deploy-edge-function.md`, "Automatic deploy" and its parked-commit notes); SHA-256 of the synced `youtube-analytics` files (and `youtube-oauth` under branch B) equals `git show <merge>:<path>`; **a smoke test on the deployed route:** `status` for a random account ID answers `not_found`, for an owned channel `not_enabled`, each with `Cache-Control: no-store`. | Manager | Schedule log, hashes, smoke output |
| 6 | Dark verification: other features and every other setting unchanged; the connect flow asks for the same three scopes; the disclosure shows the approved text; the page is not visible. | Manager | Checklist |
| **G-P1** | P1 has a recorded conclusion, and the required-scope constant in `git show <deployed head>:supabase/functions/youtube-analytics/contracts.ts` equals it. If the code was built with a provisional set and the conclusion differs, a reviewed PR changes it first. Under a branch B conclusion, step 7 and D7 come first. | Manager records; **Waleed confirms** | Recorded conclusion |
| **G-consent** | Every owner about to be enabled has agreed in writing to the new purpose, and the policy text they agreed to is the text live on `/privacy` (D10-A). Waleed's own channels need only his own approval. | **Waleed** | Waleed's record; the PR notes the count and the date of the text |
| **G-B** | *Branch B only:* for each account about to be enabled, a token minted from its stored refresh token carries the analytics scope. | Manager, under approval | Recorded classification |
| 7 | Enablement, one step per approval: **(a)** policy `allowlist` with one named channel — **the go-live for that channel**; **(b)** flag `feature_analytics_youtube` on; **(c)** rehearsal R1, read-only; **(d)** further pilot channels, each after G-consent (and G-B); **(e)** `mode: "all"` — **not covered by this delivery's approval** (D10): it needs a separate approval after both Google limits and the existing features' peak have been read, the ceilings reviewed, and an in-app acceptance mechanism specified. Under branch B, consent `all` precedes rollout `all`, each its own approval, and the SQL decision refuses the opposite order. | **Waleed** | Per step |
| 8 | Plan summary after the merge in the `CLAUDE.md` format («ما تم»، «الباقي»، «التوصية»), and a `mem0` record. | Manager | — |

## 6. Rollback

Containment and recovery are different things.

**Containment — stopping further disclosure.**

1. **Set the policy `mode` to `off`, or remove the key.** From the next attempt every channel is refused before any credential is read and before any Google request, in running instances too.
2. **What this cannot do:** an attempt already authorized when the key is changed is in flight and completes; a response whose final decision passed a few milliseconds earlier is delivered; a `status` decided just before is answered just after (its lease started at issue, so it extends nothing beyond 90 seconds). A refresh in flight still stores the token it was issued (spec §5.3).
3. Pages already open: reports leave the screen at the next status check (about 60 seconds), or are hidden when the lease lapses (90 seconds after its start) if the check cannot complete; a tab in the background shows nothing on return until a check succeeds. Turning the flag off does not shorten this and does not stop access.
4. A faster cut for a wrong-channel incident: revert the frontend build (a deploy, not a switch).

**Recovery — after numbers reached someone who should not have seen them.** Switching off does not undo that.

1. From the `info` audit rows in `system_logs` (source `youtube-analytics`), list which accounts received which operations in the window. The rows hold no numbers and are **best-effort** evidence: they are written after the response and a failed write is dropped, so treat them as partial.
2. Establish the cause before re-enabling anything; the policy stays off.
3. Waleed decides what the affected owners are told.

**Triggers:** numbers shown for the wrong channel or a previous connection; any change to account health or grants traced to analytics; Google quota pressure on publishing or comments; provider errors surfacing as empty reports; another setting becoming unreadable; any change in an existing response.

**Code rollback.** Revert the feature commits. The frontend redeploys on push and the schedule removes the function directory on its next run. There is no analytics data to clean up. An old frontend against the new backend never calls the function; a new frontend against an old backend gets a failed `status` call and shows the temporary-failure state.

**The migration is not rolled back.** With the code reverted nothing calls the functions; the policy keeps two unused keys private; the column and trigger are inert. Removing them is a second migration with its own snapshot and approval. If the **policy itself** is the fault (another setting became unreadable), the immediate action is to remove the rollout key and then `DROP POLICY app_settings_youtube_stage5_rollout_private`, under Waleed's approval; the keys then fall back to the allow-list, which already hides them from non-admin sessions (`supabase/migrations/20261029170000_media_upload_limits.sql:17-39`).

**The disclosure after a rollback** must describe what the running system does. The scope-list correction (step 6, commit 1) is never reverted. The analytics wording follows the feature code. If only the policy is switched off, it stays: it says analytics is read only where enabled. **Branch B:** setting the consent gate to `off` restores today's *request*; it does not remove a grant already made, and Google can include an earlier grant in later authorizations. The disclosure therefore keeps describing the fourth scope for as long as any such grant can exist.

## 7. Acceptance gates

The delivery is accepted when all of these hold on the merged head:

- [ ] Every row of §3 is green, with commands and results attached to the PR; every denied effect is covered by a named test.
- [ ] The migration was applied before the merge, after a snapshot whose receipt is kept; its SHA-256 matches the file on the merged head; the checks of §5 row 4 are recorded.
- [ ] The deployment checkpoint of §5 row 5 passed, including the smoke test on the deployed route.
- [ ] With the policy absent, production behaves exactly as before the merge, including every other setting's visibility (§5 row 6).
- [ ] G-P1 and G-consent (and G-B under branch B) were recorded before the first channel was enabled.
- [ ] The owner of an admitted native channel sees the overview cards, the daily trend and the ten most viewed videos for 7, 14, 30 and 90 days, in English and Arabic, at `/analytics/youtube` from the Analytics menu, all blocks covering the same pinned window.
- [ ] The owner sees the overview and trend for one video, from the list and from "View analytics" on the YouTube Channel page; another channel's video ID shows "not available on this channel" in the video panel with one Data request and no Analytics request per read, and leaves the channel reports on screen.
- [ ] A channel that is not admitted, a Composio channel, a channel needing reconnect and a channel without the permission each get their own message and cause zero requests to Google.
- [ ] The page shows the requested period and, separately, the last day Google returned; a day not returned breaks the line and is never zero; the note says only that Google did not return it.
- [ ] No request follows a quota, capacity, rate-limit, permission or not-enabled refusal unless the owner asks, including after the network returns and after a remount; renewing the lease causes no Google request.
- [ ] Switching the policy off removes reports from an open page at the next check; a failing check hides them within 90 seconds; a reconnect, or a delete and re-insert of the row, removes the old connection's reports.
- [ ] A browser disconnect during a token exchange stores nothing; a rollout withdrawal during one stores the token and refuses the next attempt.
- [ ] No analytics request changes `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`; a request with an expired token stores the refreshed token and nothing else.
- [ ] Each ceiling refuses with `capacity_reached` when spent, per Pacific day, including for a repeat after `401`, and refuses when its counter cannot be read or returns `count: 0`.
- [ ] The rollout key is unreadable and unwritable by non-admin sessions, by policy; every response from the deployed route is `Cache-Control: no-store`.
- [ ] The public disclosure and privacy text list the scopes actually requested and describe the analytics read, in the approved wording.
- [ ] The new tests ran in CI on the final head; the "before" cohort links, the tracker entry with owner and due date, and the two-week report plan are attached.
- [ ] R1 was run on the pilot channel and records only what it observed; the owner compared one period with YouTube Studio.
- [ ] The runbook exists and its migration, deployment and enablement commands were executed once.

Under branch B, in addition: with the consent gate off, the connect flow asks for exactly today's three scopes; rollout `all` with consent not `all` admits nobody; each enabled account passed G-B.

## 8. If an open decision is answered otherwise

| Decision | Change to this plan |
|---|---|
| D10-B (in-app acceptance record in this delivery) | New storage (a table or a column) and a screen; a larger migration and a larger UI; G-consent becomes a product gate instead of the owner's record. Not planned. |
| D10-C (the updated text is enough) | G-consent is dropped; the owner accepts Google's policy risk (spec §7.3, §3.6). Not recommended. |
| D11-B (no incarnation column) | The migration loses the column and its trigger; identity is `(account, channel, generation)` and `connection_revision` is built from account and generation; denied effect 3 loses its delete-and-re-insert case; residual R-3 stands. The Stage 4 inventory of step 1 is not needed. |
| D7-B (no analytics scope until Google approves) | Step 7 is not in this PR; branch B ships later; until then analytics cannot work and stays dark. |
| D7-C (scope for everyone at deploy) | The consent gate and its migration go; not recommended. |
| D12-B (production client in the Playground) | Needs the Playground redirect URI registered on Postora's client; the account's later reconnects can pick up the grant through incremental authorization; the evidence is stronger and the side effect real. |

## 9. Design verification performed

- Code read through `git show` at `f7d49921` (code-identical to `5d020ed`); nothing was checked out and no repository file was written. The list is in spec §12.
- Google and PostgreSQL pages: spec §12 lists what was fetched, what the debate verified, and what stays unverified (**[S]**), notably the III.E.3 consent passage.
- Reviews: round 1 (33 comments, PR #472), round 2 (21 comments, issue #473), round 3 (the debate and 32 comments, PR #474), triaged in spec §§13–14.
- Not done, by instruction: code, migration, branch, commit, PR, production access, any call to a Google API. `mem0` was not consulted from the design session.

## 10. Contract summary for the implementer

One migration adds a RESTRICTIVE policy that keeps two rollout keys private; a nullable `binding_incarnation` on `social_accounts` with a trigger; and five service-only functions: `decide` (one statement, one snapshot, a typed reason in a fixed order, credentials only when asked), two bound wrappers around the existing lease and neutral-store functions, a parser, and the trigger function. No table; no existing function or trigger changed; no fourth trusted refresh writer.

One new read-only function, `youtube-analytics`, with four operations, serves `/analytics/youtube`. For each request it admits once, then for every Google attempt: debit one unit of that API's Pacific-day budget, decide again against the admitted connection, send. A final decision is the last awaited step before a data response, and a response that fails it is discarded. The refresh helper runs health-neutral with a store that acquires the lease, reads credentials and stores the token only for the admitted connection under the account row lock; the shared helper and functions are untouched. A request forces at most one refresh, and a `401` is `reconnect_required` otherwise; the title lookup is optional enrichment and exempt.

The page keys every report by connection revision, operation and a server-pinned window, shows reports only under a status check issued within 90 seconds, latches provider-confirmed refusals, and never fetches because a lease renewed. Every response is `no-store`.

Rollout: the policy is the access switch, the flag shows the page. The required scope set is one constant set by probe P1 and enforced by gate G-P1; consent to the new purpose is gate G-consent. If the analytics scope is needed, it is requested only behind a server-side consent gate. The order of release is snapshot, migration, merge, and the merge needs the owner's card.
