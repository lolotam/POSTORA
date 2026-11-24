# YouTube Stage 5 — implementation and acceptance plan

24 November 2026 · proposed tier **Heavy** · one delivery, one release candidate, one rollback plan. Contracts, provider citations and the design are in the [Stage 5 specification](../specs/2026-11-24-youtube-stage5-analytics.md); this plan does not restate them.

The plan is written against the recommended option of every owner decision (spec §11): D1-A (check first, reuse the existing permission if Google accepts it), D2-A (on demand, nothing stored), D3-A (overview, daily trend, top videos, one video), D4-A (7, 14, 30, 90 days), D5-A (`/analytics/youtube`), D6-A (no migration). §8 lists what changes under each other option.

## 1. Tier, baseline and what this plan does not authorise

- **Tier: Heavy.** Reason under `CLAUDE.md` "Delivery tiers": the delivery adds a new authenticated endpoint that obtains and uses OAuth tokens for a user's channel, which is security work. The owner set the same tier for the same reason on Stage 2's backend (`docs/specs/2026-11-20-youtube-stage2-resource-browse.md`, D9). Two things would each make it Heavy on their own and also change who merges:
  - **a new OAuth scope** (spec branch B) is a permissions change → the PR merges only after Waleed's card approval;
  - **a migration** (decision D6-B) → the PR merges only after Waleed's card approval, with a database snapshot first.

  Under the recommended options there is neither, so after all gates the manager merges ("Other Heavy work"). The public disclosure text is the exception inside the PR: its wording needs Waleed's approval before the merge (step 6).
