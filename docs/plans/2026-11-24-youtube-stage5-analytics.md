# YouTube Stage 5 — implementation and acceptance plan

24 November 2026 · proposed tier **Heavy** · one delivery, one release candidate, one rollback plan · revised after review round 1 on pull request #472 (findings and dispositions in specification §13). Contracts, provider citations and the design are in the [Stage 5 specification](../specs/2026-11-24-youtube-stage5-analytics.md); this plan does not restate them.

The plan is written against the recommended option of every owner decision (spec §11): D1-A (probe first), D2-A (on demand, nothing stored), D3-A (overview, daily trend, top videos, one video), D4-A (7, 14, 30, 90 days), D5-A (`/analytics/youtube`), D6-A (no migration), D7-A (gated consent, only if branch B), D8-A (shared daily budgets), D9-A (CI registration in the product PR, by recorded exception). §8 lists what changes under each other option, and §5 and §7 are written so that they can be followed under any of them.

## 1. Tier, baseline and what this plan does not authorise

- **Tier: Heavy.** Reason under `CLAUDE.md` "Delivery tiers": the delivery adds a new authenticated endpoint that checks ownership with the service role and uses stored OAuth tokens to read a user's private channel data. That is permissions/auth and security work.
- **Merge gate: Waleed's card, in every case.** `CLAUDE.md` says: "A PR that contains a migration, money or permissions/auth merges only after Waleed's card approval, once all other gates pass." A new token-using endpoint is permissions/auth whether or not an OAuth scope or a migration is added, so the first version's manager-only merge was wrong and is removed. The card is asked after CI is green on the exact head. Approval of the public disclosure wording (step 6) is a separate question on the same card.
- **Tier duties.** Claude Fable 5.2 (medium) writes the plan — this document. Codex Astra 6.2 (medium) debates it for one round before implementation starts; the manager opens that session with `delegate_task`. The implementer runs `clean-code-guard`, `test-guard` and `waleed-security-reviewer`. The manager runs `/code-review` once on the whole PR with a different model from the implementer's. CI is green on the exact head. At most three review rounds; after the third, P2/P3 findings become issues and P0/P1 block.
- **Baseline.** `main` at `44b426cc`, the Stage 4 merge, whose tree is identical to `7b8fe42b`. Stage 5 uses two things Stage 4's migration created (`supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql`): the health-neutral token store and `social_accounts.binding_generation`. The manager reports the migration is applied in production; step 0 confirms it read-only before implementation starts.
- **Not authorised by this document:** any code, any migration, any call to a Google API, any production access, a branch, a push, a PR, a deployment, a flag or policy change, any part of probe P1, or rehearsal R1. Each of the last five keeps its own approval (§5).

## 2. Work in dependency order

Every delegation brief names `ARCHITECTURE.md` as required reading, with §§3–4 (feature layering), §§12–17 (edge function shape, authentication, validation, errors, logging), §§22, 24–26 (one contract, service role, CORS, external HTTP), §§33–34 (testing), §§37–38 (tokens, quota), plus `CLAUDE.md` "Task Execution Workflow" and the tier and exceptions chosen on the tier card.

### Step 0 — Owner preconditions (no code)

| Item | Owner | Result |
|---|---|---|
| Decisions D1–D6, D8, D9 (spec §11), as cards. D7 only if P1 leads to branch B. | Waleed | The plan stands, or §8 applies. |
| Enable the YouTube Analytics API in the Google Cloud project. | Waleed | Needed by P1 and by the feature. |
| Read in the Cloud Console: the daily limit of the Analytics API **and** of the Data API; the consent-screen status (Testing or In production); the sensitivity mark of `yt-analytics.readonly`. | Waleed | Facts the public pages do not give (spec §3.1, §3.4). The two limits set the shared budgets (D8). |
| Read-only confirmation in production: the Stage 4 migration is applied (`binding_generation` exists; `store_youtube_refreshed_token_with_lease_neutral` exists), and `check_rate_limit` exists and returns `allowed`, `remaining`, `retry_after`. | Manager, under Waleed's approval | Three objects the design depends on. |
| **Probe P1** (spec §7.2), procedure below. | Waleed approves each part; the manager runs it under that approval | The required scope set, and branch A or B. |

**P1 procedure.** Every part is one read. It writes nothing to YouTube. The only database write it can cause is the normal storing of a refreshed access token.

*P1-a — a production token.*

