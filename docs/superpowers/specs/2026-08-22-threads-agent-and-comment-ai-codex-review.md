# Adversarial review

## P0 — Must fix before implementation

1. **The idempotency claim cannot prevent duplicate public replies as specified.** “Inbox insert is the claim” only works with a unique stable Meta event/comment ID and only if automation runs when the insert created a row. The shown flow records, then continues; concurrent deliveries can both proceed. Define the key, `ON CONFLICT` contract, and concurrency tests. Persist automation state (`claimed/sending/sent/failed`) and the platform reply ID; a send timeout is ambiguous and HTTP 200 does not resolve it.

2. **Cooldown and cap enforcement remain check-then-send races.** Two isolates can see no usage/log, invoke the LLM, and post. A burst can exceed the daily cap. Usage written after sending is audit data, not a lock. Atomically reserve before LLM work using the inbound event, account/day counter, and cooldown key; finalize after delivery and define stale-reservation recovery.

3. **D2 creates cross-post context leakage.** A per-account/per-commenter `conversation_id` feeds history from unrelated posts into a new public reply. The model can mention prior context in front of a different audience, and usernames are mutable/non-unique fallback identities. Use `(social_account, post/thread root, stable author ID)` for history and cooldown. Enforce the spend cap independently at `(social_account, day)` rather than distorting conversation identity. If Threads supplies no stable author ID, treat username-based continuity as explicitly lower-trust and bounded to the thread root.

4. **Authorization/tenancy of the new sender is absent.** `comment_id` makes the endpoint a public-post primitive. Derive the account from a trusted event, verify tenant and comment ownership/platform, and ignore caller-supplied identity. Define allowed principals and reject normal user JWTs unless authorized. `loadAccount(admin, request)` is not a tenancy boundary.

5. **Threads cannot ship while `replies` is unsubscribed.** Mentions do not cover ordinary replies. Make Dashboard subscription and a real signed-webhook canary a release gate before exposing “internal,” proving one claim and one successful publish.

## P1 — Should fix

6. **D4 is actively wrong: DM rules must not silently become public-comment rules.** Away-first precedence will publicly spam generic closure messages and suppress a more relevant keyword rule. Release notes do not make this safe. Add an explicit surface/scope (or separate comment-rule table), default existing rows to DM-only, require users to opt rules into comments, and define deterministic priority among multiple matching rows; the table has no uniqueness constraint, so database row order cannot decide the winner.

7. **D3’s string-prefix accounting is brittle.** Encoding account identity in `conversation_id` creates an implicit schema and `LIKE` hazards. It does not define whether errors, reservations, or only sent rows consume cap. Add `social_account_id` and `surface` (or an atomic usage table), constrain tenant/platform, and define same-platform multi-account cap behavior.

8. **Failure precedence can permanently discard comments.** A failed matched rule is claimed, but no retry, dead letter, or replay exists. Classify permanent versus transient Meta failures, retry transient ones idempotently, and surface exhaustion. Matcher exceptions should fail closed; falling through to AI spends money and posts during configuration failure.

9. **Public-content safety is missing.** A prompt sentence is not a control against prompt injection, harassment, secrets/PII disclosure, or replying to deleted/hidden comments. Add input/output moderation policy, maximum input/output sizes, link/mention policy, language handling, and a final pre-send check that the comment/account is still eligible. On Threads, “move to DMs” must not imply that the platform supports a DM channel.

## P2 — Nit

10. **Synthetic success IDs hide observability defects.** `ai_${Date.now()}` can collide and falsely suggests a platform delivery identifier. Store a nullable platform ID plus an internal UUID, and treat a successful response missing the expected Meta ID as a telemetry warning.