- **Tier duties.** Claude Fable 5.2 (medium) writes the plan — this document. Codex Astra 6.2 (medium) debates it for one round before implementation starts; the manager opens that session with `delegate_task`. The implementer runs `clean-code-guard`, `test-guard` and `waleed-security-reviewer`. The manager runs `/code-review` once on the whole PR with a different model from the implementer's. CI is green on the exact head. At most three review rounds; after the third, P2/P3 findings become issues and P0/P1 block.
- **Baseline.** Stage 4 head `7b8fe42b` (PR #471). Implementation starts from `origin/main` **after Stage 4 has merged and its migration has been applied in production**: Stage 5 uses the health-neutral token store that migration creates (`store_youtube_refreshed_token_with_lease_neutral`, `supabase/migrations/20261122130000_youtube_stage4_comment_operations.sql`). If the merge is not `7b8fe42b`, step 1 repeats the citations.
- **Not authorised by this document:** any code, any migration, any call to a Google API, any production access, a branch, a push, a PR, a deployment, a flag or policy change, probe P1 or rehearsal R1. Each of the last four keeps its own approval (§5).

## 2. Work in dependency order

Every delegation brief names `ARCHITECTURE.md` as required reading, with §§3–4 (feature layering), §§12–17 (edge function shape, authentication, validation, errors, logging), §§22, 24–26 (one contract, service role, CORS, external HTTP), §§33–34 (testing), §§37–38 (tokens, quota), plus `CLAUDE.md` "Task Execution Workflow" and the tier and exceptions chosen on the tier card.

### Step 0 — Owner preconditions (no code)

| Item | Owner | Result |
|---|---|---|
| Decisions D1–D6 (spec §11), as cards. | Waleed | The plan stands, or §8 applies. |
| Enable the YouTube Analytics API in the Google Cloud project. | Waleed | Needed by P1 and by the feature. |
| Read in the Cloud Console: the Analytics API's daily quota; the consent-screen status (Testing or In production); the sensitivity mark of `yt-analytics.readonly`. | Waleed | Three facts the public pages do not give (spec §3.1, §3.4). |
| **Probe P1** (spec §7.2), procedure below. | Waleed approves; the manager runs it under that approval | Branch A or B. The refusal body, if any, becomes a fixture. |

**P1 procedure.** It is one read and writes nothing to YouTube or to Postora's database.

1. Waleed names one connected native channel and approves the probe for it.
2. The request: `GET https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==<that channel's ID>&startDate=<10 days ago>&endDate=<3 days ago>&metrics=views`, with an access token whose recorded scopes include `youtube.readonly` and do not include `yt-analytics.readonly` (true of every channel connected today).
3. The token is used on the production host under the approval and is never printed or copied into a chat, a file or a log. To avoid handling a production token at all, Waleed can run the same request himself in a Google tool for his own channel, granting only `youtube.readonly`; that answers the scope question, though not whether the API is enabled for Postora's project.
4. Recorded in the PR and in `mem0`: the HTTP status; on success the column headers and the number of rows, not the values; on refusal the status, the reason string and the message, and nothing else from the body.
5. `200` → branch A. A permission refusal → branch B. "API not enabled" → enable it and repeat once. Anything else → report to Waleed; do not retry.

Exit: the branch is known. If P1 cannot be run before implementation, build branch A and keep step 7 ready; the capability constant is the only code difference.

### Step 1 — Freeze facts and fixtures

- On the real base, repeat the citations of spec §2.1 and §2.2 and correct any that moved.
- Re-read, word for word, the two Google passages the specification could only summarise: the YouTube developer policy on stored and derived data (III.E.2, III.E.4) and the "top videos" rules on the channel reports page, including which metrics are allowed with `dimensions=video`. Record the sentences in the PR. If `averageViewDuration` or `comments` cannot be confirmed for that report, the top-videos block ships with the verified sample set (`views`, `estimatedMinutesWatched`, `likes`). If the policy forbids anything in spec §4.1, stop and report to the manager before writing code.
- Confirm from the `videos.list` reference how many IDs one call accepts. If fewer than ten, the title lookup is batched or reduced accordingly.
- Write offline fixtures from the Google reference: a totals answer, a daily answer, a top-videos answer, an answer with no `rows`, a column-header mismatch, `The query is not supported`, and the P1 refusal if one was recorded.
- Run as green before anything changes: the `youtube-resources` capability contract and its handler suite; the `youtube-oauth` scope list; the health-neutral refresh mode in `_shared/youtubeTokenRefresh.test.ts`.

Exit: fixtures committed, the compatibility tests green on the base, the two re-read passages attached to the PR.

Files: `supabase/functions/youtube-analytics/fixtures/*.ts` (new).

### Step 2 — Contract, window, rollout parser, capability (pure code)

- `supabase/functions/youtube-analytics/contracts.ts`: operations, envelopes, metric keys and units, error codes with status, periods, limits, the required-scope constant. Runtime-neutral.
- `supabase/functions/youtube-analytics/window.ts`: the Pacific-time window, three days back.
- `supabase/functions/youtube-analytics/rollout.ts`: the policy parser (`off`, `allowlist`, `all`; at most 200 IDs; fail closed) and its port.
- `supabase/functions/youtube-analytics/capability.ts`: the pure availability rule (Composio, connection, recorded scopes), reading recorded scopes with `grantedScopes` from `_shared/youtubeCommentCapability.ts`. **`youtube-resources` is not edited.**

Tests: `contracts.test.ts`, `window.test.ts`, `rollout.test.ts`, `capability.test.ts`.

### Step 3 — Provider client

- `supabase/functions/youtube-analytics/analyticsReadClient.ts`: three report requests and the title lookup. 15-second timeout; `ids` built from the account's channel; strict validation of column headers and values; the error mapping of spec §5.2; no database access; no import of `dropGrantedScope`.
- A private classifier that wraps `classifyGoogleError` (`_shared/youtubeApiErrors.ts`) without changing it.

Tests: `analyticsReadClient.test.ts` with a fake `fetch` (spec §9.1).

### Step 4 — Handler, wiring, CI step

- `supabase/functions/youtube-analytics/handler.ts` with injected ports (auth, accounts, rollout, tokens, provider, rate limit, refusal log, clock, IDs) and the fixed check order of spec §5.2.
- `supabase/functions/youtube-analytics/index.ts`: builds the ports. Tokens only through `refreshYouTubeAccountToken` with `healthNeutral: true`. Rate-limit keys `youtube-analytics:burst` and `youtube-analytics:day`. Refusal rows to `system_logs` with category `edge`. `restrictedCorsHeaders`.
- `supabase/config.toml`: register the function with the same JWT setting as `youtube-resources`, if that file lists functions on the implementation head (it did not match a search at `7b8fe42b`; check before editing).
- `.github/workflows/ci.yml`: a named step "Typecheck and test youtube-analytics" next to the `youtube-resources` step.

Tests: `handler.test.ts` with fake ports, the health-neutrality suite, and a composition test for `index.ts` (spec §9.1).

Exit of steps 2–4: the function is complete and dark; nothing in the browser calls it yet. Per ARCHITECTURE §1 it must not merge alone — steps 2–6 are one PR.

### Step 5 — The page

- `src/features/youtube-analytics/` with `domain`, `application`, `infrastructure`, `ui`, `tests`, `index.ts` (spec §5.6). The trend chart uses `recharts`, as `src/features/analytics-contract/ui/SavedAnalyticsReport.tsx` does.
- `src/pages/analytics/YouTubeAnalytics.tsx`; route `/analytics/youtube` in `src/components/AnimatedRoutes.tsx`; sidebar child in `src/components/layout/DashboardLayout.tsx`; flag `feature_analytics_youtube` → `analyticsYoutube` in `src/hooks/useFeatureFlags.tsx` (default `false`, label, admin list).
- "View analytics" link in `src/features/youtube-management/ui/YouTubeVideoDetail.tsx`, shown only with the flag on. Frontend only; the analytics page itself reports whether analytics is available.
- Arabic: a `youtube` group in `src/i18n/locales/ar/analytics.json`; the sidebar label in `src/i18n/locales/ar/nav.json`. English inline.

Tests: Vitest and Testing Library per spec §9.3, the layering test, the route and flag wiring test, and the shared request fixture used by both the Deno handler test and the Vitest gateway test.

### Step 6 — Public text and documents

- `src/pages/GoogleApiDisclosure.tsx`: list the scopes Postora really requests (it omits `youtube.force-ssl` today) and replace the sentences that say Postora never reads YouTube Analytics with an accurate description: read-only, the owner's own channel, shown to that owner only, not stored. **The wording is sent to Waleed for approval before the merge.**
- `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`: the scope table, the privacy-policy block and the consent-screen status as read in step 0. The `/privacy` page gets the same sentence if it describes Google data.
- New runbook `docs/runbooks/youtube-analytics-rollout.md`: the two gates, the policy JSON with examples, how to add and remove a channel, how to switch everything off, P1 and R1 as numbered procedures, what to check after the merge.
- `CLAUDE.md`: one row for `youtube-analytics` in the Edge Functions table. `docs/developer/analytics.md`: one line stating that YouTube analytics is on demand through `youtube-analytics` and is not served by `get_account_analytics`.
- `docs-guard` on every document touched, including this plan and the specification.

### Step 7 — Only under branch B (the analytics scope must be added)

- `supabase/functions/youtube-oauth/handler.ts`: add `https://www.googleapis.com/auth/yt-analytics.readonly` to the scope list. Nothing else in that function changes.
- The required-scope constant in `youtube-analytics/contracts.ts` changes to that scope. `youtube-resources` stays untouched.
- Tests: the authorise URL carries four scopes; a grant that omits the analytics scope (the owner unticked it) is recorded as given and yields `missing_scope`; a row with no recorded scopes still proceeds; publishing and comment capabilities are unchanged for every fixture.
- The disclosure page and the verification guide list four scopes, with the justification text for the new one.
- If the Cloud Console marks the scope sensitive: Waleed submits it for Google verification with the justification and the demo video. The feature can ship dark meanwhile; no channel outside the test users is enabled until Google approves.

### Step 8 — Journey, integrate, review, hand over

- `e2e/fixtures/youtubeStage5Server.ts`, `e2e/youtube-stage5.spec.ts`, `scripts/stage5-e2e.mjs` (spec §9.4), run locally in English and Arabic; the command, head SHA and result go in the PR.
- `supabase/tests/youtube_analytics_rollout_privacy.sql`, registered in `SUITES` in `scripts/db-harness.sh`.
- Run every gate of §3 on the actual head. Implementer guards; the manager's single whole-PR `/code-review`; CI and bot rounds under the round cap; then §5.
- `graphify update .` after the code lands.

## 3. Acceptance evidence

All automated evidence is offline. Each case asserts the visible result **and** the count of provider requests.

| Layer | Required observations |
|---|---|
| **Deno: contract, window, rollout** | Spec §9.1 rows 1–3. |
| **Deno: provider client** | Exact URL and parameters per operation; `ids` from the account, never from input; header mismatch, non-numeric value, wrong row width; missing `rows` is empty; each error class; no provider text in a result; titles only for rows whose channel matches. |
| **Deno: handler** | Every refusal in spec §5.2 with **zero** provider requests; foreign equals missing for accounts and for videos; one forced refresh and one repeat on `401`, never more; a refusal row per refusal; no token in any response or log line. |
| **Deno: health neutrality** | No path writes `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`; the function does not import `dropGrantedScope`. |
| **Deno: compatibility** | The step 1 suites replayed unchanged: `youtube-resources` capability and handler, `youtube-oauth`, the refresh lease. No file of `youtube-resources` is edited. Under branch A the `youtube-oauth` scope list is byte-identical. |
| **SQL harness** | The rollout key is invisible and unwritable to `anon` and non-admin `authenticated`; readable and writable by an admin; readable by `service_role`. |
| **Vitest** | Spec §9.3, in particular: account switch never shows the previous account's numbers; every state has its own message; no net-subscriber or comparison figure anywhere; Arabic and right-to-left. |
| **Playwright, English and Arabic, real local handler** | The nine journey steps of spec §9.4, with the provider count asserted at each and a failure on any unexpected external request. |
| **Documents** | `docs-guard` clean on every touched document. |

### Denied effects — each must be shown impossible, not merely untested

1. A provider request for an account that is not owned, not active, not YouTube, not native, or not admitted by the rollout policy.
2. A channel ID or video owner taken from the browser.
3. Numbers of one channel shown to another user, or to the same user under another selected channel.
4. Any write to account health or recorded grants caused by an analytics request.
5. Any analytics value, video title, token or provider body in a database table or a log.
6. A number computed by Postora from YouTube numbers (net subscribers, rates, comparisons, cross-channel sums).
7. A failed or refused read shown as an empty report.
8. Any change in the responses or files of `youtube-resources`, in `youtube-oauth` (branch A), publishing, comments, the Partner API, n8n or MCP.
9. A request to Google with the flag on but the policy absent.

## 4. CI facts this plan must respect

| Fact at the baseline | Consequence |
|---|---|
| Each YouTube function has its own named Deno step (`.github/workflows/ci.yml:457-485`). | Add "Typecheck and test youtube-analytics"; confirm in the job log on the final head that every new test file ran. |
| SQL suites run only if listed in `SUITES` in `scripts/db-harness.sh` (`:107`); a suite on disk but not listed fails the harness. | Register the new suite. |
| Playwright is not a CI job. | The journeys are local evidence recorded in the PR, as in Stage 4. Making Playwright a job is a separate CI PR under the CI critical-path rule. |
| Vitest runs in two shards behind a required aggregate; lint and i18n are compared with the immutable base. | New copy keys must not regress the comparison; every new English string has its Arabic entry. |
| `.github/workflows/owner-analytics-local.yml` triggers on `supabase/functions/_shared/**`. | This delivery adds and edits no file under `_shared` (it only imports from it); if a reviewer asks for a shared file, expect that workflow to run. |
| Live suites never run in CI. | No Stage 5 test calls Google. |

This delivery adds one step and one suite to existing jobs. The CI critical-path measurement rule is not triggered.

## 5. Release sequence

There is no staging stack; the environment is production. A merge to `main` deploys the frontend and, within about two minutes, the edge functions through the Dokploy schedule `Edge Functions Sync (POSTORA)`. The schedule does not wait for migrations (`docs/runbooks/deploy-edge-function.md`). Under the recommended options there is no migration, so nothing has to be applied before the merge; row 3 exists for decision D6-B.

| # | Step | Owner | Gate |
|---|---|---|---|
| 0 | Step 0 of §2: decisions, API enabled, Console readings, P1. | Waleed | Before implementation |
| 1 | Implementation, guards, whole-PR review, CI and bots green on the exact head. | Implementer, manager | — |
| 2 | Disclosure wording approved. Under branch B or D6-B: **approval card after CI is green on that head**; under D6-B the card shows the migration file hash and object list. | **Waleed** | Required for the text; required for the merge under B or D6-B |
| 3 | *D6-B only:* production database snapshot, keep the receipt; apply the migration as `supabase_admin`; verify the policy and the function, and that the rollout key is absent. | Waleed, or the manager under that approval | **Before the merge** |
| 4 | Merge. Verify the synced `youtube-analytics` files by SHA-256 against `git show <merge>:<path>`. | Manager | Flag off and policy absent → Stage 5 is dark |
| 5 | Verify in production with everything off: `status` answers `not_enabled` for an owned channel and `not_found` for a random ID; the YouTube Channel page, publishing and comments are unchanged; the disclosure page shows the new text; no `/analytics/youtube` entry in the sidebar. | Manager | — |
| 6 | Enablement, **one step per approval**: policy `allowlist` with one named channel → flag on → **rehearsal R1** (read-only) → remaining pilot channels → `mode: "all"` only after the Console quota reading. | **Waleed** | Never implied by the merge or by an earlier approval |
| 7 | Plan summary after the merge in the `CLAUDE.md` format («ما تم»، «الباقي»، «التوصية»), and a `mem0` record. | Manager | — |

## 6. Rollback

- **First action: set the policy `mode` to `off`, or remove the key.** The next request from any channel is refused before a provider call, in running instances too. Turning the flag off hides the page.
- Triggers: numbers shown for the wrong channel; any change to account health or grants traced to analytics; Google quota pressure on publishing or comments; provider errors surfacing as empty reports; any change in an existing response.
- **Rollback by policy is the default and is sufficient for every trigger above.**
- Code rollback: revert the merge. The frontend redeploys on push and the schedule removes the function directory on its next run. There is no schema and no stored data to clean up. An old frontend against the new backend never calls the function; a new frontend against an old backend gets a failed `status` call and shows the temporary-failure state.
- The disclosure text is reverted with the code only if no channel was ever enabled; otherwise it stays accurate and stays.
- Branch B: reverting removes the scope from future consent requests. Channels that already granted it keep the grant harmlessly; no reconnect is needed in either direction.
- D6-B: the policy and function stay; removing them is a second migration with its own approval.

## 7. Acceptance gates

The delivery is accepted when all of these hold on the merged head:

- [ ] Every row of §3 is green, with the commands and results attached to the PR.
- [ ] Every denied effect in §3 is covered by a named test.
- [ ] With the flag off and the policy absent, production behaves exactly as before the merge (§5 row 5).
- [ ] The owner of an admitted native channel sees overview, daily trend and top videos for 7, 14, 30 and 90 days, and the same for one video, in English and in Arabic.
- [ ] A channel that is not admitted, a Composio channel, a channel needing reconnect and a channel without the permission each get their own message and cause zero provider requests.
- [ ] The page states the date the numbers run through and the Pacific time zone.
- [ ] No analytics request changes `needs_reauth`, `failure_count`, `last_refresh_error` or `granted_scopes`.
- [ ] The public disclosure lists the scopes actually requested and describes the analytics read.
- [ ] R1 has been run on the pilot channel and its answers (spec §9.5) are recorded; the owner has compared one period with YouTube Studio.
- [ ] The runbook exists and its commands were executed once during enablement.

## 8. What changes under the other options

| Decision | Change to this plan |
|---|---|
| D1-B (add the scope without the check) | P1 is dropped from step 0. Step 7 is built from the start. The merge needs Waleed's card (permissions). Every connected channel must reconnect before its first report. |
| D2-B (store the data) | This plan does not apply. A new specification is needed: `yt_*` tables with RLS and no browser grants, a collector with a cron job, a retention job, a SQL metric validator, a decision on the 30-day policy, and a snapshot and owner-card merge. |
| D3-B (overview and trend only) | `top_videos`, the title lookup, the video filter and the "View analytics" link are removed from steps 3–5; journey steps 4 and the top-videos part of 2 go. |
| D3-C (also traffic, countries, devices) | Three more operations, three more blocks and states; fixtures and tests for thresholded and empty answers; the typical visit costs six more requests. |
| D4-B (7, 28, 90, 365) | One constant and its tests. |
| D5-B (a tab in the YouTube Channel page) | No route, flag or sidebar entry; the screen mounts in `src/pages/youtube/YouTubeManagementPage.tsx` behind `feature_youtube_management`. |
| D6-B (migration for the gate) | One forward-only migration: a RESTRICTIVE policy on `app_settings` for the key and a `SECURITY DEFINER`, service-only evaluator with a pinned `search_path`. The SQL suite also covers them. Release rows 2 and 3 apply; the merge needs Waleed's card. |

## 9. Design verification performed

- Code read through `git show` at `7b8fe42b`; nothing was checked out, and no file in the repository was written. The list is in spec §12.
- Google pages fetched on 2026-11-23. Passages that could only be summarised are marked in the specification and re-read in step 1.
- Not done, by instruction: code, migration, branch, commit, PR, production access, any call to a Google API. `mem0` was not consulted from the design session.

## 10. Contract summary for the implementer

One new read-only function, `youtube-analytics`, with four operations (`status`, `summary`, `daily`, `top_videos`), serves a new page at `/analytics/youtube`. It reads the YouTube Analytics API on demand for one owned, native, admitted channel and stores nothing. The channel ID always comes from the account row; a video is accepted only after its ownership is confirmed. Tokens come only from the lease helper in health-neutral mode, and no analytics path ever changes account health or recorded grants. Rollout is a private, default-absent policy key read by the server on every request, plus a visibility flag that is off by default. Postora computes no numbers of its own. The permission used is a single constant, set by probe P1. Everything public, automated and existing is unchanged, except the public disclosure text, which is corrected.