1. Waleed names one connected native channel and approves P1-a for it.
2. On the production host, a forced token refresh is run for that account through the existing helper. **The effective scopes of that exact token are taken from the `scope` field of Google's token response**, which the helper returns as `grantedScopes`. Recorded grants in the database are not used as evidence. If the field is absent, P1-a is inconclusive and stops.
3. If the effective scopes include `yt-analytics.readonly`, the token is unsuitable; choose another channel.
4. The request: `GET https://youtubeanalytics.googleapis.com/v2/reports` with `ids=channel==<that channel's ID>`, `startDate=<10 days ago>`, `endDate=<3 days ago>`, `metrics=views`.
5. The token is never printed and never copied into a chat, a file or a log.

*P1-b — optional, only after a `200` in P1-a.* Waleed obtains, for his own channel, a token from a consent that requests only `youtube.readonly` and does not include previously granted scopes. Its effective scopes are read first. If they are wider than `youtube.readonly`, P1-b is abandoned. Otherwise the same request is sent.

*P1-c — only after an insufficient-permission refusal in P1-a.* Waleed obtains, for his own channel, a token that carries the P1-a scopes plus `yt-analytics.readonly`, and the same request is sent.

*What is recorded, in the PR and in `mem0`, and nothing else:* the part, the date, the HTTP status, the token's effective scope list, and one classification from the fixed list in spec §7.2 (`ok`, `insufficient_permission`, `api_not_enabled`, `quota`, `unauthorized`, `unsupported_query`, `server_error`, `timeout`, `unrecognised`). On success, also the column header names and the number of rows. **No Google message text, no response body, no channel name, no numbers.** Nothing from a production response becomes a fixture.

*Reading the result.*

| P1-a | Then | Conclusion |
|---|---|---|
| `ok` | optionally P1-b | Branch A. The required set is the P1-a scope list, or `youtube.readonly` alone if P1-b is `ok`. |
| `insufficient_permission` | P1-c | Branch B if P1-c is `ok`. If P1-c is refused, neither branch is established: stop and report. |
| `api_not_enabled` | enable the API, repeat P1-a once | — |
| anything else | stop | Inconclusive. Report to Waleed; do not retry. |

Exit: the required scope set and the branch are known. If P1 cannot be run before implementation, build branch A with the required set equal to all three existing scopes (the most conservative reading) and keep step 7 ready; the set is one constant.

### Step 1 — Freeze facts and fixtures

- On `main`, repeat the citations of spec §2.1 and §2.2 and correct any that moved.
- Re-read, word for word, the YouTube developer policy on stored and derived data (III.E.2, III.E.4) and record the sentences in the PR. If the policy forbids anything in spec §4.1, stop and report to the manager before writing code.
- Confirm from the `videos.list` reference how many IDs one call accepts. If fewer than ten, the title lookup is batched or reduced accordingly.
- Write offline fixtures **by hand, from the documented response shapes**: a totals answer; a daily answer; a daily answer missing its last two days; a daily answer missing a middle day; a non-empty top-videos answer with string IDs; an answer with no `rows`; a header mismatch; an explicit `null` cell; a wrong row width; an ID that fails the pattern; `The query is not supported`; one synthetic error body per classification in spec §7.2. No text from a real response is used.
- Run as green before anything changes: the `youtube-resources` capability contract and its handler suite; the `youtube-oauth` scope list; the health-neutral refresh mode in `_shared/youtubeTokenRefresh.test.ts`.

Exit: fixtures committed, the compatibility tests green on the base, the re-read policy passage attached to the PR.

Files: `supabase/functions/youtube-analytics/fixtures/*.ts` (new).

### Step 2 — Contract, window, rollout parser, capability, limits (pure or thin code)

- `supabase/functions/youtube-analytics/contracts.ts`: operations, envelopes (`requested_window`, `daily.coverage`), metric keys and units, **the one top-videos metric list**, the video-ID pattern, error codes with status, periods, limits, budgets, the required-scope set. Runtime-neutral.
- `supabase/functions/youtube-analytics/window.ts`: the requested Pacific-time window, three days back.
- `supabase/functions/youtube-analytics/rollout.ts`: the policy parser (`off`, `allowlist`, `all`; at most 200 IDs; fail closed) and its port.
- `supabase/functions/youtube-analytics/capability.ts`: the pure availability rule, reading recorded scopes with `grantedScopes` from `_shared/youtubeCommentCapability.ts`. **`youtube-resources` is not edited.**
- `supabase/functions/youtube-analytics/limits.ts`: the admission limiter, the per-user data limiter and the shared daily budget per Google API, all on `check_rate_limit`, all failing closed, modelled on `supabase/functions/comment-manager/stage4/rateLimit.ts`.

