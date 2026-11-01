# Saved owned-account analytics UI implementation plan

**Goal:** make the saved Facebook and Threads reports reachable from their existing analytics pages, with truthful incomplete/error states, while preserving Instagram's existing owner report until its capability evidence permits canonical adoption.

**Architecture:** extend `src/features/analytics-contract/` with a narrow Supabase adapter, query hook and shared presentation. Existing pages remain composition roots. Reuse the canonical response parser, metric definitions, calendar and sync states; do not calculate provider metrics in the browser. Competitor/discovery screens remain separate.

**Scope decision:** the owner authorized completing the missing implementation before presenting a concrete deployment package. The existing completion design governs this work. Instagram's unknown provider calendar and missing protected credential binding remain explicit acceptance blockers. This implementation cannot approve collection, schedules, production changes or a G-X exception.

- [ ] Implement a token-free owned-account selector, including disconnected accounts whose saved history remains readable. Failed account queries render an error, never an empty account list.
- [ ] Read saved reports with explicit `analyticsContractVersion: 1`, validate their platform/account/source at the browser boundary, and propagate opaque continuation cursors. Account/period changes reset pagination; a revision conflict requires a fresh first page.
- [ ] Render shared period/account controls, collection state and times, metric definition/source/observation details, partial coverage, previous-period comparison, gapped daily trends and post metrics. Unknown values never become zero. Rank only loaded posts and disclose that scope.
- [ ] Preserve legacy Instagram gateway requests. Add explicit canonical gateway negotiation for boundary/compatibility proof, without migrating the production screen before capability evidence is accepted.
- [ ] Route Facebook's owned performance tab and Threads' insights tab to the new shared screen. Refresh reads saved data only; it never admits an account, enqueues collection or activates a schedule.
- [ ] Test unavailable/partial/zero values, all sync states, failed account/report reads, selected-account/period changes and continuation failure. Run affected component tests, canonical parity, typecheck/build and lint/i18n regression.
- [ ] Commit the implementation and record exact candidate revisions, migrations/functions/UI scope, production blockers, acceptance operations and rollback in the deployment package. No production execution in this preparation task.
