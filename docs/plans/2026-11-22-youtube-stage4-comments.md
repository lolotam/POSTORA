# YouTube Stage 4 — implementation and acceptance plan (revised, Heavy)

22 November 2026 · **Heavy** · one delivery, one release candidate, one rollback plan. Contracts, provider citations and the receipt model are in the [Stage 4 specification](../specs/2026-11-22-youtube-stage4-comments.md); this plan does not restate them. No slice below ships alone, and none alone closes roadmap §4.

## 1. Tier, baseline and what this plan does not authorise

- **Tier: Heavy**, by Waleed's decision relayed on 2026-11-22: one delivery including one additive migration (spec §1, O1–O3). Under AGENTS.md "Delivery tiers" this means: this Fable 5.2 plan, then **one** Astra 6.2 Medium debate round before implementation; implementer runs `clean-code-guard`, `test-guard` and `waleed-security-reviewer`; the manager runs `/code-review` once on the whole PR with a different model; CI green on the exact head; the PR contains a migration, so it **merges only after Waleed's card approval**.
- **Baseline.** The design worktree was prepared at `6f82242a` (clean). `21447f2de26b373a41acc23a5509a0718be1248c` — the Stage 3 merge, equal to `origin/main` at the time of writing — was two commits ahead and the branch was fast-forwarded to it before these documents were written. The first Stage 4 draft (`665fa859`) is not an ancestor of this branch; both files are new here and replace it.
- **Native only** for the new actions is the manager's working assumption (spec A1), not an owner decision.
- **Not authorised by this document:** any code or migration, any live provider call, any production access, a push, a PR, a deployment, a flag or rollout-key change, or a live rehearsal. Each is a separate step with its own owner below.

## 2. Work in dependency order

Every delegation brief for this work must name `ARCHITECTURE.md` as required reading, with §§12–18, 22–27 and 33–38, plus AGENTS.md "Reviewing a pull request" rules 1–5.

### Step 1 — Freeze compatibility and facts

- Characterise, as tests that pass on the baseline before anything else changes: the `comment-manager` switch and its service-role allow-list; Partner `list/get/replies/reply/hide` and the unsupported delete; n8n's `INVALID_PLATFORM` for YouTube; hide → `rejected`, unhide → `published` including provider refusal; own delete success and foreign denial; reply-to-reply normalisation; self-author suppression in polling. Pin keys, status codes, casing, pagination and replay.
- Confirm the Postgres major on production read-only through the approved channel **before** writing the migration, and compare with the CI image (`supabase/postgres:17.6.1.158`, `scripts/db-harness.sh`). The constant-default column and the trigger must be valid on both.
- Inventory every writer and reader of `social_accounts` that could be affected by a new column: positional inserts, `%ROWTYPE` and `RETURNS ... social_accounts` in SQL (a first search found 19 candidate lines to review), `select("*")` readers in TypeScript, and the generated database types.
- Record, as offline fixtures taken from the Google reference in spec §3, the response shapes for each method, including a thread whose ID differs from its top-level comment ID.

Exit: a compatibility suite that is green on `21447f2d`, and a written inventory attached to the PR.

### Step 2 — The one migration and its isolated SQL proof

One forward-only file containing exactly: the `binding_generation` column and its trigger (spec §6.2); `youtube_comment_operations` with its constraints and indexes (spec §7.1); the evaluator and the four receipt functions (spec §7.3). Apply as `supabase_admin`. No seed row for the rollout key. Nothing else.

A new suite `supabase/tests/youtube_comment_operations.sql`, **registered in `SUITES` in `scripts/db-harness.sh`** so the `db-harness` CI job runs it on baseline plus migration. It uses the two-session `dblink` pattern already used by `youtube_refresh_lease.sql`. Required assertions:

| Area | Assertion |
|---|---|
| Old-code compatibility | With the migration applied and **no** new code: the native reconnect upsert, the Composio activation upsert, the browser's `is_active = false` update run **as the `authenticated` role under RLS**, the server's credential-clearing update, and each refresh RPC all succeed with unchanged results. An insert that omits the column gets `1`. Existing suites in `SUITES` stay green. |
| Generation semantics | Refresh RPCs leave the generation unchanged. Disconnect, re-activation, native re-consent (new `connected_at`), provider switch and `connection_id` change each increase it by exactly one. A client-supplied generation on insert or update is ignored. It never decreases. Non-YouTube rows never change. |
| Privileges | `anon` and `authenticated` cannot select, insert, update or delete the table and cannot execute any function. `service_role` can execute the functions and has no direct table grant beyond what they need. `search_path` is pinned on every function. |
| Tenant isolation under the service role | Two owners connected to the **same channel ID**; one owner with two accounts; crossed owner/account IDs; a foreign account and a missing account return the identical refusal. |
| Per-key fence | Two concurrent sessions claim the same `(owner, operation_id)`: exactly one receives an attempt token. Same key with a different digest → `conflict`. Only the token holder can mark dispatched or settle; a spoofed token changes nothing. |
| Logical fence | Two different keys with the same logical digest, concurrently: one winner, the other `possible_duplicate`. After `confirmed` the same text may be posted again. A stale `claimed` row is closed by CAS and the next claim proceeds; a `dispatched` or `indeterminate` row is never closed. |
| Crash windows | Session death after claim and before `mark_dispatched` → still `claimed`, reclaimable. Death after `mark_dispatched` → reads as `indeterminate` after the budget, permanently, and no function returns it to a sendable state. Late settlement by the original token is accepted. |
| Rebinding | Claim under generation *n*, then disconnect or reconnect: `mark_dispatched` returns false and the row is `refused`. Status under generation *n+1* returns `not_found` for every row of generation *n*. An unresolved create from generation *n* still yields a bare `possible_duplicate` under *n+1*. Hard-deleting the account leaves the receipt present with a null account and unreachable through status. |
| Rollout evaluator | Key absent, malformed, wrong version, `off`, account not listed, `ban_author` false → deny for the relevant capability. Listed account → admit. Turning the key off between claim and `mark_dispatched` stops the send. Status still works with the key off. |
| Durability | No sweep, cron job or generic function in the baseline modifies the table; an unresolved row survives every rollout-key value. |

Exit: the suite is green in a disposable database; the migration's object list and hashes are recorded.

### Step 3 — Provider operations

- A private Stage 4 provider module beside `_shared/youtubeComments.ts`: paged uploads; per-video filtered thread pages projecting **both** thread ID and top-level comment ID; reply pages; video ownership read; target read by ID; and the four writes. Existing exports and the shared classifier are not modified; an additive export of the token helper is the only permitted touch.
- A private mutation transport with one send, a 15-second timeout, the inherited single `401` refresh-and-resend, and the classification table in spec §9.2. It returns a typed result that distinguishes "not sent", "provider refused", "accepted" and "unknown".
- One shared pure builder and validator for `commentThreads.insert`, used by Stage 4 and by `process-post/youtubeUploadFollowUps.ts` with no behaviour change there (spec F6); that file's existing tests are the regression.
- A private classifier wrapping the shared one (spec §11).
- `banAuthor` is appended to the query **only** by the one code path that has a verified ban intent; a test asserts the key is absent from every other request, including plain Reject.

### Step 4 — The handler

- `comment-manager/index.ts` gains only a route to a separate Stage 4 handler module, placed before the legacy account lookup. The handler takes injected auth result, database, provider, clock, ID and refusal-log ports. A production composition test catches a handler that is built but not wired.
- Strict Zod schemas per action; sealed cursors and target handles with distinct prefixes on the existing HMAC pattern; server-derived capabilities.
- Fixed order for writes: validate → account → gate → verify → claim → mark dispatched → send once → settle. Fail-closed read and write rate limits on the existing per-user limiter (`_shared/rate-limiter.ts`), sized against Google's 50-unit writes and the shared daily allocation, with a separate low cap for ban requests.
- Refusals of authenticated requests write `system_logs`; unauthenticated ones emit the sanitised console event (spec §12).

### Step 5 — The interface at `/comments`

`src/features/youtube-comments/` with `domain`, `application`, `infrastructure`, `ui`, mounted from the existing panel when the capabilities action allows. Scope and states per spec §§9–11 and §14: paged video picker including empty uploads; Published and Held lists; separate top-level composer; per-row reply, edit for channel-authored rows, and status-dependent moderation; Reject dialog; the separate ban option and its second dialog; indeterminate states with a status check and **no resend**; English and Arabic copy, RTL, keyboard and focus behaviour. Generated database types updated for the new column.

### Step 6 — Integrate, review, hand to the owner