Tests: `contracts.test.ts`, `window.test.ts`, `rollout.test.ts`, `capability.test.ts`, `limits.test.ts`.

### Step 3 — Provider client

- `supabase/functions/youtube-analytics/analyticsReadClient.ts`: three report requests, the ownership lookup and the title lookup. 15-second timeout; every request built from structured URL parameters; `ids` from the admitted channel; the per-report row validation of spec §5.2; the error mapping of spec §5.2; no database access; no import of `dropGrantedScope`.
- The ownership lookup returns one of three things, never fewer: *owned*, *not owned* (only from a valid `200`), or a classified failure.
- A private classifier that wraps `classifyGoogleError` (`_shared/youtubeApiErrors.ts`) without changing it.

Tests: `analyticsReadClient.test.ts` with a fake `fetch` (spec §9.1).

### Step 4 — Handler, audit, wiring, CI step

- `supabase/functions/youtube-analytics/handler.ts` with injected ports (auth, accounts, rollout, limits, tokens, provider, audit, clock, IDs) and the fixed check order of spec §5.2: token **before** the ownership lookup; binding recheck after the token, after any forced refresh and before the result is returned; gate recheck before the result is returned; at most one forced refresh per request.
- `supabase/functions/youtube-analytics/audit.ts`: refusal rows bounded at 20 per user per minute with a suppression counter row; one `info` row per successful data operation; nothing for anonymous callers (spec §6, rule 7).
- `supabase/functions/youtube-analytics/index.ts`: builds the ports. Tokens only through `refreshYouTubeAccountToken` with `healthNeutral: true`. `restrictedCorsHeaders`.
- `supabase/config.toml`: register the function with the same JWT setting as `youtube-resources`, if that file lists functions on the implementation head (it did not match a search at the baseline; check before editing).
- `.github/workflows/ci.yml`: a named step "Typecheck and test youtube-analytics" next to the `youtube-resources` step — under decision D9-A (§4).

Tests: `handler.test.ts` with fake ports (every row of the provider-call table, both counters), the binding-race suite, revocation in flight, the audit bound, the health-neutrality suite, and a composition test for `index.ts` (spec §9.1).

Exit of steps 2–4: the function is complete and dark; nothing in the browser calls it yet. Per ARCHITECTURE §1 it must not merge alone — steps 2–6 are one PR.

### Step 5 — The page

- `src/features/youtube-analytics/` with `domain`, `application`, `infrastructure`, `ui`, `tests`, `index.ts` (spec §5.6). The trend chart uses `recharts`, as `src/features/analytics-contract/ui/SavedAnalyticsReport.tsx` does.
- Every Stage 5 query sets `retry: false`. `useAnalyticsRevocation.ts` re-asks `status` every 60 seconds while the page is visible and, on a withdrawn-access answer, removes that account's cached reports and cancels its in-flight requests.
- The period line shows the requested dates; the "published through" line comes only from the daily answer; missing days are gaps (spec §5.7).
- `src/pages/analytics/YouTubeAnalytics.tsx`; route `/analytics/youtube` in `src/components/AnimatedRoutes.tsx`; sidebar child in `src/components/layout/DashboardLayout.tsx`; flag `feature_analytics_youtube` → `analyticsYoutube` in `src/hooks/useFeatureFlags.tsx` (default `false`, label, admin list).
- "View analytics" link in `src/features/youtube-management/ui/YouTubeVideoDetail.tsx`, shown only with the flag on. Frontend only.
- Arabic: a `youtube` group in `src/i18n/locales/ar/analytics.json`; the sidebar label in `src/i18n/locales/ar/nav.json`. English inline.

Tests: Vitest and Testing Library per spec §9.3, the layering test, the route and flag wiring test, and the shared request fixture used by both the Deno handler test and the Vitest gateway test.

### Step 6 — Public text and documents

- `src/pages/GoogleApiDisclosure.tsx`, as **two separate commits**:
  1. *Scope-list correction.* List the scopes Postora really requests today, including `youtube.force-ssl`, and remove "exactly two". This is true whatever happens to Stage 5 and is never reverted with it.
  2. *Analytics wording.* Replace the sentences that say Postora never reads YouTube Analytics with an accurate description: read-only, the owner's own channel, shown to that owner only, not stored, and only for accounts where analytics is enabled.
  **Both wordings are sent to Waleed for approval before the merge.**
