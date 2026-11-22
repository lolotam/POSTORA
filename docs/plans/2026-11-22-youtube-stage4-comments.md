# YouTube Stage 4 — implementation and acceptance plan (revised, Heavy)

22 November 2026 · **Heavy** · one delivery, one release candidate, one rollback plan. Contracts, provider citations and the receipt model are in the [Stage 4 specification](../specs/2026-11-22-youtube-stage4-comments.md); this plan does not restate them. No slice below ships alone, and none alone closes roadmap §4.

## 1. Tier, baseline and what this plan does not authorise

- **Tier: Heavy**, by Waleed's decision relayed on 2026-11-22: one delivery including one additive migration, Published and Held lists, and Reject with an optional separately confirmed ban (spec §1, O1–O3). The Fable 5.2 plan and the Astra 6.2 Medium debate required by AGENTS.md "Delivery tiers" are both done; this revision resolves that debate's five blockers and adopts its acceptance amendments (§9). Remaining tier duties: the implementer runs `clean-code-guard`, `test-guard` and `waleed-security-reviewer`; the manager runs `/code-review` once on the whole PR with a different model; CI green on the exact head; the PR contains a migration, so it **merges only after Waleed's card approval**.
- **Baseline.** The design worktree was prepared at `6f82242a` (clean) and fast-forwarded to the Stage 3 merge `21447f2de26b373a41acc23a5509a0718be1248c`, equal to `origin/main` at the time of writing. The first draft (`665fa859`) is not an ancestor; both files are new on this branch.
- **Native only** for the new actions is the manager's recorded assumption (spec A1).
- **No owner decision is open before implementation** (spec §16).
- **Not authorised by this document:** any code or migration, any live provider call, any production access, a push, a PR, a deployment, a rollout-key change, or a live rehearsal. Migration, merge, production deployment, each rollout capability and each live rehearsal keep their own separate approvals (§5).

## 2. Work in dependency order

Every delegation brief must name `ARCHITECTURE.md` as required reading, with §§12–18, 22–27 and 33–38, plus AGENTS.md "Reviewing a pull request" rules 1–5.

### Step 1 — Freeze compatibility and facts

- Characterise, as tests green on the baseline before anything changes: the `comment-manager` switch and its service-role allow-list; Partner `list/get/replies/reply/hide` and the unsupported delete; n8n's `INVALID_PLATFORM` for YouTube; the MCP comment tools; hide → `rejected`, unhide → `published` including provider refusal; own delete; reply-to-reply normalisation; the legacy one-time `401` resend; self-author suppression in polling; and the first-comment follow-up's current rule that `response.ok` alone is success, **including an incomplete `2xx`** (spec F6). Pin keys, status codes, casing, pagination and replay.
- Confirm the production Postgres major read-only through the approved channel and compare with the CI image (`supabase/postgres:17.6.1.158`). Confirm `sha256` and `gen_random_uuid` are available without an extension on both.
- Inventory on the implementation head: every writer of the identity and credential columns of spec §6.2 on a YouTube row; every `SECURITY DEFINER` function that updates `access_token` or `refresh_token` on `social_accounts`; positional inserts, `%ROWTYPE` and `RETURNS … social_accounts` uses (a first search found 19 candidate lines); `select("*")` readers; generated types; existing triggers on the table.
- Record offline fixtures from the Google reference for each method, including: unequal thread and top-level IDs; a comment with and without `snippet.videoId`; mismatching resource channel; a reply whose `parentId` is not the thread's top-level comment.

Exit: a compatibility suite green on `21447f2d`, and the written inventory attached to the PR.

### Step 2 — The one migration and its SQL proof

One forward-only file containing exactly: `binding_generation` and its trigger (spec §6.2); `youtube_comment_operations` and `youtube_comment_digest_keys` with constraints and indexes (spec §7.1–7.2); the functions of spec §7.4. Applied as `supabase_admin`. No seed row for the rollout key. Existing refresh functions are **not** edited.