Run every gate in §3 on the actual head and attach commands, results, and the migration and function hashes. Implementer guards, then the manager's single whole-PR `/code-review`, then CI and bot rounds under the Heavy round cap. Then the release sequence in §5, each step with its owner.

## 3. Acceptance evidence

All automated evidence is **offline**: fake provider, synthetic accounts, disposable database, no public egress. Each case asserts the visible result, the provider call count, and persisted state where relevant.

| Layer | Required observations |
|---|---|
| **Isolated concurrent SQL** | The table in step 2, run by the `db-harness` job. |
| **Deno: provider module** | Divergent thread and top-level IDs never swapped. More than 100 replies across pages, duplicate inline rows merged, a cursor cycle rejected, a late-page failure retried without losing earlier rows. A held reply under a published parent, in **both** variants of the unknown in spec §8.4 (returned with status; not returned). Every row of spec §9.2 and §11, including `204`, `commentsDisabled`, insufficient scope, quota, `401` then success, `401` twice, a `2xx` missing IDs, a `5xx`, a network abort, and a true empty list versus an empty page with a next token. |
| **Deno: handler with fake provider** | Through the real route in `index.ts`. Exactly one `commentThreads.insert` on a video with zero comments, with no parent field; a fenced reply; an own top-level edit and an own-reply edit. Each of these produces **zero** provider writes and a sanitised reason: foreign or missing author on edit; another user's account; mismatched channel, video, comment or parent; expired, forged or cross-account handle; service-role caller; gate off; rollout key unreadable; rate limit; stale cursor; unknown body keys including `banAuthor`, `user_id` and `channel_id`; Composio account. |
| **Deno: fences and recovery** | Double click; two tabs with the same key; two tabs with different keys and the same text; changed intent under the same key; provider success with the browser response lost; provider response lost before settlement; settlement database failure; process restart; stale claim; status read failing; account switched mid-flight; disconnect and reconnect mid-flight. Assert at most one **accepted dispatch** per operation, no unverified success, no automatically generated replacement key, and that an indeterminate create or reply can never be re-sent by any combination of calls. |
| **Deno: moderation and ban** | Hold, publish and reject use the selected comment's ID. Plain Reject sends no `banAuthor` key. Ban without `rejected` refused before claim. Ban with missing author, with `ban_ack` not matching the handle, with the fresh read's author differing from the handle, on the channel's own comment, with `ban_author` off in the rollout key, or from a service-role caller: zero provider calls and **no** fallback to plain reject. A valid reject-and-ban sends exactly one request with one ID, `moderationStatus=rejected` and `banAuthor=true`. A lost response is `indeterminate` for both effects. A `404` afterwards is not read as success. The response never contains a "banned" status. |
| **Deno: compatibility** | The step 1 suite replayed with the gate off and on: Partner, n8n, legacy inbox actions, AI agent and workflow delivery, polling. The connector registry `tools` and `mutating` arrays are byte-identical to the baseline. Re-reading the inbox dispatches no automation event. |
| **Vitest and Testing Library** | Capability-driven controls; server refusal despite a forged `is_own`; inline and page de-duplication; stale-account responses dropped; "comments disabled" versus "reconnect needed" versus "no comments yet" rendered distinctly; pending, indeterminate and status-check controls; the two-step ban confirmation including cancel at each step; the ban copy never asserting a ban; Facebook, Instagram, Threads and Composio YouTube panels unchanged with the gate off and on. |
| **Playwright, English and Arabic** | Using the intercepted-fixture pattern of `e2e/fixtures/youtubeStage3.ts`, with a local fake handler and provider and a failure on any unexpected external request: select an empty upload, post, reload, edit; a foreign edit refused; three reply pages including one retry; hold then publish; reject with confirmation; reject with ban through both dialogs; indeterminate create after reload showing no resend; account switch while a page is in flight showing no previous text or operation; gate off showing the baseline inbox. Role and label selectors; RTL checked in Arabic. |
| **Reviewed documents** | `docs-guard` on this plan, the specification, and every runbook or API doc the implementation touches, each claim checked against the head. |

### Denied effects — each must be shown to be impossible, not merely untested