- `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`: the scope table, the privacy-policy block and the consent-screen status as read in step 0. The `/privacy` page gets the same sentence if it describes Google data.
- New runbook `docs/runbooks/youtube-analytics-rollout.md`: the switches and which one is the access switch; the policy JSON with examples; how to add and remove a channel; how to switch everything off; the incident steps of §6; P1 and R1 as numbered procedures; what to check after the merge.
- `CLAUDE.md`: one row for `youtube-analytics` in the Edge Functions table. `docs/developer/analytics.md`: one line stating that YouTube analytics is on demand through `youtube-analytics` and is not served by `get_account_analytics`.
- `docs-guard` on every document touched, including this plan and the specification.

### Step 7 — Only under branch B (the analytics scope must be added)

Written for decision D7-A, the gated consent of spec §7.4.

- `supabase/functions/youtube-oauth/handler.ts`: the authorise action reads the private key `youtube_analytics_stage5_consent` and adds `https://www.googleapis.com/auth/yt-analytics.readonly` to the scope list **only when the gate admits the signed-in user**. Absent, unreadable or malformed → today's three scopes, and the connection proceeds. Nothing else in that function changes.
- The required-scope set in `youtube-analytics/contracts.ts` gains that scope. `youtube-resources` stays untouched.
- Tests: with the gate absent, `off`, malformed or unreadable, the authorise URL is **byte-identical** to today's; with `users`, only a listed user gets four scopes; with `all`, everyone does; a grant that omits the analytics scope (the owner unticked it) is recorded as given and yields `missing_scope`; a row with no recorded scopes still proceeds; publishing and comment capabilities are unchanged for every fixture. The SQL privacy suite covers the consent key too.
- The disclosure page and the verification guide describe the fourth scope as requested only where analytics is enabled, with its justification text.
- If the Cloud Console marks the scope sensitive: Waleed submits it for Google verification with the justification and the demo video. Until Google approves, the gate stays at `users` with the named pilot only, who are told to expect Google's unverified-app screen. `all` is a separate approval after Google's.

### Step 8 — Journey, integrate, review, hand over

- `e2e/fixtures/youtubeStage5Server.ts`, `e2e/youtube-stage5.spec.ts`, `scripts/stage5-e2e.mjs` (spec §9.4), run locally in English and Arabic; the command, head SHA and result go in the PR.
- `supabase/tests/youtube_analytics_rollout_privacy.sql`, registered in `SUITES` in `scripts/db-harness.sh` — under decision D9-A (§4).
- Run every gate of §3 on the actual head. Implementer guards; the manager's single whole-PR `/code-review`; CI and bot rounds under the round cap; then §5.
- `graphify update .` after the code lands.

## 3. Acceptance evidence

All automated evidence is offline. Each case asserts the visible result **and** the count of provider requests, separately for the Data API and the Analytics API.

| Layer | Required observations |
|---|---|
| **Deno: contract, window, rollout, limits** | Spec §9.1 rows 1–4. |
| **Deno: provider client** | Structured URL parameters; `ids` from the account, never from input; per-report row validation including string video IDs, explicit `null`, missing days and out-of-window dates; missing `rows` is empty; each error class; no provider text in a result; titles only for rows whose channel matches. |
| **Deno: handler** | **Provider-call counts exactly as in the table of spec §5.2.** In particular: zero calls of either kind for every refusal decided before provider access (caller, limits, validation, account, gate, capability, token, binding recheck); one Data call and zero Analytics calls for a video that is not owned and for a failed ownership lookup; two Analytics calls for a `401` followed by success or by a second `401`. Foreign equals missing for accounts and for videos. A failed ownership lookup is never `not_found`. At most one forced refresh per request. No token in any response or log line. |
| **Deno: binding and revocation** | The four injection points of spec §9.1; the policy switched off mid-request. In each case no number is returned. |
| **Deno: audit** | The refusal bound and its counter row; one `info` row per successful data operation; no anonymous rows. |
| **Deno: health neutrality** | No path writes `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`; the function does not import `dropGrantedScope`. |
| **Deno: compatibility** | The step 1 suites replayed unchanged: `youtube-resources` capability and handler, `youtube-oauth`, the refresh lease. No file of `youtube-resources` is edited. Under branch A the `youtube-oauth` files are untouched; under branch B the authorise URL is byte-identical with the consent gate off. |
| **SQL harness** | The rollout key (and the consent key under branch B) is invisible and unwritable to `anon` and non-admin `authenticated`; readable and writable by an admin; readable by `service_role`. |
| **Vitest** | Spec §9.3, in particular: account switch never shows the previous account's numbers; every state has its own message; no automatic retry on quota, capacity, rate-limit, permission or not-enabled answers; requested period and observed coverage are separate; gaps are not zeros; cached reports are removed on revocation; no net-subscriber or comparison figure anywhere; Arabic and right-to-left. |
| **Playwright, English and Arabic, real local handler** | The journey steps of spec §9.4 that apply under the chosen options (§7), with both provider counts asserted at each and a failure on any unexpected external request. |
| **Documents** | `docs-guard` clean on every touched document. |