A new suite `supabase/tests/youtube_comment_operations.sql`, **registered in `SUITES` in `scripts/db-harness.sh`**. Concurrency cases use **two real database sessions** over `dblink` (the pattern of `youtube_refresh_lease.sql`), with advisory-lock **barriers** that fix the interleaving, the real roles, and assertions made on state read **after commit** from a third connection.

| Area | Assertion |
|---|---|
| Old-code compatibility | With the migration applied and no new code: native reconnect upsert, Composio activation upsert, the browser's `is_active = false` update **as `authenticated` under RLS**, the server's credential clearing, and each refresh function succeed with unchanged results. The existing credential-change trigger still fires. All existing suites stay green. |
| Generation authority | **Unchanged** after: `store_youtube_refreshed_token`; `store_youtube_refreshed_token_with_lease` without a new refresh token; the same **with a rotated refresh token**; a metadata-only update by `authenticated`; a `needs_reauth` or `failure_count` write. **Advanced by exactly one** after: a credential change by `authenticated`; a credential change by a direct `service_role` update; disconnect; re-activation; native re-consent; native → Composio; Composio → native; `connection_id` change. A supplied generation is ignored on insert and update; it never decreases; non-YouTube rows never change. Delete and re-create yields a new row at `1` and leaves old receipts unreachable. |
| Trusted-writer authority | A dedicated NOLOGIN role, `youtube_stage4_refresh`, is a member of no role and holds no role as a member; it owns EXACTLY the two refresh functions; it is granted BYPASSRLS and the minimal table privileges those two bodies need; and the trigger preserves the generation only when `current_user = 'youtube_stage4_refresh'`. The catalog scan is deliberately NOT the authority, because this stack has many legitimate credential writers (OAuth activation, disconnect, Composio activation) that must advance the generation. |
| Provider reset | After the native save, the stored `auth_provider` is `native` and `connection_id` is null whatever the row held before; after Composio activation they are `composio` and set. |
| Privileges | `anon` and `authenticated` cannot read or write either new table or execute any new function; `service_role` executes the functions only; `search_path` pinned on each. |
| Tenant isolation under the service role | Two owners on the **same channel ID**; one owner with two accounts; crossed owner and account IDs; foreign and missing accounts return the identical refusal. |
| Expected-value validation | A claim whose expected channel or generation differs from the locked row is `not_found`. **Session A verifies, session B rebinds, session A claims → refused.** Rebind between claim and mark → mark returns false, row `refused`. Rebind after mark → the row stays `dispatched` and settlement is still recorded. The same three positions with the capability turned off instead of a rebind. |
| Per-key fence | Two sessions claim one `(owner, operation_id)` → one token. Different digest → `conflict`. A spoofed token cannot mark or settle. |
| Logical fence | Two keys, same logical digest, concurrently → one winner, the other `possible_duplicate`. Reply to reply A and reply to reply B in one thread with the same text → same logical operation. After `confirmed`: a different key within 10 minutes → `recently_posted`; after the window → allowed. Across a rebind and across delete-and-recreate → bare reason only. |
| Key rotation | Add digest key version 2; an unresolved row written under version 1 still blocks the same logical operation; a retired version referenced by any row cannot be removed. |
| Timeouts and cleanup | `claimed` older than 120 s is closed by compare-and-set and the next claim proceeds. `dispatched` older than 90 s reads `indeterminate`. Pruning removes only never-dispatched `refused` rows older than 30 days, at most 20, same owner; **no row with `dispatched_at` set is ever deleted**. |
| Late resolution | Token holder settles `indeterminate → confirmed` and `→ refused`; a non-holder cannot. A `5xx` outcome is refused by the function as a reason for `refused`. A late settlement racing the 90-second conversion converges in both orders. |
| Lost acknowledgement | Settlement commits, the caller's connection is cut before the reply: state read afterwards is `confirmed`; the same key returns it; a new key is `recently_posted`. |
| Rollout evaluator | Key absent, malformed, wrong version, account absent, capability false, prerequisite false → deny. Two accounts in one policy are independent, including `ban`. `read` on with `write` off admits reads and refuses every claim. Status works with the key absent. |
| Durability | No baseline sweep, cron job or generic function modifies either table. |

