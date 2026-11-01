# Threads: preserve credential and permission failures on server responses

## Proven failure and correction

The deployed `threads-insights/provider.ts` classified a parsed Meta error, then replaced its reason with `transient` whenever the HTTP status was 500 or greater. Consequently a structured code `190` credential failure or code `10`/`200` permission failure could lose its actionable reason. The legacy handler uses that reason for `needsReauth`/`needsPermission`; the versioned report maps it to canonical availability reasons.

Five regression steps through the real `ThreadsInsightsProvider` HTTP boundary failed before the correction: `503/190/463`, `502/190/467`, `500/190/0`, `503/10` and `503/200`. Each returned `transient` instead of its classified credential/permission reason.

The correction retains a recognized structured reason. Only an **unknown** 5xx error falls back to `transient`. HTTP `429` remains authoritative for throttling and parks subsequent calls at the observed retry deadline. Messages stay sanitized and legacy/versioned response shapes are unchanged.

## Validation and scope

- Exact Threads CI suite: **27 tests and 94 nested steps passed**, including the production composition's legacy/versioned handlers, provider transport, shared contract and calendar behavior.
- Provider fixtures cover existing 4xx classifications, structured credential/permission failures carried by 5xx, generic/unknown 5xx, malformed error envelopes, HTTP429 precedence, retry parking and secret redaction.
- Targeted ESLint, `git diff --check`, `clean-code-guard` and `test-guard` passed.

These are isolated fixture results, not deliberately expired/revoked live credentials or completed platform acceptance. No account, credential, collection control, schedule or migration changed. Runtime deployment and the final immutable lint/i18n result must be verified separately before claiming production behavior.
