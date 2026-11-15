# Instagram bootstrap readiness correction

## Scope and evidence

This is a bounded correction to the truthful readiness and verified bootstrap
requirements in the [approved all-customers design](../specs/2026-11-14-owner-analytics-for-all-customers-design.md).

A read-only production investigation on 2026-11-15 found valid page-linked
Instagram bootstrap bindings whose receipts, provider identities, target
identities, and live connection fences all match. Collection has saved daily,
profile, and media measurements, but the report returns `identity_mismatch`.
The report's Instagram branch accepts only OAuth exchange/refresh provenance;
the Facebook branch and credential readers already recognize verified bootstrap
receipts. This is independent of any outstanding provider retry or incomplete
historical collection. A provenance label alone must never establish identity.

## Implementation and validation

- [x] Add an additive migration replacing the existing internal readiness helper.
  Change only the Instagram identity predicate: accept
  `verified_legacy_bootstrap` when `analytics_bootstrap_binding_verified` proves
  the receipt and current authority. Retain the outer identity/fence checks,
  credential lifecycle/expiry, independent permissions, owner boundary, function
  ACLs, and the direct-login wrapper.
- [x] Extend the registered `analytics_legacy_bootstrap.sql` suite with the public
  report regression. Check valid authority, independent permission evidence,
  truthful absence of captures, and negative controls for a moved fence, changed
  target identity, missing binding, expired credential, and foreign owner. Roll
  back each mutation and restore suite state.
- [ ] Execute the complete registered SQL suite through normal PR CI. No local
  native SQL harness or production mutation is part of this investigation.
- [ ] Complete ordinary review and exact-head checks before merge disposition.

No Edge Function, frontend, credential, policy, schedule, retry, or flag change
is required. No new provider request was made during diagnosis. This change
does not claim to fix outstanding provider failures or complete historical data.

## Production gate

Production remains unchanged. Applying
`20261115140000_instagram_bootstrap_readiness.sql` requires a separate bounded
migration disposition after CI and review. Existing saved measurements and
connection evidence must be preserved. After an authorized application, verify
the public report exposes a verified connection without hiding independent
collection or permission failures. Do not force a sync or reconnect as part of
this report correction.
