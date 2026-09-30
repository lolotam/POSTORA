# TikTok Publishing Review Implementation Plan

> **For agentic workers:** Execute this plan sequentially with the executing-plans workflow. Read the linked specification and `ARCHITECTURE.md` before implementation. Each task uses checkboxes for tracking. Delegation, if subsequently authorized, must name architecture requirements and explicit file ownership.

**Goal:** Deliver a Brandora-style TikTok review workspace in POSTORA with accurate provider settings, durable publishing/scheduling, and automatic outcome tracking.

**Architecture:** A feature module composes the review UI and application ports around existing publishing, media, scheduler, and status infrastructure. Review drafts and publishing attempts have separate lifecycles. Server-side authorization, validation, idempotency, and reconciliation are mandatory.

**Tech Stack:** Existing React 18, TypeScript, Vite, Tailwind, shadcn/Radix, TanStack Query, Vitest, self-hosted Supabase/PostgreSQL, and Deno Edge Functions. No new state-management, scheduling, or UI framework.

**Spec:** [TikTok publishing review specification](../specs/2026-09-30-tiktok-publishing-review-design.md)

**Status:** Planning complete; all implementation tasks are pending. No application code, database, or deployment was changed while preparing this plan.

## Global constraints

- Route: `/tiktok-publish`; preserve `/tiktok-auth`.
- Runtime API base comes from configured Supabase environment variables; production is self-hosted.
- Keep POSTORA identity; use Brandora's observed review structure as the visual reference.
- English review copy is the baseline; all layout must remain compatible with Arabic and RTL.
- No provider upload or publication before explicit user consent.
- Consent is bound to user, account, draft revision, media, settings, and requested publish time.
- Every ownership check must be enforced server-side, including service-role paths.
- Failed reads must remain errors; they must not become empty drafts or unrestricted publishing.
- New schema must be applied before dependent functions or frontend are released.
- Do not add another scheduler or publish directly from a browser timer.
- No claimed exact Brandora parity without measured reference evidence.

## Review focus

1. A user switches account after restoring a draft: settings and consent cannot transfer silently. Test in Tasks 2 and 6.
2. A submit request times out after TikTok accepted it: retry must reconcile the same attempt. Test in Tasks 3 and 4.
3. A webhook arrives before the provider ID was persisted, or arrives twice: preserve/reconcile it and apply the outcome once. Test in Task 4.
4. DST changes or account capabilities change before a scheduled publish: display an explicit resolution or Needs attention. Test in Task 5.
5. Another session edits or submits the same draft: reject stale revisions and prevent duplicate jobs. Test in Tasks 2 and 3.

## File and responsibility map

Existing entry points to inspect and integrate:

| Path | Responsibility |
| --- | --- |
| `src/pages/TikTokPublish.tsx` | Replace page-level orchestration with feature composition; preserve route. |
| `src/components/post/TikTokVideoPreview.tsx` | Reuse playback/caption preview where compatible. |
| `src/components/post/settings/TikTokSettings.tsx` | Compare/reuse existing UI capability rules; avoid inconsistent parallel rules. |
| `src/hooks/useTikTokStatusPolling.ts` | Evaluate existing polling reuse and terminal-state behavior. |
| `supabase/functions/tiktok-demo-publish/index.ts` | Compatibility entry point; replace bypass behavior with validated durable flow. |
| `supabase/functions/process-post/index.ts` | Existing TikTok dispatch; integrate shared mapping and durable attempt identity. |
| `supabase/functions/process-scheduled-posts/index.ts` | Existing due-job scheduler; enforce reviewed revision and revalidation. |
| `supabase/functions/tiktok-webhook/index.ts` | Verify and reconcile provider events with durable attempts. |
| `supabase/functions/tiktok-oauth/index.ts` | Existing creator-info capability; inspect errors and freshness contract. |

Proposed new files (these are intended deliverables, not existing APIs):

