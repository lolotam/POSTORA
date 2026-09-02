# Versioning and Compatibility

Per PRD §43. This page is the compatibility policy before GA.

## What is additive and needs no migration

- New routes under the same major prefix (`/v1`).
- New optional request fields (nullable, defaulted).
- New values inside `details` or new webhook event types (on the certified list).
- New entries in `meters` arrays.

A client must tolerate unknown fields and unknown enum strings in extensible places. The OpenAPI document is additive-only under this rule.

## What is breaking

- Removing a route or field.
- Narrowing a type (`string` → enum, optional → required).
- Removing an enum value.
- Repurposing a field's semantics without a new major.

A breaking change requires a new major path prefix (`/v2`). Webhook schemas follow the same rule — a breaking payload change ships under a new event version or new major.

## Deprecation window

A feature marked `Deprecated` in `deprecations.md` carries `replacement`, `deprecation_date`, `planned_removal_date`, and `migration` steps. No silent repurposing — behavior changes are announced in `changelog.md` first.

## How the drift gate enforces it

`scripts/check-openapi-drift.ts` compares `docs/api/openapi.yaml` against `docs/api/openapi.baseline.yaml` and fails on un-acknowledged breaking differences. See `docs/api/README.md` for the mechanism.
