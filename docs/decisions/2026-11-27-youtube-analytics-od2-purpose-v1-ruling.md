# Owner Decision OD-2: Analytics Purpose Clause v2 & Two-Stage Rollout for Phase 5

**Date:** 2026-11-27
**Owner:** Waleed Mohamed (via recommended-option delegation: `"U HAVE THE MERG DESCIONS AND YOU CAN SLECT RECCOMENDED IF ANY QUESTIONS UNTILE I WILL WAKE AGAIN"`)
**Status:** Decided — Recommended Option Selected (`Purpose Clause v2` with non-stranding `ANALYTICS_PURPOSE_ACCEPTED_VERSIONS = [1, 2]` Stage A compatibility)
**References:**
- `docs/specs/2026-11-26-youtube-vnext-roadmap-and-ux.md` §3 (`OD-2`) and §9
- `docs/plans/2026-11-26-youtube-vnext-roadmap-and-ux.md` Phase 5 (`PR-12` & `PR-13`)
- `supabase/functions/youtube-analytics/contracts.ts` (`ANALYTICS_PURPOSE_VERSION = 2`, `ANALYTICS_PURPOSE_ACCEPTED_VERSIONS = [1, 2]`)
- `src/features/youtube-analytics/domain/purposeText.ts`

## Context

`docs/specs/2026-11-26-youtube-vnext-roadmap-and-ux.md` §3 (`OD-2`) specifies:
- **Recommendation:** Publish **Purpose Clause v2** naming the Phase 5 data categories (`viewer country`, `device type`, `traffic sources`, `audience retention`, and browser-side export to the owner's own device).
- **SQL Migration Check (`PR-12` Step 2):** Both `supabase/migrations/20261125120000_youtube_stage5_analytics_rollout.sql` and `supabase/migrations/20261126120000_youtube_reauth_permission_prompt_and_consent.sql` accept `p_purpose_version integer` (`CHECK (purpose_version > 0)`) as a parameter to `youtube_analytics_stage5_record_consent` and `youtube_analytics_stage5_decide`. No SQL migration is required.
- **Two-Stage Rollout (`PR-12` Stage A):** So that open v1 browser tabs are never stranded during deployment turnover, `ANALYTICS_PURPOSE_VERSION = 2` is offered to all new tabs while `ANALYTICS_PURPOSE_ACCEPTED_VERSIONS = [1, 2]` honors both v2 and existing v1 acceptances during Stage A turnover (until Stage B narrows `ANALYTICS_PURPOSE_ACCEPTED_VERSIONS` to `[2]`).

## Decision

Following Waleed's explicit instruction to select the **recommended** option on all decision cards:

1. **Purpose Clause v2 (`ANALYTICS_PURPOSE_VERSION = 2`, dated `2026-11-26`) is adopted**, explicitly naming viewer country, device type, traffic sources, audience retention, and browser-local export to the owner's device in both English and Arabic (`src/features/youtube-analytics/domain/purposeText.ts`), with v1 preserved for historical rendering and pinned SHA-256 digests verified for both v1 and v2.
2. **Stage A Non-Stranding Rollout (`ANALYTICS_PURPOSE_ACCEPTED_VERSIONS = [1, 2]`) is active** in `supabase/functions/youtube-analytics/{contracts.ts,consent.ts,decision.ts}`:
   - `status` offers `purpose_version: 2`.
   - New acceptances record `purpose_version: 2`.
   - Both Stage A (`[1, 2]`) and Stage B (`[2]`) behaviors are covered by automated Deno unit tests (`consent.test.ts`, `decision_limits.test.ts`).
3. **Legal Disclosures Updated (`OD-3` / `PR-12` Step 5):** `src/pages/GoogleApiDisclosure.tsx`, `src/pages/Privacy.tsx`, `src/pages/__tests__/YouTubeLegalDisclosures.test.tsx`, and `docs/YOUTUBE-OAUTH-VERIFICATION-GUIDE.md` reference `Analytics Purpose Clause, Version 2, dated November 26, 2026` and disclose the Phase 5A breakdown/retention metrics and Phase 5B browser-local export.