Exit: the suite is green in a disposable database; the migration's object list and hashes are recorded.

### Step 3 — Provider operations

- A private Stage 4 provider module beside `_shared/youtubeComments.ts`: paged uploads; per-video filtered thread pages; reply pages; video ownership read; target read by ID; the four writes. Existing exports, the shared classifier and the legacy `401` resend are untouched; an additive export of the token helper is the only permitted change to the shared file.
- The chain validator of spec §8.2 runs before any handle is sealed.
- A private write transport: credential prepared by the caller, **one HTTP request, no retry of any kind including `401`**, 15-second timeout, classification per spec §9.2. It performs **no** grant, health or `needs_reauth` mutation and never calls `dropGrantedScope`.
- The `commentThreads.insert` **request builder** is shared with `process-post/youtubeUploadFollowUps.ts`. That file keeps its own success rule and is not passed through the Stage 4 response validator (spec F6).
- `banAuthor` is appended to the query by exactly one code path; a test asserts the key is absent from every other request, including plain Reject.

### Step 4 — The handler

- `comment-manager/index.ts` gains only a route to a separate Stage 4 handler module, placed before the legacy lookup. Injected auth result, database, provider, clock, ID and refusal-log ports. A production composition test catches a handler that is built but not wired.
- Strict Zod schemas; sealed cursors, handles and the server-issued ban confirmation, each with a distinct prefix; digests computed with the SQL-held keys; server-derived capabilities.
- The fixed write order of spec §9.1, with the credential prepared before the claim and the expected owner, account, channel and generation passed to both claim and mark.
- Fail-closed read and write rate limits on `_shared/rate-limiter.ts`, sized against 50-unit writes and the shared daily allocation, with a separate low cap for bans.
- Refusal audit per spec §12, including the rate-bounded unauthenticated bucket.
- `youtube-oauth` save: explicit `auth_provider: 'native'`, `connection_id: null` (spec §6.3), with its own test; nothing else in that function changes.

### Step 5 — The interface at `/comments`

`src/features/youtube-comments/` with `domain`, `application`, `infrastructure`, `ui`, mounted from the existing panel when the capabilities action allows. Per spec §§9–11 and §14: paged video picker including empty uploads; Published and Held lists; separate top-level composer; per-row reply, edit for channel-authored rows, status-dependent moderation from the visible row only; Reject dialog; the ban option with the server-issued second confirmation; operation identity persisted before the first network call and restored on reload; indeterminate states with a status check and **no resend**; English and Arabic, RTL, keyboard and focus. Generated database types updated.

### Step 6 — Integrate, review, hand to the owner

Run every gate in §3 on the actual head and attach commands, results, and migration and function hashes. Implementer guards, the manager's single whole-PR `/code-review`, CI and bot rounds under the Heavy round cap, then §5.

## 3. Acceptance evidence

All automated evidence is **offline**: fake provider, synthetic accounts, disposable database, no public egress. Each case asserts the visible result, the count of **actual HTTP write requests**, and persisted state.