| Path | Responsibility |
| --- | --- |
| `src/features/tiktok-publishing/domain/types.ts` | Draft/settings/creator and result contracts. |
| `src/features/tiktok-publishing/domain/reviewRules.ts` | Review eligibility, invalidation, revision rules. |
| `src/features/tiktok-publishing/domain/scheduleRules.ts` | Future-time and explicit time-zone decisions. |
| `src/features/tiktok-publishing/application/ports.ts` | Typed gateway independent of Supabase SDK. |
| `src/features/tiktok-publishing/application/useTikTokReview.ts` | Load/save/submit orchestration and cache invalidation. |
| `src/features/tiktok-publishing/infrastructure/supabaseReviewGateway.ts` | Authenticated calls and persisted-record mapping. |
| `src/features/tiktok-publishing/ui/TikTokReviewScreen.tsx` | Composition root and screen states. |
| `src/features/tiktok-publishing/ui/ReviewQueue.tsx` | Filters, selection, counts, loading/error/empty states. |
| `src/features/tiktok-publishing/ui/ReviewDetail.tsx` | Preview, editor, media controls, action row. |
| `src/features/tiktok-publishing/ui/TikTokSettingsPanel.tsx` | Account-specific settings and confirmation. |
| `src/features/tiktok-publishing/ui/PublishControls.tsx` | Schedule shortcuts, consent, destination, validation. |
| `src/features/tiktok-publishing/ui/tiktokReview.css` | Scoped measured visual tokens. |
| `supabase/functions/_shared/tiktokPostInfo.ts` | Pure provider mapping with runtime validation at its caller. |
| `supabase/functions/tiktok-review/index.ts` | Thin authenticated router for review actions. |
| `supabase/functions/tiktok-review/handler.ts` | Authorized draft lifecycle and publishing adapter. |

Proposed schema migration file: `supabase/migrations/20260930000000_tiktok_review_lifecycle.sql`. At execution, replace this planned timestamp if occupied or older than the migration sequence; record the actual filename in this plan. The exact integration schema is finalized in Task 1 before SQL is written.

## Phase 1 — Freeze evidence and integration contracts

### Task 1: Complete reference capture and trace durable publishing

**Deliverables:** `docs/investigations/tiktok-review-reference.md`, `docs/investigations/tiktok-review-integration.md`, and sanitized screenshots under `docs/qa/tiktok-review/`.

- [ ] Inspect Git/worktree state; reuse a free attached worktree or create an isolated managed worktree for implementation. Use a `codex/` branch. Preserve unrelated files.
- [ ] Read full `ARCHITECTURE.md`, current `CLAUDE.md`, and the deployment runbook. Query graphify for each publishing/scheduling relation before raw source searches.
- [ ] Revisit Brandora settings and editor through working browser interactions. Record visible states and measured styles; never publish/reject/archive user content merely to discover behavior.
- [ ] Capture desktop reference at the actual viewport size and a narrow 390px view; record exact dimensions and state alongside each image. If inaccessible, record the blocker and implement a clearly labeled POSTORA panel under the specified behavior contract.
- [ ] Verify the actual meaning of Approve. Record whether it publishes immediately or only approves. Preserve explicit publish intent in POSTORA labels.
- [ ] Trace the current post creation transaction, media ownership, scheduler selection, worker claim, retries, status polling, and `platform_posts` linkage. Inspect real schema/migrations before proposing inserts.
- [ ] Compare local functions with deployed hashes through Postora's Contabo tooling when available; label local-only findings until verified. Do not print secrets.
- [ ] Inspect TikTok's official webhook envelope/ID examples and Direct Post/media contracts; record field-level evidence, including scheduling support. Do not treat existing webhook assumptions as provider truth.
- [ ] Finalize `tiktok_review_drafts` or an equivalent existing relation, submission/attempt uniqueness keys, and the atomic creation procedure. Document exact columns, constraints, RLS, grants, existing adapter called, and how ambiguous provider outcomes are reconciled.
- [ ] Update this plan's migration and integration file list to the verified paths. This task must finish before schema-dependent code begins.

**Validation:** A reviewer can follow one draft revision through consent, persisted job, dispatch, provider ID, and terminal status using named actual functions/relations. Every unknown Brandora state has an explicit evidence status.