### Denied effects — each must be shown impossible, not merely untested

1. A provider request for an account that is not owned, not active, not YouTube, not native, or not admitted by the rollout policy.
2. A channel ID or video owner taken from the browser; a video ID sent to Google without passing the format check.
3. Numbers of one channel shown to another user, or to the same user under another selected channel.
4. A number returned after the connection changed or the rollout was switched off while the request was running.
5. **Storage.** Any analytics value, video title or provider body in a database table or a log. Any token in a log, a response, or any table other than the account row. **Permitted, and the only permitted write of a token:** the existing health-neutral store saving a refreshed access token (and a rotated refresh token, if Google sends one) to the account row under the refresh lease. A test with an expired token asserts that this write happens and that nothing else is written.
6. Any write to `needs_reauth`, `failure_count`, `last_refresh_error` or recorded grants caused by an analytics request.
7. A number computed by Postora from YouTube numbers (net subscribers, rates, comparisons, cross-channel sums); a day drawn as zero that Google did not return.
8. A failed or refused read shown as an empty report; a failed ownership lookup shown as a missing video.
9. Any change in the responses or files of `youtube-resources`, in `youtube-oauth` (branch A, or branch B with the consent gate off), publishing, comments, the Partner API, n8n or MCP.
10. A request to Google with the flag on but the policy absent.
11. More Google requests in a day than the shared budget allows; an automatic repeat of a request Google or Postora refused for quota, capacity or permission.
12. Unbounded audit rows from one caller.

## 4. CI facts this plan must respect

| Fact at the baseline | Consequence |
|---|---|
| Each YouTube function has its own named Deno step (`.github/workflows/ci.yml:457-485`). | Add "Typecheck and test youtube-analytics"; confirm in the job log on the final head that every new test file ran. |
| SQL suites run only if listed in `SUITES` in `scripts/db-harness.sh` (`:107`); a suite on disk but not listed fails the harness. | Register the new suite. |
| Playwright is not a CI job. | The journeys are local evidence recorded in the PR, as in Stage 4. Making Playwright a job is a separate CI PR under the CI critical-path rule. |
| Vitest runs in two shards behind a required aggregate; lint and i18n are compared with the immutable base. | New copy keys must not regress the comparison; every new English string has its Arabic entry. |
| `.github/workflows/owner-analytics-local.yml` triggers on `supabase/functions/_shared/**`. | This delivery adds and edits no file under `_shared` (it only imports from it); if a reviewer asks for a shared file, expect that workflow to run. |
| Live suites never run in CI. | No Stage 5 test calls Google. |

**The CI critical-path rule applies, and this plan does not exempt itself.** `CLAUDE.md` ("CI critical path and measurement") says to inspect the measured critical path before changing CI and to "Use a dedicated reviewed CI PR, separate from product work". Registering a Deno step and a SQL suite adds required work to two existing jobs. The first version of this plan declared the rule "not triggered"; nothing in the rule says so.

The recommended handling is decision **D9-A**, an exception recorded by Waleed: the registration stays in the product PR, because a test for code that does not yet exist cannot be registered first and a registration made afterwards would not gate the merge that introduces the code. In return the PR records, from GitHub's own timings, the wall time of the "Deno service and publishing suites" job and of the database harness job on the last five successful `main` runs before the change and on the PR's own runs, and the time to the required gate. If either job's median rises by more than a minute, that is reported to Waleed before the merge card. Stages 2, 3 and 4 each added their step in their product PR (`ci.yml:457-485`); that is precedent, not an exemption.

Under D9-B the product PR contains no workflow or harness change, its new tests are run locally with results recorded in the PR, and a dedicated CI PR registers them after the merge.

## 5. Release sequence