| Layer | Required observations |
|---|---|
| **Isolated concurrent SQL** | The table in step 2, run by the `db-harness` job with two real sessions. |
| **Deno: provider module** | Unequal thread and top-level IDs never swapped. More than 100 replies, duplicate inline rows merged, cursor cycle rejected, late-page failure retried without losing rows. Chain validation: wrong thread video, wrong resource channel, top-level comment with a `parentId`, reply with a foreign `parentId`, comment `videoId` absent (accepted) and present-but-different (refused) — **no handle is issued for an inconsistent row**. Resource channel and author channel are never interchanged. A held reply in both variants of spec §8.4. Every row of spec §9.2 and §11: `204`; a moderation `200`; `commentsDisabled`; insufficient scope; quota; `401` (**one request, refused**); a `2xx` missing IDs; `5xx` with and without an envelope (**always indeterminate**); network abort; true empty versus an empty page with a next token. No test path calls `dropGrantedScope`; a `scope_missing` result leaves stored grants untouched, including a late `403` arriving after a reconnect. |
| **Deno: handler with fake provider** | Through the real route in `index.ts`. Exactly one `commentThreads.insert` on a video with zero comments; a fenced reply; an own top-level edit and an own-reply edit. **Zero** provider writes and a sanitised reason for: foreign or missing author on edit; another user's account; mismatched channel, video, comment or parent; expired, forged or cross-account handle; service-role caller; capability off; rollout key unreadable; rate limit; stale cursor; unknown body keys including `banAuthor`, `user_id`, `channel_id`; Composio account. Credential refresh failure → nothing claimed. Rebind or capability-off **before claim**, **between claim and mark**, and **after mark**, each with the expected outcome of spec §9.1. |
| **Deno: fences and recovery** | Double click; two tabs, same key; two tabs, different keys, same text; changed intent under one key; provider success with the browser response lost **after settlement committed**; response lost before settlement; settlement database failure; process restart; stale claim; status read failing; account switched, disconnected and reconnected mid-flight. Assert exactly one HTTP write per marked operation, no unverified success, no automatically generated replacement key, and that an indeterminate create or reply cannot be re-sent by any combination of calls. |
| **Deno: moderation and ban** | Hold, publish, reject use the selected comment's ID. Plain Reject sends no `banAuthor` key. A ban is refused, with zero provider calls and **no fallback to plain reject**, for: no confirmation token; a client-fabricated token; an echoed author ID in place of a token; expired token (after 120 s); token for another operation, comment, video, account, user or generation; **same author on two comments, token from the first used on the second**; missing author; author equal to own channel; `ban` capability off for this account while on for another; service-role caller. A valid reject-and-ban sends one request with one ID, `rejected` and `banAuthor=true`. Only `204` confirms. A lost response is `indeterminate` for both effects. **A subsequent `404`, or the row disappearing, changes neither the receipt nor the copy.** No response ever contains a "banned" status. |
| **Deno: refusal audit** | Every refusal class writes one redacted row; identified-user refusals (invalid JSON, schema failure, service-role on a Stage 4 action) carry `user_id`; unauthenticated refusals carry none and stop at 30 rows per minute with one suppression counter row; no row contains text, tokens, cursors, handles or unverified identifiers; a failed insert leaves the response unchanged. |
| **Deno: compatibility** | The step 1 suite replayed with every capability off and on: Partner, n8n, MCP, the service-role allow-list, legacy inbox actions including the legacy `401` resend, AI agent and workflow delivery, polling, and the first-comment follow-up with a complete and an **incomplete `2xx`** giving the same result as on the baseline. The connector registry `tools` and `mutating` arrays are byte-identical. Re-reading the inbox dispatches no automation event and enqueues nothing. |
| **Vitest and Testing Library** | Capability-driven controls for each of `read`, `held`, `write`, `ban`; server refusal despite a forged `is_own`; de-duplication; stale-account responses dropped; "comments disabled" versus "reconnect needed" versus "no comments yet"; operation identity written to storage before the request and restored on mount; the two-step ban flow with cancel at each step, token discarded on cancel and on any change of account, video, comment or selection; ban copy never asserting a ban; the post-reconnect `not_found` copy; other platforms and Composio YouTube unchanged. |
| **Playwright, English and Arabic — real local handler** | A local loopback server composes the **real Stage 4 handler** with the real SQL functions on the disposable database and a **fake provider that counts requests**, following `e2e/fixtures/instagramReleaseServer.ts`. The Stage 3 intercepted fixture is **not** sufficient here, because it fabricates the function response and so cannot show the interface reaching the receipt. With **two tabs or two browser contexts**: select an empty upload, post, reload, edit; foreign edit refused; three reply pages with one retry; hold then publish; reject with confirmation; reject with ban through both dialogs, and cancel at each; same submit from both tabs → one provider write; response dropped after settlement, then reload → status shows the comment and the provider count is still one; indeterminate create after reload shows no resend; an old request arriving late after an account switch shows nothing of the previous account; every capability off shows the baseline inbox. Assert that no flow replays a write or enqueues automation. Fail on any unexpected external request. |
| **Reviewed documents** | `docs-guard` on this plan, the specification, and every runbook or API doc the implementation touches. |