**Commit:** Only the reference and integration documents/evidence after checking screenshots for secrets and unrelated user data.

## Phase 2 — Correctness and persistence

### Task 2: Implement review contracts and durable draft lifecycle

**Files:** Proposed domain types/rules, application ports, migration, `tiktok-review/index.ts`, `handler.ts`, and tests `src/features/tiktok-publishing/domain/reviewRules.test.ts` and `supabase/functions/tiktok-review/handler.test.ts`.

**Interfaces to establish:**

```ts
type ReviewState = 'draft' | 'pending_review' | 'rejected' | 'archived' | 'submitted';
type TikTokSettings = {
  privacy: string | null;
  allowComment: boolean; allowDuet: boolean; allowStitch: boolean;
  disclose: boolean; yourBrand: boolean; brandedContent: boolean;
  aiGenerated: boolean;
};
type ReviewDraft = {
  id: string; accountId: string; revision: number; state: ReviewState;
  caption: string; mediaId: string | null; settings: TikTokSettings;
};
type SubmitReviewCommand = {
  draftId: string; expectedRevision: number; requestId: string;
  mode: 'now' | 'scheduled'; scheduledAt: string | null;
  timeZone: string; consent: true;
};
type SubmissionResult = {
  attemptId: string; postId: string; state: 'queued' | 'scheduled';
};
interface ReviewGateway {
  create(accountId: string): Promise<ReviewDraft>;
  list(accountId: string, state: ReviewState): Promise<ReviewDraft[]>;
  save(draft: ReviewDraft, expectedRevision: number): Promise<ReviewDraft>;
  reject(id: string, revision: number, reason: string): Promise<ReviewDraft>;
  archive(id: string, revision: number): Promise<ReviewDraft>;
  submit(command: SubmitReviewCommand): Promise<SubmissionResult>;
}
```

`create` allocates the draft identity on the server after verifying account ownership. `save` updates an existing authorized draft; arbitrary client IDs are never ownership proof.

- [ ] Write failing rule tests for blank media/privacy, revision change invalidating confirmation, disabled interactions, and account changes invalidating consent.
- [ ] Write DB/handler tests: user A cannot read/save/submit user B's draft, attach B's media/account, or bypass checks under a service-role handler; a stale revision returns conflict.
- [ ] Implement atomic revision writes and reversible archive/reject transitions. Empty reasons fail validation. Unsubmitted drafts never enter the publishing scheduler's candidate set.
- [ ] Implement runtime request validation, authenticated user resolution, ownership predicates, typed error responses, and sanitized refusal logs. Map DB read errors to failures, not empty lists.
- [ ] Verify migration on a disposable database: both fresh schema and upgrade containing old posts; inspect grants and execute positive/negative authorization cases.
- [ ] Run targeted domain and Deno handler tests, then guard changed production/tests and commit only this task's files.

**Acceptance:** AC3, AC5, AC9. A saved draft survives a new browser session, while consent never survives implicitly.

### Task 3: Map settings correctly and submit a revision once

**Files:** `_shared/tiktokPostInfo.ts`, `_shared/tiktokPostInfo.test.ts`, review handler, demo compatibility function, existing process-post TikTok adapter, and persistence migration from Task 2.

**Interface:** `buildTikTokPostInfo(caption: string, settings: TikTokSettings)` returns the provider fields below. In the Deno module declare its structural input type locally; do not import browser feature code into Edge Functions.

```ts
return {
  title: caption,
  privacy_level: settings.privacy,
  disable_comment: !settings.allowComment,
  disable_duet: !settings.allowDuet,
  disable_stitch: !settings.allowStitch,
  brand_organic_toggle: settings.disclose && settings.yourBrand,
  brand_content_toggle: settings.disclose && settings.brandedContent,
  is_aigc: settings.aiGenerated,
};
```

Core regression assertion (use a test-local complete settings fixture):