There is no staging stack; the environment is production. A merge to `main` deploys the frontend and, within about two minutes, the edge functions through the Dokploy schedule `Edge Functions Sync (POSTORA)`. The schedule does not wait for migrations (`docs/runbooks/deploy-edge-function.md`). Under D6-A there is no migration, so nothing has to be applied before the merge; row 3 exists for D6-B.

| # | Step | Owner | Gate |
|---|---|---|---|
| 0 | Step 0 of §2: decisions, API enabled, Console readings, production confirmations, P1. | Waleed | Before implementation |
| 1 | Implementation, guards, whole-PR review, CI and bots green on the exact head. | Implementer, manager | — |
| 2 | **Approval card after CI is green on that head**: the merge, and the two disclosure wordings. Under D6-B the card also shows the migration file hash and object list. | **Waleed** | **Required in every case** |
| 3 | *D6-B only:* production database snapshot, keep the receipt; apply the migration as `supabase_admin`; verify the policy and the function, and that the rollout key is absent. | Waleed, or the manager under that approval | **Before the merge** |
| 4 | Merge. Verify the synced `youtube-analytics` files (and `youtube-oauth` under branch B) by SHA-256 against `git show <merge>:<path>`. | Manager | Policy absent → no channel can reach Google through Stage 5 |
| 5 | Verify in production with everything off: `status` answers `not_enabled` for an owned channel and `not_found` for a random ID; the YouTube Channel page, publishing and comments are unchanged; the connect flow asks for the same three scopes; the disclosure page shows the approved text; the analytics page is not visible. | Manager | — |
| 6 | Enablement, one step per approval, in the order of the table below for the chosen page option. | **Waleed** | Never implied by the merge or by an earlier approval |
| 7 | Plan summary after the merge in the `CLAUDE.md` format («ما تم»، «الباقي»، «التوصية»), and a `mem0` record. | Manager | — |

**Enablement steps (row 6), per page option.** In both, **the rollout policy is the access switch**: from the moment it lists a channel, the endpoint serves that channel's owner. What differs is only how the page becomes visible.

| # | D5-A — page in the Analytics menu | D5-B — tab inside the YouTube Channel page |
|---|---|---|
| 6.1 | Rollout policy `allowlist` with one named channel. **Go-live for that channel.** | The same. |
| 6.2 | Flag `feature_analytics_youtube` on. The page appears in the Analytics menu for every user; users whose channel is not listed see "not switched on". | **No Stage 5 flag exists.** The tab is part of the YouTube Channel page and is visible wherever `feature_youtube_management` is on. If that flag is already on, the tab is visible from the merge and shows "not switched on" until 6.1; there is nothing to approve at this step. If it is off, turning it on is a separate decision about the whole YouTube Channel page, not about analytics. |
| 6.3 | Rehearsal R1 on the pilot channel (read-only). | The same. |
| 6.4 | Remaining pilot channels, by adding their IDs to the policy. | The same. |
| 6.5 | `mode: "all"`, only after both Google limits are read and the shared budgets are set against them (D8). | The same. |

*Branch B adds, before 6.1:* consent gate `users` with the named pilot users → those owners reconnect and grant the scope. And after 6.5, as its own approval: consent gate `all`, only after Google has approved the scope.

Under D5-B, release row 5's last check reads "the tab shows 'not switched on' for every channel" in place of "the analytics page is not visible".

## 6. Rollback

Containment and recovery are different things, and the first version of this plan merged them.

**Containment — stopping further disclosure.**

1. **Set the policy `mode` to `off`, or remove the key.** From the next request, every channel is refused before a provider call, in running instances too. A request already in flight has its result discarded by the server (spec §5.2, step 14).
2. Pages already open clear their reports within about 60 seconds, when their next `status` check comes back (spec §5.6). **Until then a report already on screen stays on screen.** Turning the flag off does not shorten this and does not stop access; it only hides the page on the next navigation.
3. If a faster cut is needed for a wrong-channel incident, revert the frontend build; a reload then no longer contains the page. This is a deploy, not a switch.

**Recovery — after an incident in which numbers reached someone who should not have seen them.** Switching the policy off does not undo that.

1. From the `info` audit rows in `system_logs` (source `youtube-analytics`), list which accounts received which operations in the window. The rows hold no numbers.
2. Establish the cause before re-enabling anything. The policy stays off.
3. Waleed decides what the affected owners are told.