### Denied effects — each must be shown impossible, not merely untested

1. A second public comment or reply from one deliberate submit, by any path: double click, second tab, reload, lost acknowledgement, token refresh, `401`, timeout, restart, rollback, reconnect, delete-and-recreate, digest key rotation.
2. A send for an account that is not owned, not active, not stored-native, not admitted for that capability, or whose channel or generation differs from the values verified.
3. A receipt, or any field of one, returned across owners, accounts, or a disconnect or reconnect.
4. `banAuthor` on any request not backed by a server-issued, unexpired, single-operation confirmation on a Reject; any ban reachable **through Stage 4 code** by the AI agent, a workflow, Partner, n8n, MCP or a service-role caller.
5. A reject or a ban reported as observed; an author reported as banned; an undo offered; any conclusion drawn from a `404` or a vanished row.
6. A handle issued for a row whose video, resource-channel or parent chain is inconsistent; an edit or moderation addressed by a thread ID; author channel used as ownership.
7. Held status inferred from anything but the visible row's own status.
8. A stored grant, `needs_reauth` or account health changed by Stage 4 code.
9. Any provider call, read or write, for an account whose policy does not admit that capability.
10. Comment text, tokens, cursors, handles, confirmation tokens, digest keys or unverified identifiers in `system_logs`, in either new table, or in console output; an unbounded stream of anonymous audit rows.
11. Any change in the responses of Partner, n8n, MCP, the legacy inbox actions, the first-comment follow-up, or the agent's tool list.

## 4. Existing CI facts this plan must respect

| Fact at the baseline | Consequence |
|---|---|
| `comment-manager` has **no** Deno CI step. `_shared/youtubeComments.test.ts` runs in the enumerated YouTube list; `youtube-resources` and `youtube-oauth` have their own steps. | Add a named "Typecheck and test comment-manager" step and add the new shared test files to the list. Confirm in the job log on the final head that each new file ran. |
| SQL suites run only if listed in `SUITES` in `scripts/db-harness.sh`, on baseline plus every migration, in a disposable `supabase/postgres` container. | Register the new suite; record its run on the final head. |
| **Playwright is not a CI job** (stated in the workflow header). | The English and Arabic journeys are **local evidence**, recorded in the PR with the exact command, head SHA and result. Making Playwright a job is a separate CI PR under the CI critical-path rule. |
| Vitest runs in two shards behind a required aggregate; lint and i18n are compared with the immutable base. | New copy keys must not regress the comparison. |
| Live suites (`*.live.test.ts`) never run in CI. | No Stage 4 test calls a real provider. |

This delivery only adds steps and one suite to existing jobs, so the CI critical-path measurement rule is not triggered.

## 5. Release sequence

There is **no staging stack**; the environment is production. Schema goes before code: the migration is applied by hand, while merged Edge code is deployed by the `Edge Functions Sync (POSTORA)` schedule, which runs every two minutes, and the frontend deploys on merge (`docs/runbooks/deploy-edge-function.md`).