1. A second public comment or reply from one deliberate submit, by any path: double click, second tab, reload, retry wrapper, token refresh, timeout, process restart, rollback, reconnect.
2. A send for an account that is not owned, not active, not native, not admitted, or whose binding changed after the claim.
3. A receipt returned across owners, across accounts, or across a disconnect or reconnect of the same account.
4. `banAuthor` on any request that is not a separately confirmed Reject for a verified author; any ban reachable by the AI agent, a workflow, the Partner API, n8n, MCP or a service-role caller **through Stage 4 code** (the pre-existing Composio agent path is finding F1).
5. A reject, or a ban, reported as observed; an author reported as banned; an undo offered.
6. A moderation or edit applied to a comment identified by a thread ID, or to a comment whose video binding rests on anything but a verified thread or parent chain.
7. "Comments disabled", "permission lost" and "no comments" shown as one another; an unknown provider error changing account health or grants.
8. Comment text, tokens, cursors or unverified identifiers in `system_logs`, in the receipt table, or in console output.
9. Any change in the responses of Partner, n8n, MCP, the legacy inbox actions, or the agent's tool list.

## 4. Existing CI facts this plan must respect

Read from `.github/workflows/ci.yml` and `scripts/db-harness.sh` at the baseline:

| Fact | Consequence |
|---|---|
| `comment-manager` has **no** Deno CI step today. `_shared/youtubeComments.test.ts` runs in the YouTube suite list; `youtube-resources` and `youtube-oauth` have their own steps. | Add a named "Typecheck and test comment-manager" step, and add the new shared Stage 4 test files to the enumerated list. Confirm in the job log that each new file actually ran; a helper-only pass is not evidence. |
| SQL suites run only if listed in `SUITES` in `scripts/db-harness.sh`; the job runs baseline plus every migration on a disposable `supabase/postgres` container. | Register the new suite. Concurrency uses `dblink`, as `youtube_refresh_lease.sql` already does. |
| **Playwright is not a CI job** (the workflow header says so and explains why). | The English and Arabic journeys are **local evidence**, recorded in the PR with the exact command and result. Making Playwright a job is a separate CI PR under the CI critical-path rule, not part of this delivery. |
| Vitest runs in two shards behind a required aggregate; lint and i18n are compared against the immutable base. | New Arabic and English keys must not regress the i18n comparison. |
| Live suites (`*.live.test.ts`) are never run by CI. | No Stage 4 test may call a real provider; none is named `.live.test.ts`. |

Because this delivery only adds steps and a suite to existing jobs, no CI restructuring is proposed and the CI critical-path measurement rule is not triggered.

## 5. Release sequence

There is **no staging stack**; the environment is production (spec §13). Schema goes before code, because merged Edge code and the frontend deploy shortly after a merge to `main` and the migration is applied by hand (`docs/runbooks/youtube-comments-rollout.md` follows the same order).

| # | Step | Owner | Gate |
|---|---|---|---|
| 1 | Debate round on this plan; fold in the outcome; resolve D1–D8 that block. | Manager; Waleed for owner decisions | Before implementation |
| 2 | Implementation, guards, whole-PR review, CI and bots green on the exact head. | Implementer, manager | — |
| 3 | **Migration approval card**, after CI is green on that head, showing the migration file hash and the object list. | **Waleed** | Required. Approval of the merge and approval to apply the migration are asked together but are distinct answers. |
| 4 | Database snapshot of production; keep the receipt. | Waleed, or the manager under that approval | Before any DDL |
| 5 | Apply the migration as `supabase_admin`. Verify: column present with default; trigger present; RLS on with no policies; grants; function owners and `search_path`; rollout key absent. Run the old-code compatibility probes that need no live provider (a disconnect and a refresh on a synthetic row). | Same | Before merge |
| 6 | Merge. Edge functions sync from `main`; verify deployed files by SHA-256 against `git show <merge>:<path>` per `docs/runbooks/deploy-edge-function.md`. Frontend deploys automatically. | Manager | Rollout key still absent → Stage 4 is dark |
| 7 | Verify in production with the gate off: legacy inbox, Partner and n8n responses unchanged; `youtube_stage4_capabilities` reports everything unavailable; no receipt rows. | Manager | — |
| 8 | **Enablement**, each a separate approval naming the account: create the rollout key with one fixture account in `allowlist`; then rehearsal R-held (read-only); then any live write on a named private video; then, separately and last, `ban_author` — and only after D1 is closed. | **Waleed** | Never implied by a merge |
| 9 | Plan summary after the merge in the AGENTS.md format, and a `mem0` record of the task. | Manager | — |

## 6. Rollback

