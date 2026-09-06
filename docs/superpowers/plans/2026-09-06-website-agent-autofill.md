# Website Agent Autofill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Generate an attributed, reviewable business and agent setup draft from the existing website importer and safely apply selected fields.

**Architecture:** Extend existing ingestion and standalone worker with durable extraction jobs. A small authenticated setup endpoint handles draft reads/retries/application. Reuse structured profile and behavior validators and configured AI routing; frontend review is account scoped.

**Tech Stack:** React, TypeScript, Supabase PostgreSQL, Deno, existing Firecrawl and AI adapters.

**Spec:** ../specs/2026-09-06-website-agent-autofill-design.md (approved).

## Global Constraints

- Required reading: ARCHITECTURE.md, especially sections 1, 4, 23-28, 31-39 and 45.
- Extend existing crawler, worker and settings contracts. No new provider dependencies.
- All job operations structurally verify source and target ownership under service role.
- Only supported profile/behavior fields are applicable; no activation, permissions, phone numbers, tools or limits.
- Preserve nonempty fields by default. Explicit replacement selection and optimistic concurrency are required.
- Unknown business facts remain absent. Source references are validated against actual crawled URLs.
- Deploy additive migration before runtime code; verify hashes, frontend deployment and live browser result.

## Task 1: Durable extraction and safe application

Files: new migration `supabase/migrations/20260906170000_website_setup_jobs.sql`, new `supabase/functions/ai-website-setup/` modules/tests, new focused extraction modules in `ai-knowledge-excel-worker/`; modify existing ingest and worker entrypoints only at integration points.

Interfaces: `ingest_website` accepts `generate_setup: boolean`, `platform`, `social_account_id`; every successful response includes `source_id`. Setup endpoint actions `list`, `retry`, `apply`; list returns `{ jobs }`. Jobs include `id`, `source_id`, `social_account_id`, `platform`, `status`, `error`, `result`, `created_at`, `updated_at`. Result includes `business_profile`, `agent_behavior`, source attribution and coverage. Apply takes job ID, selected field paths and expected config version; merges selected fields atomically with server validation. Concrete exported types must be communicated before frontend wiring.

- [x] Write failing Deno tests for invalid/missing facts, references outside crawl, prohibited settings, owner mismatch and safe merges.
- [x] Implement migration: caller-scoped creation, service-only claims/completion/application, explicit source/account checks, stale lease reclaim, independent status, unique source/target job.
- [x] Implement bounded AI extraction using existing routing and strict validators. Crawl text is data; output is not an instruction source. Limit source input and expose coverage.
- [x] Integrate job creation before crawl handoff and process one eligible job per worker cycle even while ingestion queue is busy.
- [x] Implement authenticated list/retry/apply; check every PostgREST error and log refused work. Atomic version check prevents concurrent edits from being overwritten.
- [x] Run targeted tests and type checks; guard production and test changes; commit task files.

## Task 2: Review UI and truthful progress

Files: `src/components/messaging/knowledge/WebsitePanel.tsx`, `AiKnowledgeManager.tsx`, new `WebsiteSetupDrafts.tsx`, new `src/hooks/useWebsiteSetup.ts`, new pure draft display helpers/tests.

- [x] Regression test: `{ queued: true }` displays queued progress, never "Page indexed".
- [x] Add default-enabled setup option only when an account is selected; pass platform/account through ingest request.
- [x] Poll extraction jobs separately from source indexing. Show retry, coverage, attributed business facts, suggested behavior and missing fields.
- [x] Render per-field review checkboxes; new fields selected by default, existing values unchecked. Apply only selected fields with the loaded config version. Avoid stale account results and preserve dirty forms.
- [x] Verify account switching, failed reads, replacement choices, queued status and API error recovery with Vitest.
- [x] Run guards and commit scoped files.

## Task 3: Integration, review and release

- [x] Review backend and frontend contracts and all changes against the approved spec; correct concrete findings.
- [x] Run relevant Deno/Vitest tests, lint and production build. Refresh graph output.
- [x] Apply additive SQL using the owning database role; isolated PostgreSQL fixture verifies cross-owner denial and concurrent apply rejection.
- [x] Deploy committed backend files through Contabo SSH; verify SHA256 and restart functions/worker.
- [ ] Push branch, open PR, land after required checks, verify Dokploy frontend build.
- [ ] Use existing Codex browser to scrape a relevant account's public website, inspect ready draft and apply only appropriate reviewed fields; verify persistence after refresh.
- [ ] Record exact release and test-source cleanup status. No credential values in Git, logs or reports.

## Ledger

- Runtime Jina repair was completed before this plan: persisted configuration, recreated runtimes, source ready with 31 chunks.
- Ruling: use an isolated extraction jobs table linked to the source rather than caller-editable source metadata for trusted AI output. This prevents client forgery and permits atomic claims/apply.
- Ruling: migration application and deployment are within the approved implementation scope; no further design confirmation is needed.

- Validation: 1,513 Vitest tests passed (15 skipped), frontend typecheck/build passed; 14 new Deno and 26 existing worker/ingest tests passed; actual migration fixture passed on PostgreSQL 17. Existing ingest typecheck errors are unrelated sourceVisibility interfaces. Full CI caught isolated SQL fixture registration, being integrated before merge.
- Release: PR #155 opened. Migration applied as postgres. Six production modules match Git SHA256; shared dependencies match base. Both edge runtime and standalone worker restarted; setup OPTIONS returns 200.