| # | Step | Owner | Gate |
|---|---|---|---|
| 1 | Implementation, guards, whole-PR review, CI and bots green on the exact head. | Implementer, manager | — |
| 2 | **Approval card after CI is green on that head**, showing the migration file hash and object list. Applying the migration and merging are asked together and answered separately. | **Waleed** | Required |
| 3 | Production database snapshot; keep the receipt. | Waleed, or the manager under that approval | Before any DDL |
| 4 | Apply the migration as `supabase_admin`. Verify column, trigger, both tables, RLS with no policies, grants, function owners and `search_path`, digest key version 1 present, rollout key absent. Run the no-provider compatibility probes on a synthetic row. | Same | **Before merge** |
| 5 | Merge. Verify the synced Edge files by SHA-256 against `git show <merge>:<path>`. Record this merge SHA as the **status-capable baseline** (§6). | Manager | Rollout key absent → Stage 4 is dark |
| 6 | Verify in production with everything off: legacy inbox, Partner, n8n and MCP unchanged; `youtube_stage4_capabilities` reports all four unavailable; no receipt rows. | Manager | — |
| 7 | Enablement, **one capability for one named account per approval**, in this order: `read` → rehearsal R-held with `held` (read-only, zero writes) → `write` with a live write on a named private video → `ban`, only after the F1 follow-up has merged. | **Waleed** | Never implied by a merge or by an earlier approval |
| 8 | Plan summary after the merge in the AGENTS.md format, and a `mem0` record. | Manager | — |

## 6. Rollback

- **First action: set the capability to `false`, or remove the rollout key.** New reads, claims and marks stop at the next request, in already-running instances too. One request that already passed `mark_dispatched` is in flight and completes; its receipt records the outcome (spec §9.1).
- Triggers: any duplicate send; any tenant or binding mismatch; any success shown without evidence; provider errors spilling onto other videos or accounts; quota pressure; any change in a public or legacy response.
- **Rollback by policy is the default and is sufficient for every trigger above.** It keeps `youtube_operation_status` available, so owners can still read the result of operations under their current binding.
- **A code rollback must land on a head that still serves `youtube_operation_status`.** The floor is the status-capable baseline recorded at release step 5; a fix is rolled forward from it. **Do not revert to the Stage 3 head blindly:** the receipts would remain in SQL but nothing could read them, and an owner with an indeterminate comment would be left with no status. If reverting below the floor is ever judged necessary, it needs Waleed's explicit approval after a count of unresolved rows (`claimed`, `dispatched`, `indeterminate`) under live bindings has been shown to him.
- Keep the additive schema and every receipt. **Never** delete or reset an unresolved receipt, replay an uncertain create or reply, or issue a compensating provider write.
- The column and trigger on `social_accounts` stay; removing them is a second migration with its own approval.
- The existing tile flag and the polling job are independent of a Stage 4 rollback.

## 7. Design verification performed

- Checkout: worktree `T3-CODE/dbb384fe`; base `21447f2d` (= `origin/main`); this revision is committed on top of docs head `28694147`.
- Read at the baseline for this revision, in addition to the first pass: `supabase/tests/baseline_schema.sql` (table grants), the original `social_accounts` update policy, `20261120130000_youtube_refresh_lease_fixes.sql` (refresh function and credential-change trigger), `_shared/youtubeGrantedScopes.ts`, `ai-agent-reply/composioExecution.ts`, `process-post/youtubeUploadFollowUps.ts`, `youtube-oauth/index.ts`, `e2e/fixtures/instagramReleaseServer.ts`, `docs/runbooks/deploy-edge-function.md`. The Astra debate report was read in full from its thread.
- Google reference pages in spec §3 were fetched on 2026-11-22. The optional `videoId` on the comment resource in the discovery document is the debate's finding and was not re-fetched; the design does not depend on it either way.
- Baseline Deno suites `_shared/youtubeComments.test.ts` and `comment-manager/youtubeCommentsView.test.ts`: **23 passed, 0 failed** (first pass). They exercise baseline behaviour only; every Stage 4 assertion above is an acceptance criterion, not something already shown.
- Not done, by instruction: code, migration, live provider call, production access, push, PR, deployment, flag change, new debate. `mem0` was not reachable from the design session.
- Migration line numbers in spec §5 are quoted from the first debate receipt. The held-reply answer and the production configuration remain unverified until their own approved steps.

## 8. Contract summary for the implementer

