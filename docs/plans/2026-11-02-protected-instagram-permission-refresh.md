# Complete the protected Page-linked permission read

This implements Task 2 of the existing [implementation plan](2026-10-26-instagram-insights-and-competitor-tracking.md) and the accepted generation-fenced `write_instagram_account_capability` SQL. It is not permission to deploy, reconnect a live account or activate collection. Required reading: `ARCHITECTURE.md` §§12–17, 22–26, 33, 36–39.

## Proven gap

The protected `instagram-business-oauth` selection commits through `commit_meta_oauth_selection`. The accepted SQL clears scopes to unknown and advances the capability generation, as it should. Unlike the legacy branch, the protected route performs no subsequent `/me/permissions` read. There is no production caller of `write_instagram_account_capability`. Discovery requires authoritative granted scopes before using a protected credential, so reconnect alone cannot establish that capability.

Keep the accepted SQL and the original OAuth transaction unchanged. After a protected Instagram Page-linked selection commits, resolve the server-only bound Facebook User credential and require its credential ID/revision, connection version and capability generation to match the committed receipt. Capture the generation and permission-read start time before the provider call. Never substitute a later generation when a response returns.

Read the complete `/me/permissions` response with bounded timeout, body size, rows/pages and trusted-host cursor reconstruction. Validate the entire response, including denial states. Only a complete successful read is authoritative: an empty granted set is a real denial, while HTTP/network/malformed/truncated reads are failures. Persist through the existing generation/timestamp-fenced writer; stale results must write nothing. A failed provider read can record its failed evidence without replacing a successful grant on the same generation, as the SQL already requires.

Return a safe additive permission outcome alongside the existing successful connection receipt. A denied or failed read must not imply that the already committed account save was rolled back or that insights are usable. Record a sanitized operational log; never serialize the credential, provider error body or request URL. Do not add a Page-token fallback, provider-token browser storage, collection admission or a retry of the commit.

## Ordered implementation

1. Add the protected Page-linked refresh use case beside `instagram-business-oauth`, reusing the protected credential reader, capability projection parser and protected HTTP boundary. Add only the bounded-body option needed by the new permission read to the existing HTTP primitive; retain previous callers' behavior.
2. Test complete grants/denials, real zero grants, partial/malformed/provider failure, receipt/binding mismatch, stale writer refusal and ambiguous database envelopes. Mock only HTTP/RPC boundaries. Existing real SQL suites remain authoritative for ownership, generation/timestamp races and failed-read preservation; do not replace those rules in TypeScript.
3. Wire the use case into the actual protected `store_ig_account` branch after the atomic commit and before its safe response. Verify operational logging and exact receipt/binding agreement. Keep direct-login and Facebook Page flows explicitly unaccepted until their applicable paths have evidence.
4. Extend the canonical fixture with the real registered OAuth route and synthetic Meta transport, then prove protected callback/picker/commit, generation/cache invalidation and official discovery in J2. The current signed return-origin policy prevents a complete loopback browser redirect; resolve that through the existing trusted application-origin boundary, never a blanket localhost/remote allowlist or a mocked report response.
5. Run affected Deno/SQL/route and canonical tests, guards, immutable lint/i18n and graph maintenance. Commit/push scoped inputs and update the NO-GO deployment package with the exact changed dependency closure. No production action is implied.

The complete analytics goal remains open until full G-X, canonical Instagram metric/calendar adoption, trusted release infrastructure, independent review, approved production reconciliation and scheduled observation are established.
