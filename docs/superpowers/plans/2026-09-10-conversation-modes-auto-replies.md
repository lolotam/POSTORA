# Conversation modes and auto-replies implementation plan

**Goal:** Finish spec §7.6 part 2b through the existing /v1 automation boundary.

**Architecture:** Reuse the bound conversation loader and explicit response presenters. Keep rule operations separate from the HTTP adapter; every mutation uses automationWrite. The browser and database schema stay unchanged.

**Spec:** ../specs/2026-09-10-partner-api-sections-design.md §7.6 and the task's privacy and ownership constraints.

**Constraints:** No commit, migration, browser changes, new scope, or baseline regeneration. Service-role queries must carry ownership predicates. Every refused routed request is logged by withPartnerAuth.

- [x] Add mode operations in `v1/conversationModes.ts`, sharing the existing conversation lookup/refusal. Publish only the surrogate UUID as `id`; clear overrides by deletion. Scan bound conversations in descending last_message_at/id order, join modes by owner/platform/private key, and omit unresolved modes. Bound each request's scan; a continuation can describe a sparse page.
- [x] Add `v1/autoReplies.ts`: validate table-specific platforms and rule fields, derive ownership with resolveAgentAccount, scope PATCH/DELETE reads and writes by owner and platform, and whitelist output fields.
- [x] Extend `v1/automation.ts`, both policy maps, entitlement policy, and route registration. Preserve claim/replay/settlement semantics; include resolved ownership in new write hashes and verify conversation authority before claims.
- [x] Add routed tests using the PostgREST fixture for privacy, binding, owner payloads, clearing, platform validation, failed reads, logs, all claim outcomes and real replay. Validate fixture select/filter semantics so tests can catch missing columns and scope predicates.
- [x] Add all seven OpenAPI operations, input/output schemas, owner-wide descriptions, and pagination semantics. Run the drift gate, regenerate Postman and agent context, and run both generator suites.
- [x] Run full _shared, partner-api, and messaging-api suites; run clean-code-guard/test-guard review and graphify update. Report exact results and deployment availability. Leave changes uncommitted.
