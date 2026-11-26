# YouTube Stage 6 — implementation and verification plan

26 November 2026 · tier **Medium** · one documentation/legal/test delivery · [specification](../specs/2026-11-26-youtube-stage6-disclosures-quota-package.md)

## 1. Baseline, boundaries and architecture

- Baseline: `1985f724a52abf53fd72584664441ef22db44c14` on `origin/main`; branch `feat/youtube-stage6-disclosures-quota-package`.
- Business capability: accurate public disclosure and reviewer evidence for shipped YouTube Stages 1–5.
- Implementation layers: public React pages and their component tests; Markdown verification/reporting documents. No domain, application, infrastructure, Edge Function, or database change.
- Security/RLS impact: none. No runtime authorization or token code changes. Documentation must not include credentials or private production identifiers.
- Backward compatibility: public legal text becomes more complete; no routes, links, APIs, stored data, or purpose-version contracts change.
- `src/features/youtube-analytics/domain/purposeText.ts` and its digest test are read-only fixtures for this stage and must not change.
- Production and live Google actions are outside this task. Repository SHAs may be computed as reference evidence but must not be labelled deployed parity.

## 2. Work in dependency order

### Step 1 — Freeze the implementation evidence

1. Read `ARCHITECTURE.md`, `AGENTS.md`, the three legal pages, the verification guide, Stages 2–5 specifications, and the analytics purpose text/digest test.
2. Confirm the baseline commit and inspect the real OAuth, resource, publishing, comments, and analytics handlers. Trace scope to provider operation to code rather than copying aspirational spec text.
3. Re-read Google's official Data API quota calculator and Analytics data-model quota section. Record that `videos.insert` has its own default 100-call/day bucket and `thumbnails.set` costs 50 shared units.
4. Inventory migrations, merge commits/PR numbers, offline test files, and any repository-held deployment receipts. Mark absent live evidence explicitly; never infer it from a merged commit.

Exit: the specification and this plan exist at the required paths and contain the confirmed baseline, required changes, and acceptance gates.

### Step 2 — Reconcile the public legal pages

Files:

- `src/pages/GoogleApiDisclosure.tsx`
- `src/pages/Privacy.tsx`
- `src/pages/Terms.tsx`

Actions:

1. Pin all update dates to `November 26, 2026`.
2. Expand scope justifications to Stage 1–5 behavior. Correct the broad-scope rationale so metadata editing is acknowledged while video-byte replacement and video deletion remain explicitly excluded.
3. Add video browsing/details and metadata editing to the Privacy collection/use sections and Terms YouTube services section.
4. Reconcile disconnect and retention text with `youtube-oauth/handler.ts` and D13-B: shared-grant check, refresh-token revocation with access-token fallback, fail-closed provider errors, immediate local credential clearing, and fresh acceptance on a new connection.
5. Preserve existing policy links and the Analytics Purpose Clause Version 1/date. Do not touch the canonical purpose strings.

### Step 3 — Update the OAuth verification guide

File: `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md`

Actions:

1. Replace the abbreviated scope justifications with complete Stage 1–5 purposes and user benefits.
2. Document the exact three-scope authorization URL parameters, including no `include_granted_scopes`, and the dedicated analytics scope's non-requested status.
3. Update the privacy-policy block and disconnect demonstration to match shipped behavior.
4. Add Analytics API v2 to the API Library checklist and document in-app acceptance/withdrawal separately from Google's OAuth permission.
5. Add a Stage 6 document-history entry and link the approval/demo package.

### Step 4 — Build the approval and demo package

File: `docs/reports/2026-11-26-youtube-stage6-approval-package.md`

Sections, in order:

1. Baseline and evidence legend.
2. Scope → operation → code mapping across Stages 1–5, with frontend entry points and server adapters.
3. Official Google quota costs and implemented Postora limiters/budgets, including exact bucket-key patterns, Pacific-day arithmetic, fail-open/fail-closed distinctions, and the separate `videos.insert` bucket.
4. Release receipts: merge commits and PR links; all eight YouTube migrations from `20261119130000` through `20261126120000`; deployed-SHA evidence status; actual offline test inventory and commands.
5. Masked eight-journey verification/demo script with setup, actions, expected result, and evidence to capture for each journey.
6. Submission checklist and explicit evidence limits.

Repository SHAs, if included, are generated with `sha256sum` against the baseline and labelled **repository reference hashes**. A separate deployed-parity receipt remains required for external submission unless already present in verifiable release records.

### Step 5 — Add the legal component suite

File: `src/pages/__tests__/YouTubeLegalDisclosures.test.tsx`

Actions:

1. Follow the existing Vitest/Testing Library setup and render each page inside `MemoryRouter`.
2. Use role/name and exact-href assertions for links; use scoped text queries for repeated policy dates and purpose clauses.
3. Cover all scope URLs, every shipped capability, metadata-edit/no-video-delete wording, deterministic dates, disconnect path, and analytics re-acceptance behavior.
4. Avoid brittle whole-page snapshots, CSS assertions, current-clock mocking, network calls, or new test helpers/dependencies.

### Step 6 — Verify and guard

Run from the repository root:

```bash
npx vitest run src/pages/__tests__/YouTubeLegalDisclosures.test.tsx src/features/youtube-analytics
npm run typecheck
npx eslint --max-warnings=0 src/pages/GoogleApiDisclosure.tsx src/pages/Privacy.tsx src/pages/Terms.tsx src/pages/__tests__/YouTubeLegalDisclosures.test.tsx
```

Then:

1. Run `clean-code-guard` on the three changed production pages and address findings.
2. Run `test-guard` on the new test file and address findings.
3. Run `docs-guard` on the specification, plan, verification guide, and approval package; check every code path and quota number against the baseline.
4. Run `graphify update .` as required by project guidance. Exclude generated graph state from the commit.
5. Inspect `git diff --check`, the full diff, and `git status`. Confirm no purpose-text change, secret, unrelated file, or generated test output is included.

### Step 7 — Commit and hand back

Commit only:

```text
docs/specs/2026-11-26-youtube-stage6-disclosures-quota-package.md
docs/plans/2026-11-26-youtube-stage6-disclosures-quota-package.md
docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md
docs/reports/2026-11-26-youtube-stage6-approval-package.md
src/pages/GoogleApiDisclosure.tsx
src/pages/Privacy.tsx
src/pages/Terms.tsx
src/pages/__tests__/YouTubeLegalDisclosures.test.tsx
```

Use a task-scoped commit on `feat/youtube-stage6-disclosures-quota-package`. Never include `graphify-out/cache/last_query_stamp`, other graphify cache files, logs, environment files, or secrets.

No file under `supabase/functions/**` changes, so no Edge Function redeployment is required. Frontend deployment, PR creation, external submission, production verification, and live demo recording remain manager/owner actions.

## 3. Final evidence checklist

- [ ] Required spec and plan written before implementation edits.
- [ ] Three public pages reconciled and deterministic.
- [ ] Verification guide reflects all scopes, OAuth parameters, revocation, and purpose acceptance.
- [ ] Approval package contains mapping, quota model, receipts, migrations, SHA status, offline inventory, and eight masked journeys.
- [ ] New legal tests pass together with all `src/features/youtube-analytics` tests, including the purpose-digest guard.
- [ ] Typecheck and zero-warning targeted ESLint pass.
- [ ] Three guard skills run and findings resolved.
- [ ] Diff inspected and task files committed alone.
