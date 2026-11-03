# Canonical discovery refusals and explicit interactive fallback

Executed source: `9413950f01ea6fa933e016d60ab7b1d89acf8136`. The [proof record](evidence/2026-11-02-instagram-discovery-refusals-proof.json) binds the candidate/tree, actual executed files, results, cleanup and retained local artifacts. This advances the local J4 requirements in the [release specification](../specs/2026-10-30-instagram-release-gates.md#4-seeded-e2e-design-and-journey-assertions). **J4 remains partial:** no verified Meta signal yet establishes confirmed target ineligibility or its weekly retry. A generic provider refusal cannot supply that evidence.

## Existing behavior reused

The production discovery handler already resolves protected authority before cache access, classifies token code 190 separately, keeps ambiguous permission/network/provider failures generic, requires the persisted `apify_enabled` setting for interactive fallback and refuses paid fallback on throttling. This batch changes no production code. It adds an assembled journey through the real current Instagram page, registered discovery handler, Auth, PostgREST and SQL. Only provider HTTP is synthetic.

The fixture now intercepts the exact reviewed Apify actor request locally. Its transport refuses foreign tokens/hosts/actors, other methods, extra/duplicate parameters, unseeded handles, altered body shapes and excessive calls. It never forwards to native fetch. The synthetic token is confined to the fixture environment; inherited credentials remain refused. The setting control requires the fixture service key and matching namespace/candidate, accepts only an actual boolean and writes the real local setting. The journey verifies unauthenticated, wrong-namespace and malformed controls are refused before use.

## Actual browser and persistence assertions

With fallback off, the browser searches different seeded targets under provider permission code 10, token code 190, transport failure and ambiguous code 100/subcode 33. It checks the actual HTTP status/error code, displayed message and reconnect action. Only the 190 case offers reconnect. None becomes a successful target profile or a saved analysis. The complete selected watchlist rows remain unchanged, including eligibility/retry state, and no Apify call occurs.

The privileged local control then enables the existing setting. A token-expired official request falls back through the real parser to one synthetic third-party result: 67 followers, a REEL, hidden likes null and 17 views. The API, profile, saved history and visible badge all retain `apify`/`Third-party`; the reconnect warning remains, and no `Official` badge appears. This does not repair or hide the expired official authority.

A subsequent 429 still produces `DISCOVERY_RATE_LIMITED`, adds no Apify call and leaves the watchlist unchanged. The test restores the setting and provider scenario. The following API/MCP report tests retain all prior provider receipts and prove their own reads/refusals add no provider call.

The fixture continues to report the unverified target-ineligibility signal as a blocker. No target was marked private or given a weekly retry by inference. The scheduled paid-fallback policy requires its separate existing worker/SQL proofs; this interactive journey does not claim to execute or approve scheduled Apify.

## Results and retained failure

All **five canonical tests passed** at the executed source, with no failures, skips, retries or flaky results. This includes the existing real-Auth/quota smoke, official discovery/cache/history journey and both actual API/MCP contract tests. The fresh disposable database passed its baseline, 151 newer migrations, 69 baseline SQL suites and one isolated suite. The ten fixture safety tests, strict test TypeScript check, scoped ESLint and final-source Deno check passed. Immutable lint/i18n against `568fe2fc82446b2d927dcb532edfc215ba64fa9a` reports **NO REGRESSIONS**; historical debt remains. Application typecheck/build were not rerun because no application inputs changed.

The first assembled run at `eadacd3c4d4841a86faee6c919169f65a5967729` retains four passes and one failure. The rejection checks passed, but the new fixture setting control compared a returned key with `psql` output that also contained its UPDATE command tag, yielding a fixture 500 after a successful write. A modifying CTE followed by SELECT preserves the real update and row confirmation without the command tag. The trace, screenshot, JSON and log from the failed source remain separate; they were not relabelled as successful.

An initial strict test check also exposed missing declarations for existing imported `.mjs` files. Checking their actual source with `--allowJs` passed without weakening strictness or adding declaration stubs. Code/test/documentation guards reviewed the final changes, and graph maintenance completed.

Independent post-run SQL confirmed only the baseline harness user remained, with no fixture namespace, scrape sessions/cache, fixture OAuth client, active cron or live Instagram lease. The cron launcher stayed off, both HTTP listeners stopped and the original absent Apify setting was restored. The predecessor fixture containers and volumes were preserved with recovery metadata.

## Release boundary

The [implementation evidence index](2026-10-26-instagram-insights-and-competitor-tracking.md) and [release procedure](../runbooks/instagram-insights-release.md) now provide the two previously missing documentation sources. Their existence does not establish trusted execution provenance or close other G-X rows. Protected reconnect, canonical Instagram metrics/calendar adoption, remaining journeys, workflow/verifier/bootstrap, independent reviews, migration-history recovery and the approved production observation sequence remain open. The [complete deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains **NO-GO**.

The actual local inventory rerun at documentation candidate `f2d904b73b70b384a7d535a54b8ca2e08933dc67` confirms that neither documentation path is missing anymore. Its only `required_source_missing` entries are `.github/workflows/instagram-migration-gate.yml` and `.github/CODEOWNERS`. The four historical migration-prefix incidents, absent external evidence and blocked activation/snapshot receipts still leave both local and release readiness false. The proof retains that report's separate candidate, failures and artifact hash.

No production setting, schema, runtime, credential, schedule, paid provider call or social content changed. No Edge Function redeployment is required for these test/fixture/documentation files. `mem0` is unavailable; the committed evidence preserves the continuation.
