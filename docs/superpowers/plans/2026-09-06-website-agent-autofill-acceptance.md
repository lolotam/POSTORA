# Website agent setup: production acceptance, 2026-09-06

## Outcome

Implemented website-to-business/agent drafts through the existing Firecrawl importer and durable worker. User-selected draft fields save into Manual profile and Settings. Missing facts remain absent; existing fields require explicit replacement. Agent activation, permissions, and operational controls are not generated.

PR #155 merged as `2e59b9c5`; follow-up PR #156 contains failures discovered by the live browser test and their regression coverage.

## Proven failures and fixes

- Jina configuration was missing from live runtimes. Persisted the supplied credential in the stack/Dokploy configuration and recreated the two affected services. No credential values are recorded here.
- Website indexing previously had no settings extraction step. Added trusted owner/account/source-scoped jobs, authenticated review/apply, source attribution, bounded extraction, independent polling and config-version concurrency protection.
- AI evidence differed in URL spelling and JSON shape. Canonical same-document references and a single URL normalize to the original crawled URL. Uncrawled resources still fail. Fields without citations are omitted before strict validation; a draft without attributable facts cannot succeed.
- Direct OpenAI GPT-5 requests rejected max_tokens. Normalized model-specific token/sampling parameters without mutating later fallback requests.
- xAI fell through to Google's endpoint. Added explicit xAI routing with the existing credential resolver. Live xAI now correctly reports its existing credit limit; the final successful setup used OpenAI gpt-5.5.
- Added allowlisted extraction stage diagnostics without model content or secrets.

## Live acceptance

Used the user's existing authenticated Codex browser and the admin-owned `xsellpoint_kw` Threads account (`eb7adda8-6962-4a07-b59b-350693a772fa`). This account had no saved agent configuration before the test.

1. Submitted `https://xsellpoint.com` with automatic setup enabled and scope **Only xsellpoint_kw**.
2. Website source `0cdd844b-a807-441e-b2b0-89d6ee3e9853` reached **ready**, 31 chunks.
3. Setup job `535cb5fe-dabf-4b25-a32a-a64ce83e595b` reached **ready** after the live fixes and was reviewed in the UI. Retries reused the same source.
4. Verified the product description against the public site and the shipping statement against crawled text. Applied eight selected fields: business type, products, shipping, tone, reply length, objectives, greeting and instruction blocks. Returns, warranty, FAQs and notes remained absent.
5. UI and database reported **applied**. A fresh authenticated page confirmed the business fields and behavior persisted. The original page's reload/navigation was aborted, so persistence was checked in a newly loaded page instead.
6. Generated profile source `43c777aa-8713-401a-899f-974072addd51` reached **ready**, one chunk. The agent remained disabled, with database defaults human_then_ai, daily cap 50, cooldown 60 seconds and no admin phone numbers.
7. The separate tenant's existing Xsellpoint configuration retained its exact pretest operational snapshot hash.

## Validation and deployment

- Frontend: 226 test files, 1,513 passed tests; 15 skipped. Typecheck and production build passed.
- Backend: 40 focused provider/setup tests plus 21 final setup regression tests passed; endpoint/worker typechecks passed.
- PostgreSQL 17 harness: baseline, 35 migrations, 21 baseline suites and one isolated website setup suite passed. Isolated database/container cleaned up.
- Independent reviews found no release blockers. CodeRabbit was rate-limited for the follow-up and is not counted as a substantive review.
- Migration applied as postgres before runtime/frontend release. Deployed modules SHA256-verified; edge functions and standalone worker restarted. Original PR remote checks passed; follow-up remote checks recorded on PR #156.
- Known pre-existing build warnings and ingest sourceVisibility typecheck incompatibilities were not changed.

## Retained data and workspace state

The new account-scoped website and generated profile are retained as usable knowledge. Original shared website source `7121ff85-d68a-4ba0-816a-c08539deab06` and earlier Jina recovery test source `9f6e1782-758c-431e-aadb-b56a03f32227` remain intact. No production source was deleted. Temporary verification tabs are closed; the original user tab is retained.

Production changes are in the knowledge/setup UI and hook, profile-refresh helpers, setup API/draft/service modules, importer and standalone worker integration, shared provider adapter, migration, and database harness. Isolated worktrees preserve the user's dirty main checkout.
