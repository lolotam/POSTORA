# Review follow-ups — implementation plan

Spec: `docs/superpowers/specs/2026-10-30-hardening-review-followups-design.md`.
Branch `fix/hardening-review-followups` from `origin/main` (`aa8d21f`). One commit per task,
scoped with `git commit -- <files>`. Required reading: `ARCHITECTURE.md`; `AGENTS.md` rules 3
(a failed read never looks empty) and 4 (every refusal writes a log row, here except the
unauthenticated one, which would let anyone spam service-role writes).

Checks: `deno test -A` on each touched function's tests; `deno check` on touched entry points
against `origin/main`'s error count (process-post has 49 before); `npx vitest run` on touched
front-end tests, `npx tsc --noEmit -p tsconfig.app.json`, `npx eslint <files>`; the DB harness
for SQL.

1. **Docs** (this commit): spec and plan; F10 rewrite of Task 7 in the parent plan.
2. **F1 + F2** `_shared/metaContainerStatus.ts` (+ test): `deadlineMs`, `checkFirst`,
   `fetchTimeoutMs`, `now`, HTTP/Meta-error classification. `process-post/index.ts`: both
   Instagram pollers and the Threads path call `pollContainer`.
3. **F5** `media-direct-upload/index.ts`, `refusals.test.ts`.
4. **F3** `cloudinary-upload/urlIngest.ts` (+ test), `index.ts`, runbook.
5. **F4** `src/features/mfa/**`, both callers, tests.
6. **F6** migration `20261030090000_record_deferred_platform_post.sql`,
   `supabase/tests/deferred_publishes.sql`, `process-post/deferredPublish.ts` (+ test).
7. **F7 + F8** `process-post/postSettlement.ts` (+ test), `index.ts`: one notification helper,
   used by the first run, the resumed run and the abandon path.
8. **F9** `process-post/instagramStory.ts` (+ test), `postToInstagram`.
9. Guard pass, full validation, report.