- **First action: set the rollout key to `off` or remove it.** New claims and sends stop at the next request, including in already-running function instances, because the evaluator is re-read inside `mark_dispatched`.
- Triggers: any duplicate send; any tenant or binding mismatch; any success shown without evidence; provider errors spilling onto other videos or accounts; quota pressure; any change in a public or legacy response.
- Keep: the additive schema, every receipt, and the read-only status action. **Never** delete or reset an unresolved receipt, never replay an uncertain create or reply, never issue a compensating provider write.
- Code rollback is by the normal deploy path to a compatible commit. The column and trigger on `social_accounts` stay: they are inert without Stage 4 code and removing them is a second migration needing its own approval.
- The existing tile flag and the polling job are independent and are not touched by a Stage 4 rollback.

## 7. Design verification performed

- Checkout: worktree `T3-CODE/dbb384fe`, clean; fast-forwarded from `6f82242a` to `21447f2d` (= `origin/main`).
- Read at the baseline: AGENTS.md, CLAUDE.md, ARCHITECTURE.md §§12–18, 22–27, 33–38; the Stage 3 plan; `comment-manager/index.ts`; `_shared/youtubeComments.ts`; `_shared/commentOps.ts`; `youtube-oauth/index.ts`; `composio-connect/activation.ts`; `youtube-resources/index.ts`, `handler.ts`, `editComposition.ts`; `ai-agent-reply/composioTools.ts`, `composioExecution.ts`; the connector registry; the refresh, refresh-lease, upload-session and disconnect migrations; `ci.yml`; `scripts/db-harness.sh`. The first draft was read at `665fa859` and the debate receipt in its thread.
- Google reference pages in spec §3 were fetched on 2026-11-22; quotations are theirs.
- Baseline Deno suites `_shared/youtubeComments.test.ts` and `comment-manager/youtubeCommentsView.test.ts`: **23 passed, 0 failed**. They exercise baseline behaviour only; every Stage 4 assertion above is an acceptance criterion for implementation, not something already shown.
- Not done, by instruction: code, migration, live provider call, production access, push, PR, deployment, flag change. `mem0` was not reachable from the design session, so no prior-history search or memory write was made there.
- Migration line numbers in spec §5 are quoted from the debate receipt; the files exist at the baseline but those lines were not re-read individually.

## 8. Handoff for the one Astra 6.2 Medium debate

**Contract in one paragraph.** Native-only private actions on `comment-manager` add paged uploads, Published and Held lists, fenced create and reply, own-comment edit, and hold/publish/reject with an optional, separately confirmed ban on Reject. One migration adds a trigger-maintained `binding_generation` on `social_accounts` and a service-only receipt table whose state machine allows one send per submit, fences an unresolved create or reply permanently and across reconnects, and exposes a receipt only under the binding that created it. Uncertain outcomes are never retried and never "confirmed" by guesswork; rejects and bans are reported as accepted requests, never as observed states. Rollout is one private, default-absent `app_settings` key evaluated in SQL at the moment of sending. Everything public, automated and legacy is unchanged.

**Try to falsify these claims.**

1. The `BEFORE` trigger on `social_accounts` cannot break any currently deployed writer on any platform, and no writer can change a YouTube binding without advancing the generation (spec §6.2; plan step 2).
2. No sequence of claim, mark, settle, status, timeout, restart, reconnect or rollback can produce two accepted `commentThreads.insert` or `comments.insert` calls for one deliberate submit, and the inherited `401` resend does not weaken that (spec §§7, 9).
3. A receipt cannot be read, and an old claim cannot be sent, after a disconnect or reconnect — while an unresolved create still blocks its duplicate (spec §7.4, D6).
4. Every moderated or edited comment is identified by a comment ID whose video binding comes from a verified thread or parent chain, given that the comment resource has no video field and no readable status by ID (spec §§3, 8).
5. `banAuthor` can leave the process only on a verified, twice-confirmed Reject, and nothing in the product can claim a ban took effect (spec §10).
6. The Held list is safe under either answer to the undocumented held-reply question (spec §8.4).

**Decisions the debate should press on:** D1 (agent ban path, F1), D4 (generation column versus snapshot tuple), D5 (no audit row for unauthenticated refusals), D6 (cross-generation duplicate fence), and whether `ON DELETE SET NULL` with an immutable account snapshot is the right permanence rule. D2, D3, D7 and D8 are recorded for the owner and do not block the debate.