```ts
const actual = buildTikTokPostInfo('Original caption', {
  privacy: 'SELF_ONLY', allowComment: false, allowDuet: false,
  allowStitch: false, disclose: true, yourBrand: true,
  brandedContent: false, aiGenerated: true,
});
assertEquals(actual.brand_organic_toggle, true);
assertEquals(actual.brand_content_toggle, false);
assertEquals(actual.disable_duet, true);
assertEquals(actual.disable_stitch, true);
assertEquals(actual.is_aigc, true);
```

- [ ] Add failing tests for every flag combination, missing/invalid privacy, unsupported creator interaction, excessive caption, unavailable creator info, and over-limit media for both local and URL sources.
- [ ] Route the new submission command through one durable publishing path. Persist the reviewed snapshot, authenticated account, consent time, revision, and request identity before dispatch.
- [ ] Make repeat/concurrent requests return the same post/attempt; enforce uniqueness atomically in PostgreSQL, not through a prior client read.
- [ ] Refresh creator information server-side, verify owned media, and validate the transfer contract before init. Block unknown duration and avoid arbitrary unverified external fetches.
- [ ] Replace the demo function's divergent payload construction with the same validated lifecycle or a compatibility adapter. Inventory old callers before changing response fields.
- [ ] Persist the provider ID and handle interruption between external acceptance and local persistence through an explicit unknown-outcome/reconciliation path. Do not promise impossible exactly-once guarantees across an external API.
- [ ] Simulate simultaneous submissions, double click, lost response after acceptance, token expiry, and a failed provider init. Assert no blind second init after an ambiguous outcome.
- [ ] Run Deno unit/handler tests and applicable existing publishing regressions; guard and commit scoped files.

**Acceptance:** AC4, AC5, AC7, AC9. Capture outgoing request bodies in mocked tests, never production credentials.

### Task 4: Connect webhook and automatic status tracking

**Files:** `tiktok-webhook/index.ts` and focused handler/helpers if extracted; `src/hooks/useTikTokStatusPolling.ts`; new `src/features/tiktok-publishing/application/usePublishStatus.ts`; tests beside new files.

**Interface:** Status reader accepts an authorized application attempt ID and returns `{ state, updatedAt, reason, postUrl }`; provider IDs remain implementation details. Allowed state mapping is documented in the integration note from actual provider responses.

- [ ] Add official-envelope fixtures with synthetic values for successful, failed, malformed, duplicate, out-of-order, and early-arrival events.
- [ ] Test valid/invalid signatures and timestamp boundaries; preserve realistic opaque ID characters instead of relying on an invented restrictive format.
- [ ] Persist or reconcile unmatched legitimate events according to the Task 1 design. Match only authorized account/application attempts; reject spoofed updates.
- [ ] Apply terminal outcomes idempotently. An older processing event cannot overwrite success; contradictory terminal events trigger explicit reconciliation.
- [ ] Wire bounded polling with backoff and cleanup on unmount/account change. Stop on terminal outcome, authorization failure, or an explicit tracking timeout with manual refresh available.
- [ ] Test that a provider ID alone shows Processing, that completion updates the UI, and that polling/webhook races do not regress state.
- [ ] Run targeted Deno and Vitest tests; guard and commit.

**Acceptance:** AC8, AC9. A user never needs to paste a publish ID into another page for ordinary tracking.

### Task 5: Schedule through the existing durable job lifecycle

**Files:** domain `scheduleRules.ts` and `.test.ts`, review submit handler, `process-scheduled-posts/index.ts`, and existing process-post integration where needed.

- [ ] Implement shortcut semantics: Now is immediate mode; In 1 hour is an instant one hour ahead; Tomorrow 9:00 is the next calendar day at 09:00 in the displayed zone.
- [ ] Write clock-controlled tests for past times, midnight rollover, DST gaps/overlaps, and browser/server time-zone differences. Use an explicit zone conversion facility already verified in the repository; do not silently parse a local date as UTC.
- [ ] Remove reliance on unverified `post_info.schedule_time`; persist the due time in POSTORA's existing queue. Assert provider init is not called when scheduling a future post.
- [ ] At due time, claim once, validate the consent revision and fresh capabilities, and dispatch via Task 3. Invalidated capabilities produce Needs attention rather than altered privacy/flags.
- [ ] Test two simultaneous scheduler runs, a disconnected account, restricted audience at execution, edited revision, cancelled job, and temporary provider failure.
- [ ] Run scheduler/publishing regressions; guard and commit.

