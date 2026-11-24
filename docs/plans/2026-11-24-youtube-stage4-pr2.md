# YouTube Stage 4, follow-up PR 2: implementation plan (Heavy)

24 November 2026 · **Heavy** · one PR, one migration, one rollback plan. Tracking issue: [#470](https://github.com/lolotam/POSTORA/issues/470). Contracts and the receipt model are in the [Stage 4 specification](../specs/2026-11-22-youtube-stage4-comments.md) and the [Stage 4 plan](2026-11-22-youtube-stage4-comments.md); this plan does not restate them.

## 1. Tier, base and what this plan does not authorise

- **Tier: Heavy**, one PR, by Waleed's decision of 2026-11-24. The PR carries a migration, so it merges only after Waleed's card approval, once every other gate has passed (CLAUDE.md, "Delivery tiers", rule 4).
- **Base:** `origin/main` at `93acd4be` (the merge of PR #477, follow-up PR 1). Every `file:line` below was read at that commit. The reviewed head of PR #477 was `db44bcdf`, and `93acd4be` is its merge, so a finding marked "not reproducible" could only mean the finding was wrong; none was.
- **This is a plan.** It authorises no code, no migration, no production access, no push, no PR and no rollout-key change. The next step is a one-round debate by a different model.
- **Required reading for the implementer brief:** `ARCHITECTURE.md` §4 (dependency direction), §10 (hooks), §12 to §17 (edge functions), §23 (database and migrations), §24 (service role), §31 (TypeScript), §33 (testing), §35 (no cosmetic refactors during bug fixes), plus CLAUDE.md "Delivery tiers" and this plan.

## 2. Scope

1. **The second Stage 4 migration:** items 14, 15, 16 and 17 of the owner's decision list in #470 (comment "Owner decisions on the open items"). In the issue's own numbering these are item 4, "key version re-creation", "a rebind racing a winning settlement", and item 8.
2. **The review findings recorded for PR 2:** the Codex BLOCK comment on `db44bcdf` (5), the bot review of #477 (3 Codex repeats, 5 MergePilot) and CodeRabbit's review of #477 (3). After deduplication there are **12 distinct findings** (the brief estimated about 13). All 12 reproduce on `main`.

Out of scope, by the owner's list: stale-digest recompute [19], multi-hop cursor cycles, confirmed ids on `recently_posted`, the neutral refresh re-read, the fixture secret and signal handlers, the `handleStage4` split, the other clean-up items, and the account-order task. None of them is touched, and §35 forbids folding them in.

## 3. Assumptions

The debater should attack these first.

- **A1. "Items 14 to 17" means the owner's list**, not the issue's items 14 to 17. The issue's own 14 to 17 (comment list refresh, blocked submit, edit status after reconnect, Hold through a stale handle) were closed in PR #471 and PR #477. Checked: `handler.ts:812-820` already refuses `heldForReview` while `STAGE4_HOLD_FROM_PUBLISHED` is false.
- **A2. The claim keeps its 12-argument signature** and every SQL function is changed with `CREATE OR REPLACE` only. Reason: the migration is applied to production before the merge, so the edge code of `93acd4be` runs on the new SQL for a while, and after a SQL-only rollback the new edge code runs on the old SQL. `CREATE OR REPLACE` with an unchanged signature also keeps ownership and grants.
- **A3. No handler change in this PR depends on the new migration, and no migration change needs a handler change.** The handler already sends `p_intent_digests` at all four claim sites (`handler.ts:1248`, `:1371`, `:1485`, `:1665`). The two halves can be rolled back independently.
- **A4. Key versions stay deletable, and become monotonic.** A version number, once issued, is never issued again, and a new version must be above every version ever issued. The alternative (forbid `DELETE` on the key table) is simpler but makes every key permanent; the owner's wording for item 14 ("in place of the delete guard") implies deletion stays. This is a technical choice for the debate, not an owner question.
- **A5. `digest_key_version` cannot carry a foreign key**, because edit and moderate receipts store `0` there (`migration:1455`). The foreign key goes on `intent_key_version` only, and a CHECK ties the two columns so the foreign key covers both.
- **A6. The status read takes `FOR SHARE` on the account row, account first and receipt second**, the order the claim and the mark already use. This makes a rebind wait for an in-flight status read. The alternative (no lock; re-read the account after the winning receipt is read back and apply the binding predicate again) narrows the window without closing it. **This is the one SQL change reachable while Stage 4 is dark:** the status read is not behind the rollout, and the recovery banner calls it for any stored operation. The lock is therefore taken only after a plain read has found the receipt, so a call for an unknown operation locks nothing, and with no receipts in production (A8) no call takes it before go-live.
- **A7. Reply drafts are kept in memory only.** The spec says comment text is never stored in the browser, so a reload still loses them, as today.
- **A8. Production has no Stage 4 receipts** (the rollout key is absent, so no claim can pass the rollout check). The migration verifies this instead of trusting it: it refuses to add the constraints if a row would violate them.
- **A9. The window between a capability answer and a provider read cannot be zero.** SQL and an HTTP call share no transaction. "At the send boundary" below means: the capability and binding answers are the last awaited work before the provider request starts, they are asked again after it returns, and the observation is discarded if either changed.
- **A10. Authenticated audit inserts stay awaited and unbounded.** Finding B1 concerns the anonymous path. Bounding the authenticated insert would let it outlive the request, which the existing design forbids (`handler.ts:154-156`).
- **A11. The frontend and the edge functions deploy at different moments after a merge.** Every wire change below is analysed in both orders.

## 4. Findings

Verdicts are against `93acd4be`. "Dark" answers: can this be reached while the rollout key is absent?

### 4.1 Review findings (12 distinct)

| Id | Sources | `file:line` | Verdict | Dark | Fix | Task |
|---|---|---|---|---|---|---|
| **B1** | Codex BLOCK 1 | `stage4/handler.ts:126-144`, `:178-200`; `audit.ts:71-123`; `comment-manager/index.ts:205` | **Confirmed**, three sub-claims. (a) `finally` at `:138-141` frees `anonProbeInFlight` when the timeout wins the race, while the RPC may still be running. (b) The counter insert at `:187` and the admitted anonymous insert at `audit.ts:103` have no local bound. (c) The cool-down compares `deps.now()`, which is `Date.now()` (`index.ts:205`). | **Yes, live** | Free the slot only when the call settles; bound the inserts with the same slot rule; add a monotonic clock dependency for the cool-down. | T1 |
| **B2** | Codex BLOCK 2 | `stage4/handler.ts:1796-1803` | **Confirmed.** The capability is asked at `:1796`, a binding read is awaited at `:1799`, then the provider read starts at `:1802`. After the read only the binding is checked (`:1803`). | No (needs an edit receipt) | Ask capability and binding as the last step before the read and again after it; on withdrawal return the receipt with `observation: "unavailable"` and no observed text. | T4 |
| **B3** | Codex BLOCK 3; Codex on #477 (`useYouTubeStage4.ts:637`) | `useYouTubeStage4.ts:635-647`; `YouTubeCommentsScreen.tsx:436`, `:697-699`, `:749` | **Confirmed.** `reloadFromStart` resets the chain to page one, the page-two row unmounts, and the draft is `useState` inside `Composer` (`:749`); the open/closed state is `useState` inside `CommentCard` (`:436`). | No | An in-memory draft store outside the row's lifetime, keyed by account, binding generation and comment id. | T6 |
| **B4** | Codex BLOCK 4; Codex on #477 (`YouTubeCommentsScreen.tsx:684`) | `YouTubeCommentsScreen.tsx:683`; `useYouTubeStage4.ts:611`, `:635-638`; `stage4/handler.ts:1100-1103` | **Confirmed.** The button calls `reloadFromStart`, which sends the same `parentHandle`; the server verifies that handle before it looks at any cursor. | No | The button reloads the thread list first; the reply chain restarts when the list lands with new handles. | T6 |
| **B5** | Codex BLOCK 5; Codex on #477 (`useYouTubeStage4Admission.ts:54`) | `supabaseYouTubeCommentsGateway.ts:40`, `:42`, `:59-61`; `useYouTubeStage4Admission.ts:54`; `stage4/handler.ts:894-902`; `CommentManagerPanelAdmission.test.tsx:73` | **Confirmed.** A transport failure with no body, an empty answer and a server `503 upstream` all become `YouTubeCommentsError("upstream")`, and admission shows the retry card for all of them. | **Yes** (first load fails on the network) | A distinct reason, `settings_unavailable`, for a confirmed settings failure; the card only for that reason. | T2 |
| **M1** | MergePilot 1 | `useYouTubeStage4.ts:428-431`; `recoverOperation.ts:27-29`, `:64-67`; `YouTubeCommentsScreen.tsx:924`, `:933-941` | **Confirmed**, all three sub-claims. With storage unavailable the fallback invents `action: "create_thread", createdAt: 0`: an edit's draft is not sent, a pre-claim `not_found` reads as settled, and `OutcomeLine` then shows the reconnect text with no Check status button. | No | Keep the live submission's identity in memory; fall back to storage; never invent an action. | T5 |
| **M2** | MergePilot 2 | `useYouTubeStage4.ts:433-436`; `YouTubeCommentsScreen.tsx:777-797` | **Confirmed.** A terminal missing receipt becomes `kind: "error"`, which `show` never acknowledges, so the identity stays in storage and resurfaces on the next mount. | No | Carry the terminal result to the composer and acknowledge it when shown; a pre-claim miss is never acknowledged. | T5 |
| **M3** | MergePilot 3; Codex on #477; CodeRabbit 2 (`YouTubeCommentsScreen.tsx:642`) | `YouTubeCommentsScreen.tsx:640-643` | **Confirmed.** Inline rows are merged last, unconditionally. | No | The row from the later successful read wins. | T6 |
| **M4** | MergePilot 4 | `stage4/handler.ts:1783-1785`, `:1797` | **Confirmed.** A settings read failure during the optional comparison returns `503` although the receipt was already read at `:1730`. (The comment's evidence line `rollout.ts:61` is stale: `admitsCapability` now throws. The handler behaviour is as described.) | No | On a settings error skip the provider read and return the receipt with `observation: "unavailable"`, after a binding re-check. Keep `503` for a failed receipt or binding read. | T4 |
| **M5** | MergePilot 5 | `stage4/handler.ts:1775`, `:1784`, `:1793`; `:264-291` | **Confirmed as a code path.** `prepareToken(first.account)` uses the snapshot read at `:1775`, before the capability call at `:1784`. With an expired token in that snapshot, `nativeAccessToken` can start a refresh with a superseded refresh token. Whether the lease path can then store its result was not proven here; the fix does not depend on the answer. | No | Re-read the binding after the capability check and prepare the credential from that row. | T4 |
| **C1** | CodeRabbit 1 | `useStage4Recovery.ts:34-35`, `:73-80`, `:89`; same pattern at `useYouTubeStage4.ts:260-261`, `:517-523`, `:535` | **Confirmed, in both hooks.** The ref is written during render only, so a re-check that resolves between `clear()` and the next render still finds the dismissed entry and clears its identity. | Partly (the recovery banner is not behind the rollout, but needs a stored operation) | Write the filtered list to the ref in the same call that queues the state update, in both hooks. | T5 |
| **C3** | CodeRabbit 3 | `CommentManagerPanel.tsx:86`, `:147-157` | **Confirmed.** The button is rendered for `loading` and `unavailable`, and `refetch()` runs a query whose `enabled` is false (TanStack Query v5). #470's minor list has the same defect for `loading` (`CommentManagerPanel.tsx:84`). | **Yes** | `loading`: disabled. `unavailable`: the button asks admission again. `refetch()` only when the baseline read is enabled. | T2 |

Duplicates folded in: Codex's three comments on #477 repeat B3, B4 and B5; CodeRabbit 2 and Codex's fourth comment on #477 repeat M3.

**Severity.** No finding is P0 or P1. All are P2 or lower. B1 is the only server finding reachable in production today; its effect is bounded (during a hung database call, one worker can put more than one limiter call in flight and can hold an anonymous request without a local bound).

### 4.2 Migration items (owner's 14 to 17)

| Id | Owner item | `file:line` | Verdict | Fix | Task |
|---|---|---|---|---|---|
| **K1** | 14: foreign key on `intent_key_version` | `migration:493-551`, `:591`, `:1285-1290` | **Confirmed.** The delete guard is an `EXISTS` inside a trigger. A rotation session in `REPEATABLE READ` that took its snapshot before a claim committed does not see the receipt and deletes the key. | Foreign key `ON DELETE RESTRICT`, plus a CHECK tying `digest_key_version` to it. | T3 |
| **K2** | 15: a deleted version number can be reused | `migration:562-565` (no `INSERT` guard) | **Confirmed.** After deleting an unreferenced version, the same number can be inserted with new bytes. | A watermark of the highest version ever issued; an insert at or below it is refused. | T3 |
| **K3** | 16: a rebind racing a winning settlement | `migration:1782-1816`, `:1836-1838` | **Confirmed.** The binding is validated from unlocked reads; when the conversion `UPDATE` loses to a settlement, the winner is read back by receipt id alone. A rebind that commits in between is not seen. | Lock the account row `FOR SHARE` first. | T3 |
| **K4** | 17: `claim` must require the digest map | `migration:1137`, `:1306-1308`, `:1433-1434` | **Confirmed.** `p_intent_digests` defaults to `NULL` and two branches fall back to the single digest. | A missing or non-object map is `invalid_request`; both fallbacks are removed. | T3 |

## 5. Tasks

Order: what is reachable while Stage 4 is dark comes first (T1, T2), then the migration, then the dark-only fixes. Each task is test-first: the listed tests are written, seen failing for the stated reason, and only then is the fix made.

### T0. Baseline and facts

No production code.

- Run every gate of §6 on `93acd4be` and record the results. A gate that is red on the base is reported before any work starts.
- Read the pinned `supabase-js` (2.49.4, imported in `stage4/rateLimit.ts`) and record whether the `rpc` builder and the `from(...).insert` builder accept an abort signal. T1 uses the answer.
- Confirm from the #470 release comment which database role and command applied `20261122130000`, and that the CI image and production run the same Postgres major.

Acceptance: a short "baseline and facts" section in the PR body.

### T1. The anonymous refusal gate (B1), live

Files: `supabase/functions/comment-manager/stage4/handler.ts`, `stage4/audit.ts`, `stage4/rateLimit.ts`, `supabase/functions/comment-manager/index.ts`, `stage4/handler.test.ts`, and any other place that builds a `Stage4Deps` (a search at `93acd4be` finds `index.ts:205` and the test files only; the implementer repeats the search).

Design:

- **The slot is freed when the call settles.** `anonProbeInFlight` is cleared in the probe promise's own `finally`, not in the `finally` of the race. A timeout still answers "refused" after `ANON_PROBE_TIMEOUT_MS` and still closes the gate, but the slot stays taken until the underlying call resolves or rejects. If T0 found abort support, the timeout also aborts the call; the slot rule does not depend on it. A call that never settles keeps this worker from probing again: that is the fail-closed outcome, and each suppressed refusal still emits its console event.
- **The counter probe, the counter insert and the admitted anonymous audit insert get the same treatment:** one slot each, a local bound of `ANON_PROBE_TIMEOUT_MS` on what the request waits for, and the slot freed on settle.
- **A monotonic clock.** `Stage4Deps` gains `monotonicNow: () => number`, wired to `performance.now()` in `index.ts`. `anonBucketClosedUntil` and `anonCounterNextAt` use it. `deps.now` is unchanged: handle, cursor and ban-confirmation expiry need wall-clock time. `resetAnonRefusalGate` resets the new slots.

Tests first (Deno, through the real route where the existing tests do):

1. A probe that never resolves: the first refusal answers within the bound; after the cool-down has passed on the monotonic clock, a second refusal makes **no** limiter call. When the hung promise is then resolved, the next refusal probes again.
2. The same for the counter probe, the counter insert and the admitted anonymous insert: the request returns within the bound, and no second insert starts while the first is unsettled.
3. Wall clock stepping backwards by an hour with the monotonic clock advancing: the gate reopens on time. Wall clock stepping forwards: the gate does not reopen early.
4. A regression guard for expiry: a handle that expires by wall clock is still refused.

Acceptance: tests 1 to 3 fail on `93acd4be` and pass after; the existing gate tests pass unchanged; the answer and status of every refusal are unchanged.

### T2. Admission provenance and the baseline Refresh button (B5, C3), live

Files: `stage4/handler.ts` (the `youtube_stage4_capabilities` branch only), `stage4/route.test.ts` or `handler.test.ts`, `src/features/youtube-comments/infrastructure/supabaseYouTubeCommentsGateway.ts`, `application/useYouTubeStage4Admission.ts`, `tests/admission.test.tsx`, `tests/gatewayCapabilities.test.ts`, `tests/gatewayReason.test.ts`, `src/components/comments/CommentManagerPanel.tsx`, `src/components/comments/__tests__/CommentManagerPanelAdmission.test.tsx`.

Design:

- **Server.** When `readCapabilities` throws `SettingsReadError` in the `youtube_stage4_capabilities` action, the refusal is `503 settings_unavailable` (the reason already exists in `contractTypes.ts:66`). Every other action keeps `503 upstream`.
- **Gateway.** `capabilities()` throws `YouTubeCommentsError("settings_unavailable")` for that refusal and for the older payload form (`:59-61`, today mapped to `upstream`). A transport failure with no body and an empty answer stay `upstream`.
- **Admission.** `unavailable` only when there is no data and the error code is `settings_unavailable`. Every other failure with no data is `legacy`, as before PR #477.
- **Refresh button.** For YouTube: disabled while admission is `loading`; while `unavailable` it calls `retryAdmission`; otherwise `refetch()`. `refetch()` is never called while the baseline read is disabled.

Deploy skew (A11): an old edge function answers `503 upstream`, which the new frontend reads as `legacy`; the new edge function answers `settings_unavailable`, which the old frontend also reads as `legacy` (its test is `code === "upstream"`). Both orders show the baseline inbox, never a wrong admission.

Known consequence, accepted: after go-live, a transport failure on the very first admission read mounts the baseline inbox for a channel that would have been admitted, and its legacy read runs (`CommentManagerPanel.tsx:81-85` explains why that read is otherwise held back). This is the behaviour before PR #477 and what the reviewers asked to restore; a later successful admission read replaces the inbox with the Stage 4 screen.

Tests first:

1. Vitest, with the **production gateway class** and a mocked `supabase.functions.invoke`: a transport error with no response body gives `legacy` and the baseline inbox loads; an HTTP error whose body carries `settings_unavailable` gives the retry card; an HTTP error whose body carries `upstream` gives `legacy`. This replaces the plain-`Error` case at `CommentManagerPanelAdmission.test.tsx:73`.
2. Vitest: Refresh during `unavailable` asks capabilities again and never calls the baseline comments fetcher; during `loading` the button is disabled; for an admitted-refused (`legacy`) channel it refetches the baseline list as today.
3. Deno: a failing capability RPC on the capabilities action answers `503 settings_unavailable`; on a list action it still answers `503 upstream`.

Acceptance: with the rollout key absent, a first-load network failure shows the baseline inbox; the admitted screen's own settings card (`YouTubeCommentsScreen.tsx:121-137`) behaves as before.

### T3. The second migration and its SQL proof (K1 to K4)

Files: new `supabase/migrations/20261124120000_youtube_stage4_key_integrity.sql`; new `supabase/tests/youtube_stage4_key_integrity.sql`; `supabase/tests/youtube_comment_operations.sql`; `scripts/db-harness.sh` (the `SUITES` list); new `docs/runbooks/youtube-stage4-pr2-migration.md` and `docs/runbooks/sql/20261124120000_youtube_stage4_key_integrity_rollback.sql`. The rollback script must **not** live under `supabase/migrations/`: the harness applies every file there.

`20261122130000` is not edited (§23). The new file is one transaction, sets a local `lock_timeout`, and can be applied twice without error.

No generated-types change is needed (§23): the Stage 4 tables are private and absent from `src/integrations/supabase/types.ts`, and the new table follows them.

Not touched, and asserted unchanged by the self-check: the role `youtube_stage4_refresh`, the three token store functions and their owners, `app_settings`, the rollout functions, `youtube_comment_op_mark_dispatched`, `youtube_comment_op_settle`. No row is inserted for the rollout key.

**K1, the foreign key.**

- A pre-check that raises with a clear message if any receipt has an `intent_key_version` without a key row, or a `digest_key_version` that breaks the CHECK below (A8).
- `CHECK` `youtube_comment_operations_key_versions_check`: for `create_thread` and `reply`, `digest_key_version = intent_key_version`; for `edit` and `moderate`, `digest_key_version = 0`. This is what the claim already writes (`migration:1453-1455`).
- `FOREIGN KEY (intent_key_version) REFERENCES youtube_comment_digest_keys(version) ON UPDATE RESTRICT ON DELETE RESTRICT`, and an index on `intent_key_version` (§23). Each `ADD CONSTRAINT` sits in a `DO` block that checks `pg_constraint` first.
- The trigger's `EXISTS` check stays as an early, readable error; its comment says the foreign key is the authority.

**K2, no version reuse.**

- A private one-row table `youtube_comment_digest_key_watermark (singleton boolean primary key default true check (singleton), last_version integer not null)`. RLS on, no policies, `REVOKE ALL` from `PUBLIC`, `anon`, `authenticated` and `service_role`, the same shape as the two Stage 4 tables (`migration:478-480`). It is seeded with the greatest of the key versions and the receipts' two version columns, with `ON CONFLICT ... DO UPDATE SET last_version = GREATEST(...)`.
- `youtube_stage4_guard_digest_keys()` gains an `INSERT` branch, under the advisory lock it already takes: lock the watermark row, refuse `NEW.version <= last_version` with a message that names the next allowed version, then raise the watermark. The trigger is recreated as `BEFORE INSERT OR UPDATE OR DELETE`.
- Consequence to document: `INSERT ... ON CONFLICT DO NOTHING` on an existing version now raises, because a `BEFORE INSERT` trigger runs before conflict detection. The only such statement is the version 1 seed in `20261122130000`, which never runs again.

**K3, the status read.**

- `youtube_comment_op_status` first does a plain, unlocked read that only answers whether the receipt exists; absent is `not_found` with no lock taken (A6). It then reads the account row, owner-scoped, `FOR SHARE`, reads the receipt again, and applies the unchanged binding predicate, the two conversions and the read-back. Nothing from the first read is used after the lock. The account lock is held to the end of the call, so the receipt returned after a lost conversion belongs to a binding that is still current.
- Lock order across the receipt functions stays account, then receipt. `settle` takes the receipt only. No cycle exists: a rebind or an account delete waits on the account row and holds no receipt lock while it waits.

**K4, the digest map.**

- `p_intent_digests` `NULL` or not a JSON object is `invalid_request`, before the account is read. The parameter keeps its position and its `DEFAULT NULL`, so the signature is unchanged (A2).
- Existing receipt: the comparison value is `p_intent_digests ->> intent_key_version`. Missing or blank is `upstream` (temporary: nothing stored, the caller recomputes); present and different is `conflict`. Today a missing entry is `conflict`, which a browser treats as a shown refusal and uses to forget a live operation.
- New receipt: the stored digest is `p_intent_digests ->> v_active`; missing or blank is `upstream`, as today.
- `p_intent_digest` stays in the signature and decides nothing, like `p_capability` (`migration:1246-1248`). The function comment says so.

**Self-check**, a final `DO` block that raises on any miss: the foreign key exists and is validated; the CHECK exists; the trigger fires on `INSERT`; the watermark is at or above the highest version in the key table and in the receipts (not equal: after a delete it is legitimately higher, and the second apply must pass); the three replaced functions are `SECURITY DEFINER` with `search_path = public, pg_temp`; `EXECUTE` on the claim and the status is granted to `service_role` only; the new table has RLS on and no grant to a client role; the three token store functions are still owned by `youtube_stage4_refresh`.

**Tests first.** The new suite `youtube_stage4_key_integrity.sql` is registered in `SUITES` after `youtube_comment_operations.sql`. It follows that suite's conventions: its own fixture id prefix, a self-healing clean-up at the top, real second and third sessions over `dblink` with a fixed interleaving, and assertions on state read after commit. Every case that asserts new behaviour must fail when the suite is run against `20261122130000` alone, and the PR body shows that run. Cases marked *control* pass on both and prove the fix did not move existing behaviour.

1. **K1.** Session B opens `REPEATABLE READ` and takes its snapshot. Session A claims under version N and commits. B deletes version N: the delete fails, the key row remains and the receipt still resolves. *Control:* the same delete in `READ COMMITTED` is refused before and after. A direct insert of a receipt with an unknown `intent_key_version` fails. A direct insert breaking the CHECK fails, one case per action family.
2. **K2.** Delete an unreferenced version N, insert N again: refused. Insert N+1: allowed. Insert an unused number below the watermark: refused. An insert rolled back does not move the watermark. Two sessions inserting the same new version: exactly one succeeds.
3. **K3.** A receipt dispatched more than 90 seconds ago. Session A settles `confirmed` and does not commit. Session B calls status and blocks on the receipt. Session C starts a rebind: **it is blocked while B is in flight** (asserted by polling `pg_stat_activity` for `wait_event_type = 'Lock'` on C's backend pid, the technique R17 uses at `youtube_comment_operations.sql:2136-2147`). A commits, B answers `confirmed`, C completes, and a status read after C answers `not_found` with no result ids. *Control:* without a rebind the answer is `confirmed` (R18 stays green). *Control:* a status read for an operation id that has no receipt answers `not_found` and leaves no lock on the account row. An account delete in place of the rebind behaves the same.
4. **K4.** `NULL` map: `invalid_request`, no receipt row. Non-object map: the same. A map without the active version: `upstream`, no row. A retry whose map lacks the receipt's version: `upstream`, state unchanged. *Controls:* a retry with the same intent after a rotation is still `already_recorded` (R14); a different intent under the receipt's version is still `conflict`.
5. **Idempotency.** The harness run applies the migration, then applies it a second time by hand, then runs both suites.

**The existing suite.** `youtube_comment_operations.sql` has 69 claim calls and none passes `p_intent_digests`; it also deletes and re-inserts key versions 2 and 7 (`:810`, `:1832`, `:1909`, `:1967`, `:2012`, `:2055`, `:2350`). Both stop working by design. The changes allowed there are:

- one helper that builds the map (the same digest under every retained version, which is what the single-digest form expressed), passed at every call. R14, R15 and R21 test rotation and build explicit per-version maps instead;
- one helper that allocates the next version from the watermark, replacing the literals.

No assertion is deleted or weakened. Any assertion whose expected value changes (a missing-version retry that was `conflict`) is listed in the PR body with its line.

Acceptance: `scripts/db-harness.sh` green with both suites; the rollback script applied on the harness database followed by the forward migration again, both without error, with the output in the PR body; the migration's SHA-256 recorded in the PR body.

### T4. Edit-status observation (B2, M4, M5), dark

Files: `supabase/functions/comment-manager/stage4/handler.ts` (the `youtube_operation_status` branch only, `:1728-1841`), `stage4/handler.test.ts`.

Design, in order, for an edit receipt with a draft to compare:

1. Binding check (exists today). A failed read is `503`; a missing account or a changed generation is `not_found`.
2. Capability `read`. **A settings error is no longer a `503`:** it skips the provider read, re-checks the binding and returns the receipt with `observation: "unavailable"` (M4). A denial does the same, as today.
3. **Re-read the binding and prepare the credential from that fresh row** (M5), never from the first snapshot.
4. **The send boundary** (B2): binding and capability asked together as the last awaited work before `provider.readComment`. Withdrawn, changed or unreadable: no provider read; the binding rule of step 1 applies, otherwise the receipt goes out with `observation: "unavailable"`.
5. After the read: binding and capability asked again. A changed binding is `not_found`. A withdrawn or unreadable capability returns the receipt with `observation: "unavailable"` and `observed_text: null`; the text read is dropped.

The residual window is stated in A9. The extraction of this branch into a named function is allowed only as far as the fix needs it; the `handleStage4` split is a later PR.

Tests first (Deno, with a fake admin whose capability answers and account rows change at a chosen call index, and a fake fetcher that counts provider and token requests):

1. `read` withdrawn between the first capability answer and the send boundary: zero provider reads; `200` with the receipt and `observation: "unavailable"`.
2. `read` withdrawn during the provider read: the response has `observation: "unavailable"` and no `observed_text`.
3. A settings RPC error at the first capability check, and separately at the boundary: `200` with the settled receipt, `observation: "unavailable"`, zero provider reads. A failed binding read at the same points is still `503`.
4. A reconnect that lands during the first capability check: no token request is made with the old row's credential, and the answer is `not_found` with no payload.
5. The unchanged paths: no draft gives `unavailable` with no settings read; a matching and a differing text give the two observed values.

Acceptance: tests 1 to 4 fail on `93acd4be`; the existing status tests pass unchanged.

### T5. Status check and recovery in the browser (M1, M2, C1), dark

Files: `src/features/youtube-comments/application/useYouTubeStage4.ts`, `application/useStage4Recovery.ts`, `application/recoverOperation.ts`, `ui/YouTubeCommentsScreen.tsx`, `tests/YouTubeCommentsScreen.test.tsx`, `tests/recoverOperation.test.ts`, `src/components/comments/__tests__/CommentManagerPanel.test.tsx` or a new hook test for `useStage4Recovery`.

Design:

- **M1.** `useYouTubeStage4` keeps the identity of every submission it started in a ref (`Map` by operation id), written before the first network call beside `savePendingOperation`, removed on `acknowledge`. `checkStatus` looks in memory, then in storage. With neither, it reads the status with no draft and treats `not_found` as temporary. No action or timestamp is invented.
- **M2.** When recovery says "settled, no receipt", `checkStatus` returns the error outcome marked terminal. `Composer.show` acknowledges a terminal outcome that it displays and keeps the draft. A pre-claim miss stays temporary and is not acknowledged.
- **C1.** `clear()` in `useStage4Recovery` and `clearRecovered` in `useYouTubeStage4` write the filtered list to their ref in the same call that queues the state update.

Tests first (Vitest):

1. Storage that throws on every access; an edit whose response is lost; Check status: the gateway receives the draft text, and a `not_found` inside the grace window keeps the Check status button.
2. A terminal missing receipt through Check status: the reconnect text is shown, the draft is kept, and the identity is gone from storage. The same check inside the grace window leaves the identity in place.
3. A re-check in flight; the banner is dismissed; the re-check resolves **before the next render**: the identity is not cleared. One case per hook.

Acceptance: each test fails on `93acd4be` for the stated reason.

### T6. The reply list (B3, B4, M3), dark

Files: `src/features/youtube-comments/application/useYouTubeStage4.ts`, a new pure module `application/mergeReplyRows.ts`, a new `application/useStage4Drafts.ts` (or the same state inside `useYouTubeStage4`), `ui/YouTubeCommentsScreen.tsx`, `tests/YouTubeCommentsScreen.test.tsx`, a new `tests/mergeReplyRows.test.ts`, `tests/architecture.test.ts`, `src/i18n/locales/ar/automation.json` for the one new string (English is the in-code default).

Design:

- **B3, drafts.** An in-memory store owned by the application layer, keyed by account, binding generation, comment id and kind (`reply` or `edit`), holding the text and whether the editor is open. `CommentCard` and `Composer` read their initial state from it and write through it. An entry is removed on a confirmed submit, on Cancel and when the generation changes. The screen is keyed by user and account (`CommentManagerPanel.tsx:209`), so a switch drops the store. Nothing is written to `localStorage` or `sessionStorage` (A7). When the store holds a draft for a reply whose row is not loaded, the reply block says so and points at "More replies".
- **B4, parent handle.** For a stale-context error the button calls the thread list's `reload()`. The existing epoch (`useYouTubeStage4.ts:220-227`) restarts the reply chain when the list has landed, with the new handle. The old handle is not sent again.
- **M3, freshness.** `usePagedList` and `useStage4Replies` expose, per row, the `dataUpdatedAt` of the page query it came from. `mergeReplyRows(inline, paged)` is a pure function: for one comment id the row from the later read wins; on a tie the reply page wins.

Tests first (Vitest):

1. Two reply pages; a reply draft and an edit draft on rows that exist only on page two; Refresh; "More replies": both editors are open again with their text. The same after a confirmed action on another thread.
2. A static check in `architecture.test.ts` that the draft module does not touch browser storage.
3. The reply page answers `expired_handle` for the old parent handle. "Reload from the start": one thread-page request, then a reply-page request carrying the **new** handle, and no further request with the old one.
4. `mergeReplyRows`: inline newer than paged, paged newer than inline, equal times, rows present on one side only. The existing precedence test gains the reverse-order case with text, moderation status and handle taken from the newer read.

Acceptance: each test fails on `93acd4be`; no draft text reaches storage; `useYouTubeStage4.ts` gains no new render-time ref write.

### T7. Journey, documents and guards

- **Journey.** `node scripts/stage4-e2e.mjs` three times in a row, all green, output in the PR body. If the fixture server (`e2e/fixtures/youtubeStage4Server.ts`) already pages replies, add one journey case for T6 test 1; if it does not, the Vitest case is the proof and the PR body says so. No fixture rewrite in this PR.
- **Documents.** A short "PR 2 amendments" note in spec §7 (digest map required, monotonic key versions, the foreign key, the status lock order); the new runbook of T3; `ARCHITECTURE.md` is not changed. `docs-guard` runs on these.
- **Guards**, run by the implementer (Heavy): `clean-code-guard`, `test-guard`, `waleed-security-reviewer`. The manager runs `/code-review` once on the whole PR with a model other than the implementer's.

## 6. Gates

All must pass on the exact head commit.

| Gate | Command or job |
|---|---|
| SQL harness | `scripts/db-harness.sh`, both Stage 4 suites listed in `SUITES` |
| Vitest | `npm test` |
| Typecheck | `npm run typecheck` |
| Deno | `deno check` and `deno test` on `supabase/functions/comment-manager/` with `--import-map=.github/deno/process-post-import-map.json`, exactly as the CI step "Typecheck and test comment-manager" runs them |
| Lint and i18n | the CI job "Lint/i18n: no regressions" (`scripts/ci/lint-i18n-regression.mjs`), which also covers `supabase/` and `e2e/`: no new `any`, no suppression comment, no untranslated new string |
| Journey | `node scripts/stage4-e2e.mjs`, three consecutive green runs |
| Dark | `STAGE4_HOLD_FROM_PUBLISHED` is still `false`; no code path or migration statement writes `youtube_comments_stage4_rollout` (a repository search, quoted in the PR body) |

## 7. Release

A merge to `main` syncs the edge functions to production within about two minutes, so the database goes first. The order is fixed:

1. **Every gate of §6 green on the final head**, `/code-review` done, review bots done or skipped under the Medium/Heavy rule. The migration file's SHA-256 is recorded. A later change to the file voids the approval of step 4.
2. **Pre-flight, read-only, on production.** Expected answers in brackets:
   - receipts in `youtube_comment_operations` (0);
   - key versions and `retired_at` (version 1, not retired);
   - receipts that would break the new constraints (0);
   - owners of `store_youtube_refreshed_token`, `store_youtube_refreshed_token_with_lease` and `store_youtube_refreshed_token_with_lease_neutral` (`youtube_stage4_refresh`);
   - `app_settings` row with key `youtube_comments_stage4_rollout` (absent);
   - constraint, table and index names the migration creates (none exist);
   - Postgres major (equal to the CI image).
   Any other answer stops the release.
3. **Database snapshot** on the Contabo host, the same way as `postora-pre-stage4-20261124T021823Z.dump`: path, byte size and SHA-256 recorded in #470.
4. **Owner approval by card.** The card names the migration file, its SHA-256, the snapshot receipt and the pre-flight answers.
5. **Apply the migration to production**, read from the PR head with `git show <sha>:<path>`, with the role and command recorded for `20261122130000`, `ON_ERROR_STOP` on. It is one transaction; the self-check inside it aborts the whole apply on any miss.
6. **Post-apply verification, read-only:** the foreign key is validated; the CHECK exists; the trigger fires on `INSERT`; the watermark is 1 (production has only version 1); `EXECUTE` on the claim and the status is `service_role` only; the three store functions keep their owner; the rollout key is still absent; each of the six channels still answers `rollout_missing`; a claim called with a `NULL` map inside a transaction that is rolled back answers `invalid_request`.
7. **Merge.** Between steps 5 and 7 the edge code of `93acd4be` runs on the new SQL; A2 and A3 are why that is safe. Keep the gap short.
8. **After the merge:** the edge sync verified by SHA-256 per changed file (`docs/runbooks/deploy-edge-function.md`); the frontend deploy finished; the baseline YouTube inbox loads for a native channel; an anonymous refusal still answers `401` and writes at most its audit row.
9. **Staging.** The Heavy rule asks for a staging deploy alone right after the merge. No Postora staging environment is documented in the repository, and PR #471 was released straight to production. This plan assumes the same: the harness database and the three journey runs are the pre-production proof, and step 8 is the post-merge check. See §9.
10. **Stage 4 stays dark.** Nothing in this release writes the rollout key. Switching a channel on remains a separate owner decision.

## 8. Rollback

The three parts roll back independently (A3).

- **Edge and frontend:** revert the merge commit on `main`. The edge sync and the frontend deploy follow on their own.
- **Database:** `docs/runbooks/sql/20261124120000_youtube_stage4_key_integrity_rollback.sql`, one transaction, in this order:
  1. restore `youtube_comment_op_claim`, `youtube_comment_op_status` and `youtube_stage4_guard_digest_keys` to their bodies in `20261122130000` (`:1125-1472`, `:1762-1882`, `:493-551`), copied verbatim, with `CREATE OR REPLACE`;
  2. recreate the trigger as `BEFORE UPDATE OR DELETE`;
  3. drop the foreign key, the CHECK and the index;
  4. drop the watermark table.
  The script changes no receipt and no key. It does drop the record of deleted version numbers: a later re-apply seeds the watermark from the versions that still exist, which is only a lower bound. With one version in production and no deletion so far, nothing is lost today; the runbook says to note the watermark value before a rollback. It is rehearsed on the harness database in T3.
- **Snapshot restore** is the last resort and is not expected: the migration changes no existing row.
- **Not part of this rollback:** the ownership of the token store functions. #470 records that they were owned by `supabase_admin` before `20261122130000`; this migration does not touch them.
- **After go-live** the same script stays safe: rolling back the foreign key only returns the delete guard to its trigger form.

## 9. Open questions

None blocks implementation.

For the owner:

- **Staging.** Is there a staging environment this release should go to first? The plan assumes there is none (§7 step 9), as for PR #471. If there is one, steps 2 to 6 run there before production.
- To know, not to decide: the release needs one card approval for the production migration (§7 step 4), as the tier rule already requires.

For the debate, the choices most worth challenging: A4 (monotonic versions against forbidding deletes), A6 (a share lock on the account row inside the status read against a lock-free re-check), the `conflict` to `upstream` change for a retry whose map lacks the receipt's version (T3, K4), and the stricter action-tied CHECK (T3, K1), which fails the pre-check if any fixture or row was written outside the claim. One more, on evidence: M5's worst case (whether a refresh started from a superseded snapshot can store its result) was not proven in this plan; the implementer settles it in T4 and reports it, and the severity stands at P2 unless that answer is yes.