**Triggers:** numbers shown for the wrong channel; any change to account health or grants traced to analytics; Google quota pressure on publishing or comments; provider errors surfacing as empty reports; any change in an existing response.

**Code rollback.** Revert the feature commits. The frontend redeploys on push and the schedule removes the function directory on its next run. There is no schema and no stored data to clean up. An old frontend against the new backend never calls the function; a new frontend against an old backend gets a failed `status` call and shows the temporary-failure state.

**The disclosure text after a rollback** must describe what the running system does:

- The scope-list correction (step 6, commit 1) **is not reverted**. It was already true before Stage 5.
- The analytics wording (commit 2) **is reverted together with the feature code**, whether or not a pilot ever ran, because after the revert Postora no longer reads analytics.
- If only the policy is switched off and the code stays, the analytics wording stays: it says analytics is read only where enabled, which remains accurate.
- Branch B: while the consent gate admits anyone, the page lists four scopes. When the gate is set to `off`, or the scope code is reverted, the page goes back to three, in the same change.

**Branch B.** Setting the consent gate to `off` restores today's consent request at the next click. Channels that already granted the scope keep the grant until they disconnect or revoke it; nothing reads it once the feature is off.

**D6-B.** The policy and function stay; removing them is a second migration with its own approval.

## 7. Acceptance gates

The delivery is accepted when every item that applies under the owner's decisions holds on the merged head. The second column says when an item applies.

| Gate | Applies under |
|---|---|
| Every applicable row of §3 is green, with the commands and results attached to the PR. | Always |
| Every denied effect in §3 is covered by a named test. | Always |
| With the policy absent, production behaves exactly as before the merge (§5 row 5). | Always |
| The owner of an admitted native channel sees the **overview cards and the daily trend** for each offered period, in English and in Arabic. | Always (D3-A, D3-B, D3-C) |
| The offered periods are 7, 14, 30 and 90 days. | D4-A. Under D4-B: 7, 28, 90 and 365 days. |
| The owner sees the **ten most viewed videos** with the four metrics of spec §5.4, and "Video unavailable" for a row whose title cannot be confirmed. | D3-A and D3-C only. **Not under D3-B.** |
| The owner sees the overview and trend **for one video**; another channel's video ID answers "not found" with one Data call and no Analytics call; a failed ownership lookup shows a temporary failure, not "not found". | D3-A and D3-C only. **Not under D3-B**, where no request carries a video ID and the ownership lookup does not exist. |
| The "View analytics" link on the YouTube Channel page opens the one-video view. | D3-A or D3-C, with D5-A. Under D5-B the tab is on that page already. |
| Traffic sources, countries and devices each render, including Google's "limited" answer as its own state. | D3-C only. |
| A channel that is not admitted, a Composio channel, a channel needing reconnect and a channel without the permission each get their own message and cause **zero** provider requests of either kind. | Always |
| The page shows the requested period and, separately, the last day Google returned; a missing day is a gap; the incomplete-period note appears when the last returned day is before the requested end. | Always |
| No automatic repeat follows a quota, capacity, rate-limit or permission refusal. | Always |
| Switching the policy off clears an open page within the status interval and discards an in-flight result. | Always |
| The page is reached at `/analytics/youtube` from the Analytics menu when `feature_analytics_youtube` is on, and is absent when it is off. | D5-A. Under D5-B: the tab appears on the YouTube Channel page wherever `feature_youtube_management` is on, and there is no route, flag or sidebar entry of its own. |
| No analytics request changes `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`; a request with an expired token stores the refreshed token and nothing else. | Always |
| The shared daily budget refuses with `capacity_reached` when spent, and refuses when its counter cannot be read. | D8-A. Under D8-B this gate is removed and `mode: "all"` needs a separate risk acceptance by Waleed. |
| The rollout key is unreadable by ordinary browsers. | Always: by the allow-list test under D6-A, by the policy and evaluator tests under D6-B. |
| With the consent gate off, the connect flow asks for exactly today's three scopes. | Branch B with D7-A. Under branch A: the `youtube-oauth` files are unchanged. |
| The public disclosure lists the scopes actually requested and describes the analytics read. | Always |
| The new tests ran in CI on the final head, and the before-and-after job timings are attached. | D9-A. Under D9-B: the tests ran locally with results attached, and the CI PR is open. |
| R1 has been run on the pilot channel; what it actually observed (spec §9.5) is recorded; the owner has compared one period with YouTube Studio. | Always |
| The runbook exists and its enablement commands were executed once. | Always |