**Acceptance:** AC6, AC7. Separate scheduling success from publication success in responses and copy.

## Phase 3 — Review workspace and interaction parity

### Task 6: Implement queue, detail, settings, and submission UI

**Files:** feature application/infrastructure/UI paths in the map; `src/pages/TikTokPublish.tsx`; reuse existing preview; tests `ui/TikTokReviewScreen.test.tsx` and `application/useTikTokReview.test.tsx`.

- [ ] Implement the gateway using Task 2 contracts; never put direct database writes in presentation components.
- [ ] Replace the page with the feature composition root. Keep authentication navigation and integrate an authorized draft creation action so the queue is usable when empty.
- [ ] Add queue/status/account filters and separate loading, empty, failed-load, and selected-detail states. Render truthful pending counts.
- [ ] Implement caption/video editing with Save/Cancel, preview synchronization, content counters, safe media replacement/removal, and revision conflict feedback.
- [ ] Build the settings panel with fresh creator state, privacy, greyed interaction controls, independent disclosure choices, AI label, current consent wording, and confirmation invalidation.
- [ ] Build schedule controls and destination summary, using Task 5 rules. Show visible reasons for disabled submission.
- [ ] Connect Reject, Archive, Next, and Approve & publish to the same domain transitions used by keyboard controls. Archive of an active scheduled/submitted item must not silently cancel it.
- [ ] Connect final explicit consent to submission. Ensure changing caption/media/account/settings/time invalidates the previous confirmation and never restores consent from local storage.
- [ ] Render processing, scheduled, terminal failure, success link, and manual refresh from Task 4. Remove the need for manual Publish ID entry in ordinary usage.
- [ ] Apply measured reference tokens in scoped CSS, preserve POSTORA branding, and document deviations caused by unavailable reference evidence or accessibility needs.
- [ ] Test with mocked gateway and creator responses: no submit before consent, correct destination, edit cancellation, restored draft with consent off, account switch, read error, duplicate click, rejected draft resubmission, and reversible archive.

Representative interaction assertion; `renderReviewFixture` is a test helper to implement in this test file with a supplied draft, creator response, and mocked gateway:

```tsx
const { user, gateway } = renderReviewFixture({ consent: false });
expect(screen.getByRole('button', { name: 'Approve & publish' })).toBeDisabled();
expect(gateway.submit).not.toHaveBeenCalled();
await user.click(screen.getByRole('button', { name: 'Edit' }));
await user.click(screen.getByRole('button', { name: 'Cancel' }));
expect(gateway.save).not.toHaveBeenCalled();
```

- [ ] Run targeted feature tests, typecheck, affected-file ESLint, and build. Inspect test failures rather than hiding them with broad mocks.
- [ ] Run production/test guards and commit scoped feature files.

**Acceptance:** AC2, AC3, AC5, AC10. The new feature has an active route consumer and no unused modules.

### Task 7: Visual, accessibility, and end-to-end acceptance

**Files:** `docs/qa/tiktok-review/acceptance.md`, sanitized screenshots, and focused browser tests using the repository's verified browser-test configuration.

- [ ] Compare reference and POSTORA at identical desktop viewport, selected state, and scroll position. Capture initial queue, detail, settings, edit, validation, consent, scheduled, processing, failed, and published states.
- [ ] Test at 390px width, keyboard only, visible focus, accessible field labels, dialog focus restoration, long captions, long account names, and RTL direction.
- [ ] Confirm A/R/Right shortcuts do not trigger in caption editors, date fields, menus, or dialogs; pressing A cannot publish without the consent flow.
- [ ] Verify every visible setting matches an intercepted synthetic request payload. Use mocked provider transport for tests that would otherwise publish.
- [ ] Record each AC1-AC10 result, evidence link, and any blocked scenario; do not convert untested cases into passes.
- [ ] Run the repository's relevant publishing tests, `npm run typecheck`, affected-file lint, and `npm run build`. Run `graphify update .` after code changes; account for generated graph changes separately.
- [ ] Resolve important findings, run clean-code-guard and test-guard according to project instructions, and commit only intended files.