Native-only private actions on `comment-manager` add paged uploads, Published and Held lists, fenced create and reply, own-comment edit, and hold/publish/reject with an optional ban that needs a server-issued second confirmation. One migration adds a trigger-maintained `binding_generation` on `social_accounts` — preserved only by the two trusted refresh functions — plus a service-only receipt table and a digest-key table. Claim and mark validate the verified owner, account, channel and generation transactionally; a committed mark is the final authorisation; exactly one HTTP write follows. Unresolved and recently confirmed creates and replies are fenced across keys, reloads, rebinding and key rotation. Uncertain outcomes are never retried or guessed; rejects and bans are reported as accepted requests on `204` only. Rollout is a private, default-absent policy per account and capability, evaluated in SQL at every read and effect boundary, with receipt status always readable under the current binding. Everything public, automated and legacy is unchanged.

## 9. Disposition of the Astra 6.2 debate (docs head `28694147`)

| Item | Resolution | Where |
|---|---|---|
| **Blocker 1** — generation authority | Trigger separates identity, credential and other columns; credential changes keep the generation only inside the two `SECURITY DEFINER` refresh functions, detected structurally and pinned by a catalog allow-list test; a browser or direct service-role credential change advances it. Native save now resets provider and connection explicitly. Old evidence unreachable after any rebind or re-creation. | Spec §6.1–6.3, §7.5; plan step 2 |
| **Blocker 2** — verify-to-send gap | Claim and mark take expected owner, account, channel and generation and validate them under a row lock in one transaction. A committed mark is defined as the final authorisation boundary. The credential is prepared before the claim. New writes make exactly one HTTP attempt with no `401` resend; the legacy path is unchanged. | Spec §7.4, §8.1, §9.1; plan steps 2–4 |
| **Blocker 3** — fence permanence and settlement | Browser stores operation identity before the first network call and restores it on reload. Fences are keyed by owner and channel with a canonical parent; a recent-confirmation fence covers a lost acknowledgement after commit. Digest keys live in SQL, versioned, never deleted while referenced. Numeric limits: 120 s, 90 s, 10 min, 30 days, 20 rows. Only never-dispatched claims are closed or pruned. Late resolution needs the attempt token and definitive evidence; `5xx` is always indeterminate. | Spec §7.2, §7.3, §7.5, §9.1, §9.2 |
| **Blocker 4** — resource binding and grant effects | Official fields are checked whenever Google returns them; resource channel is enforced separately from author channel; the video and parent chain is validated before a handle is sealed. Endpoint scopes are listed. Stage 4 performs no automatic grant or health mutation. Held status comes from the visible row only. | Spec §8.1, §8.2, §8.4, §11 |
| **Blocker 5** — rollout matches approvals | Policy is per account and per capability (`read`, `held`, `write`, `ban`) with prerequisites, evaluated at every read, effect and reconciliation boundary. Receipt status stays readable under the current binding with everything off. | Spec §13, §9.3; plan §5 step 7 |
| Ban confirmation | Server-issued, 120-second, bound to user, account, generation, video, comment, author and operation; discarded on cancel or any change. | Spec §10.2 |
| `204` only; nothing from `404` | Adopted. | Spec §9.2, §9.3, §10.3 |
| F1 | Separately tracked defensive allow-listing at the Composio execution boundary; prerequisite for enabling `ban`; no exploit reproduction. | Spec §15; plan §5 step 7 |
| Compatibility, including F6 | Legacy, Partner, n8n, MCP and the follow-up's success rule pinned with capabilities off and on; only the request builder is shared. | Spec §4, §15; plan steps 1, 3; §3 |
| Concurrency and browser proof | Two real SQL sessions with barriers; Playwright against the real local handler with a counting fake provider, two tabs, lost acknowledgement. | Plan step 2, §3 |
| Refusal audit | Redacted row for every refusal; unauthenticated ones rate-bounded with a suppression counter. No exception requested. | Spec §12 |
| Rollback | By policy first; code rollback never below a head that serves operation status without explicit approval. | Plan §6 |