**Journey steps (spec §9.4) per option.** Steps 1–3 and 5–13 apply always. Step 4 (one video, and a foreign video ID) and the top-videos part of steps 2 and 3 apply only under D3-A and D3-C; under D3-B the expected counts in steps 2 and 3 are 2 Analytics and 0 Data. Under D5-B the journey opens the tab on the YouTube Channel page instead of the route.

## 8. What changes under the other options

| Decision | Change to this plan |
|---|---|
| D1-B (add the scope without the probe) | P1 is dropped from step 0. Step 7 is built from the start and D7 applies at once. Every connected channel must reconnect before its first report. The required set is unproven until the first real request. |
| D2-B (store the data) | This plan does not apply. A new specification is needed: `yt_*` tables with RLS and no browser grants, a collector with a cron job, a retention job, a SQL metric validator, a decision on the 30-day policy, and a snapshot before the merge. |
| D3-B (overview and trend only) | `top_videos`, the title lookup, the `video_id` input, the ownership lookup and the "View analytics" link are removed from steps 2–5. The Data API is not used at all, so only the Analytics budget remains. §7 marks which gates and journey steps fall away. |
| D3-C (also traffic, countries, devices) | Three more operations, three more blocks and states; hand-written fixtures and tests for thresholded and empty answers; each page load costs three more Analytics requests, which the budget must absorb. §7 adds its gate. |
| D4-B (7, 28, 90, 365) | One constant and its tests; §7's period gate changes. |
| D5-B (a tab in the YouTube Channel page) | No route, no flag, no sidebar entry. The screen mounts in `src/pages/youtube/YouTubeManagementPage.tsx` behind the existing `feature_youtube_management`. Enablement follows the D5-B column of §5; §7 marks the changed gates. |
| D6-B (migration for the gate) | One forward-only migration: a RESTRICTIVE policy on `app_settings` for the key (and the consent key under branch B) and a `SECURITY DEFINER`, service-only evaluator with a pinned `search_path`. The SQL suite also covers them. Release row 3 applies. |
| D7-B (no analytics scope until Google approves) | Step 7 is not in this PR. Branch B ships as a second PR after Google's approval; until then analytics cannot work for anyone and the feature stays dark. |
| D7-C (scope for everyone at deploy) | The consent gate is removed and the scope is added unconditionally. Not recommended: it changes the connect flow for every user, cannot be switched off without a deploy, and may show Google's unverified-app screen. |
| D8-B (no shared budget) | The shared budget and `capacity_reached` are removed from steps 2–5; §7 replaces its gate with a risk acceptance. |
| D9-B (CI registration in a separate PR) | Steps 4 and 8 make no workflow or harness change; a dedicated CI PR follows the merge. |

## 9. Design verification performed

- Code read through `git show` at `44b426cc` (tree identical to `7b8fe42b`); nothing was checked out, and no file in the repository was written. The list is in spec §12.
- Google pages fetched on 2026-11-23; none was re-fetched for the review round. Passages that could only be summarised are marked in the specification and re-read in step 1.
- Review round 1: 33 comments on pull request #472, triaged in spec §13.
- Not done, by instruction: code, migration, branch, commit, PR, production access, any call to a Google API. `mem0` was not consulted from the design session.

## 10. Contract summary for the implementer

One new read-only function, `youtube-analytics`, with four operations (`status`, `summary`, `daily`, `top_videos`), serves a new page at `/analytics/youtube`. It reads the YouTube Analytics API on demand for one owned, native, admitted channel and stores nothing new; the only write it can cause is the existing health-neutral store of a refreshed token. The channel ID always comes from the account row. The token is obtained before any Google call, and the account's `binding_generation` and channel are rechecked after the token, after a forced refresh and before a result is returned; a result from a changed connection or a withdrawn rollout is discarded. A video is used only after a successful ownership lookup, and a failed lookup is never "not found". Rows are validated per report; the top-videos report has one fixed metric list. The requested period and the days Google actually returned are reported separately. Three fail-closed limiters apply: admission per user, data per user, and a shared daily budget per Google API, which is what protects the project's quota. No analytics path ever changes account health or recorded grants, and nothing is retried automatically after a quota, capacity or permission refusal. The rollout policy is the access switch; the flag only shows the page. The required permission set is one constant, set by probe P1 from the effective scopes of the token it sent; if the analytics scope is needed, it is requested only behind a server-side consent gate. Everything public, automated and existing is unchanged, except the public disclosure text, which is corrected. The merge needs the owner's card.