## Phase 4 — Release and TikTok review evidence

### Task 8: Deploy in dependency order and verify the real flow

**Files:** `docs/qa/tiktok-review/release-evidence.md`; update the integration note with actual deployed versions and migrations.

- [ ] Produce a reviewable diff and migration impact report. Obtain any still-required production migration/live publication authorization with exact operations and destination account specified.
- [ ] Back up affected production data and apply additive schema before code that depends on it. Verify columns/constraints/grants and existing-user compatibility.
- [ ] Deploy Edge Functions through Postora's Contabo tooling and the canonical runbook; account for the automatic reconciler so branch files are not silently overwritten. Verify SHA256 and function boot behavior.
- [ ] Release the frontend and verify the served version. Do not infer deployment success from a merge or local build.
- [ ] With authorized original media and the specified TikTok account, execute a controlled immediate post. Record consent, outgoing flags, provider acceptance, persisted mapping, eventual status, and visible TikTok result.
- [ ] Execute a separately authorized scheduled post and prove no early provider submission plus one due-time dispatch. Verify a failed/restricted scenario without intentionally harming the account.
- [ ] Confirm live webhook registration/signature handling and automatic UI tracking; distinguish webhook evidence from polling fallback evidence.
- [ ] Prepare a recording script that demonstrates connection, account identity, editable preview, manual privacy selection, interaction restrictions, disclosures, explicit consent, processing, and final status.
- [ ] Record remaining limitations accurately. Do not claim TikTok approval until the provider grants it.

**Acceptance:** AC11, AC12. Keep rollback able to disable new submissions while completing tracking of already accepted jobs.

## Commands and checkpoints

The current Vite test configuration discovers tests under `src/**`; Deno tests require their own command. Use these commands after creating the named files:

```powershell
npx vitest run src/features/tiktok-publishing
deno test supabase/functions/_shared/tiktokPostInfo.test.ts
deno test --allow-env supabase/functions/tiktok-review/handler.test.ts
npm run typecheck
npm run build
git diff --check
graphify update .
```

Deno tests must inject mocked provider/database transports rather than require live network or credentials. If a test uses additional permissions, justify the narrow permission in its task evidence. Run ESLint on the actual changed TS/TSX files; use repository CI as the required whole-project gate. Capture pre-existing failures separately and do not claim checks passed when they did not.

Each implementation task ends with source review, relevant passing tests, guard checks, and a commit scoped with `git commit -- <task-files>`. No production-code tests are required for the current documentation-only change.

## Coverage and execution tracking

| Specification | Owning tasks |
| --- | --- |
| E1-E5 reference limitations, R1 visual parity | 1, 6, 7 |
| R2 queue/drafts, AC3 | 2, 6 |
| R3 preview/edit/media, AC10 | 3, 6, 7 |
| R4 creator/settings/provider mapping, AC4-AC5 | 2, 3, 6 |
| R5 schedule/actions, AC6 | 2, 5, 6, 7 |
| R6 consent/outcome, AC7-AC8 | 3, 4, 6 |
| Architecture, authorization, AC9 | 1, 2, 3, 4 |
| Release, AC11-AC12 | 8 |

- [x] Specification written locally.
- [x] Implementation plan written locally.
- [x] Documentation self-review: evidence boundaries, relative links, proposed versus existing paths, and acceptance coverage checked.
- [ ] Task 1 complete.
- [ ] Task 2 complete.
- [ ] Task 3 complete.
- [ ] Task 4 complete.
- [ ] Task 5 complete.
- [ ] Task 6 complete.
- [ ] Task 7 complete.
- [ ] Task 8 complete.

User requested specification and planning only in this turn. Execution begins under a subsequent implementation instruction; this document does not itself authorize external publishing or destructive migration operations.
