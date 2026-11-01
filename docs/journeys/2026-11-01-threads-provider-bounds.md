# Threads insights provider bounds and failure handling

Scope: the provider-work portion of [Meta analytics plan B3](../plans/2026-11-01-meta-analytics-completion.md#b3-threads-live-path-correctness), following the account-selection repair in [PR #334](https://github.com/lolotam/POSTORA/pull/334). This is not complete B3 acceptance or live capability evidence.

## Proven defects

The existing registered endpoint made identity, three profile, listing and per-post requests without timeouts. Up to 25 post insight calls ran sequentially, despite the service proxy's 45-second timeout. Failed body decoding could become an empty successful metric list, and raw provider error messages could reach the response/log. The preflight also substituted the token's returned identity for the account's stored platform identity.

The correction introduces `threads-insights/provider.ts`, consumed by the actual endpoint. Every provider request uses the fixed `graph.threads.net/v1.0` origin, an Authorization bearer header and redirect refusal. Meta's [official Threads Postman collection](https://www.postman.com/meta/threads/collection/dht3nzz/threads-api) documents inherited OAuth 2.0 authorization; this is protocol evidence, not a successful live call from this account.

## Implemented behavior

- A shared per-request provider budget admits at most 32 calls and no provider work beyond 30 seconds from handler entry. Every provider fetch/body operation has at most four seconds, shortened to the remaining budget. There are no retries. Authentication and database/logging calls are outside the new provider transport; this is not a measured end-to-end 30-second HTTP guarantee.
- Fetch and body waits resolve on cancellation/deadline even if an injected transport ignores `AbortSignal`; native fetch receives the same signal. Bodies are bounded to one MiB and runtime schemas validate identity, metric and post payloads.
- Invalid/oversized/missing bodies, malformed error envelopes and failed streams remain explicit failed reads. Genuine numeric zero and all returned time-series points survive provider decoding. No provider secret, raw error message or credential-bearing request URL is returned or copied to audit metadata.
- Post insights use at most three concurrent requests and retain listing order. One aggregate audit records post failures instead of performing a serial audit write for every failed post.
- `429`, numeric rate-limit errors and `Retry-After` park subsequent provider calls in the same request. Numeric and HTTP-date backoff are recognized; an invalid JSON/error body cannot erase an authoritative HTTP 429. Already in-flight requests are not retroactively counted as new admissions.
- The preflight identity must match the selected account's stored platform identity. A mismatch refuses work instead of changing the target. The real composition regression proves no profile/post calls follow it.
- Existing legacy numeric response fields remain compatible. Additive `partial` and `retryAt` metadata expose failed comparison, series, listing or post reads. Arabic/English UI text distinguishes expired connections, identity mismatch, throttling and transient failure without displaying raw provider messages.

Runtime chain: `threads-insights/index.ts` registers `handler`; the handler constructs `ThreadsInsightsProvider`, calls identity/profile/listing methods and `loadPostMetrics`; each post worker calls `postInsights` through the same budget. The new module is exercised by production callers, not solely by its tests. Ownership/authentication remain in the existing composition path. No schema, RLS grant, credential store, collection switch or schedule changed.

## Executed checks and remaining work

The focused Deno run passed 11 tests with 36 nested scenario steps: ten provider tests and the real composition suite's 24 steps. It covers malformed/oversized bodies, uncooperative fetch/stream deadlines, pre-abort and abort-during-fetch races, expired/exhausted budgets, fixed origin/header/redirect behavior, credentials/permissions/server failures, numeric/date throttling, failed streams, concurrency/order, identity mismatch, failed previous reads and partial per-post failure. Nine component tests passed using the real translator in Arabic and English. Targeted ESLint and diff validation passed.

Provider responses remain synthetic; no real Meta account was probed. The existing 25-post legacy listing and numeric missing-value projection remain in place. Closed provider-calendar windows, durable per-metric provenance, the complete shared registry/contract, explicit `analyticsContractVersion: 1` negotiation, opaque continuation pagination and UI adoption remain open under B1–B5/C4–C5. `partial` does not certify metric completeness or turn legacy placeholders into valid observations. This correction does not authorize rollout or establish the seven-day stability gate. Deployment follows the reviewed-candidate workflow; no production deployment occurred during authoring.
