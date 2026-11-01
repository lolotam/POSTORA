# Threads insights account selection correction

Scope: the existing-account selection portion of [Meta analytics plan B3](../plans/2026-11-01-meta-analytics-completion.md#b3-threads-live-path-correctness). This correction is independent of Instagram pilot activation and does not complete B3's versioned metric decoding or pagination work.

## Proven defect

The real `threads-insights` composition accepted an explicit `accountId`, discarded the database read error, and called `getThreadsAccount` whenever the requested row was absent. With another active account available, a missing, foreign, inactive or non-Threads selector therefore returned that other account's analytics. A storage failure was indistinguishable from a missing connection. Invalid selectors could also be treated as omitted.

The regression ran the production composition, authentication helper and Supabase client against replaced HTTP boundaries. An alternative active account was present throughout. Before the correction, all four explicit unavailable-account cases returned success instead of 404, and failed reads returned a connection prompt instead of 503. Those red results establish the defect; they are not passing receipts.

## Implemented behavior

- One account query always filters by authenticated owner, platform `threads`, and active state. An explicit UUID adds the account filter and never falls back.
- Missing, foreign, inactive and wrong-platform explicit accounts share `404`, `account_not_found`, and the same safe message.
- A failed account read produces `503 storage_error`; raw database detail is not returned or copied to the account-error audit.
- Invalid explicit selectors, unknown selector keys, or malformed JSON from an authenticated user produce `400 invalid_request`, with no account read or provider call. A missing/invalid service-role identity is rejected with `401 unauthorized` before validation; it never returns a successful HTTP envelope.
- Omitted selectors retain the existing latest-account behavior, ordered by connection time, update time, and ID for deterministic ties. A genuinely empty implicit selection retains the legacy `no_account` connection prompt.
- Successful responses retain the legacy metrics shape and period choices. User JWT identity still takes precedence over body `user_id`.
- Account selection logging now records only the account ID, avoiding the previous token prefix/suffix summary. Every new refusal writes a structured operational log.

## Validation and limits

The endpoint regression passed one suite with 20 scenario steps, zero skips, using npm-packaged Deno 2.9.0. It executes the real composition and requires only `--allow-env`, with no network permission for test execution. It covers owner/foreign/inactive/wrong-platform selection, database failures with and without a selector, malformed bodies/selectors, JWT identity precedence, legacy success, implicit latest-account selection between two eligible accounts and the true no-account prompt. The CI Deno job now executes this suite. Four component tests additionally verify all four new refusal reasons in Arabic and English using the real translator, including non-2xx function responses.

Runtime caller: the deployed `threads-insights/index.ts` entrypoint registers exported `handler` with `Deno.serve` when run as the main module. Tests invoke that same handler; Auth, PostgREST and Meta HTTP are the replaced boundaries. There is no new database object, RLS grant or persistence model. Normal browser and internal service-role callers retain their existing authentication paths.

PR review corrections: the selection schema now rejects unknown keys while explicitly allowing internal `user_id`; authentication delegates to the shared helper and returns a sanitized 401 on refusal. The panel translates stable reasons through the analytics namespace, with English call-site defaults and Arabic locale entries. The latest-account test now contains an older alternative and verifies the selected identity. A fifth component regression reproduced previous-period metrics remaining visible after the new period failed; starting a read now clears the previous report scope before either success or refusal is rendered. All five component tests pass. Scanner warnings on four test-token literals were checked: all are fixed synthetic fixtures in the test file, not credentials loaded from an account, environment or secret store.

Production/source, test and documentation guards were applied to this scoped correction, with no blocking findings. `npm run typecheck`, `npm run build`, test-file ESLint and `git diff --check` passed. Existing build warnings about circular frontend chunks and bundle size remain. The immutable lint/i18n comparison of source `4fdef4e0d3eac74d6cb2f57f8d87a6f489b2a005` against `1c1f892b412951b0cb9afd74914bb5e5fb8edc63` reported **NO REGRESSIONS**: ordinary lint errors decreased from 1224 to 1223; i18n debt was unchanged. This is not a clean-lint claim.

No live Meta capability claim follows from synthetic transport. Contract negotiation, unavailable-versus-zero decoding, bounded pagination, Facebook/Threads history and live pilot acceptance remain open. Deployment follows the existing Edge deployment runbook after the reviewed revision is ready; no production function, credential, collection switch or schedule was changed by this local correction.
