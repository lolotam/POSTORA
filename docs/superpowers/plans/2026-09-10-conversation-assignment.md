# Conversation Assignment Implementation Plan

**Goal:** Complete spec section 7.7 with four assignment routes and two trigger-produced events.

**Architecture:** Reuse `agents.ts`'s idempotency wrapper and `loadBoundConversation`. A service-only SQL function locks the resolved cache row, validates workspace and binding, and closes/opens assignments plus history atomically. A non-blocking table trigger emits safe surrogate references.

**Tech Stack:** Deno, TypeScript, PostgreSQL, PostgREST.

**Spec:** `docs/superpowers/specs/2026-09-10-partner-api-sections-design.md`, sections 7.7 and 8; user task supplies transition and failure semantics.

## Constraints

- No commits, baseline regeneration, browser changes, foreign-key changes or index changes.
- Entitlement first; structural workspace and account ownership; safe field projections.
- Preserve every certified event in order; append assigned and unassigned only.

## Steps

- [x] Add migration `20260910170000_partner_assignment_events.sql`: guarded CHECK widening, non-blocking emitter and trigger, atomic service-only assignment RPC. Explicitly revoke PUBLIC, anon and authenticated.
- [x] Add `v1/conversationAssignments.ts` for validation, assignment reads, mutation RPC and history pagination; extend the existing `agents.ts` wrapper for assignment actions.
- [x] Register four routes and matching scope/risk/entitlement entries. Add OpenAPI paths, schemas and event contract without editing its baseline.
- [x] Add migration assertions and routed regression tests covering privacy, binding, actual fixture mutations, equal-timestamp pagination, read errors and all idempotency outcomes. Rehearse SQL locally if a database runtime is available.
- [x] Run both complete Deno suites, existing-baseline drift, both artifact generators and both generator tests. Review changed production code with clean-code-guard and tests with test-guard, update graphify and report exact results and operational limitations.

## Validation outcome

Both full suites pass: 1219 shared tests (126 steps), 616 API tests (10 existing ignored tests). Contract drift is non-breaking against the unchanged baseline. Generators and their 5 + 7 tests pass. The isolated PostgreSQL WASM rehearsal passes 38 assertions. Deno lint checks 10 touched modules. No commit was made. Deployment and live verification remain pending: the SSH prerequisite read required approval, rejected under this session's never-approve policy. See the adjacent verification report for exact commands and output.
