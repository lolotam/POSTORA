# Review: Partner API v1 surface — security threat review (Phase 0, deliverable 0.9)

- **Date:** 2026-08-30
- **Owner:** the repository owner (Postora)
- **Status:** Recorded. Dispositions are inline. **Nothing was fixed as part of writing
  this review** — a finding with a disposition is the deliverable, per the 0C brief.

## Scope and method

This is a review of code, not a design document. Everything below was read before it
was written; every claim names the file it was checked against, with a line number
where it helps. Line numbers are as of branch `feat/partner-api-0c-groundwork` and
will drift on any edit above them.

Reviewed:

- `supabase/functions/partner-api/index.ts`, `router.ts`
- `supabase/functions/_shared/partnerApiKeys.ts`, `partnerApiMetering.ts`,
  `partnerApiIdempotency.ts`, `whatsappPartnerOps.ts`
- The five partner migrations:
  `20260813120000_partner_api_foundation.sql`,
  `20260830120000_partner_api_key_accounts.sql`,
  `20260830120100_partner_audit_logs.sql`,
  `20260830120200_partner_api_rate_limit_v2.sql`,
  `20260830120300_partner_api_least_privilege_grants.sql`
- `scripts/create-partner-key.ts` (the only key-creation path that exists)

Two scope limits, stated up front so nothing below overclaims:

1. **This reviews the checked-out branch, not the deployed container.** Per the
   implementation plan §0 ("Deployment state"), production `partner-api` is
   deliberately NOT redeployed and still runs the pre-PR-#70 code: the D7
   fail-closed limiter and the v2 header path described below are true of this
   branch and become true of production only after the documented redeploy.
2. **There are zero active partner keys.** The only key that ever existed
   (`pk_live_urCb…`) is revoked. Every post-authentication finding below is
   therefore gated on a future key existing; pre-authentication findings are
   reachable by anyone who can reach the endpoint, because the endpoint is public.

Severity vocabulary: High / Medium / Low / Informational. Dispositions: **accepted** /
**mitigated** / **deferred-with-condition** — a finding without one is not a review.

---

## 1. Credential handling (spec §9.4, §9.5, D8 posture)

**How a key is presented.** Solely the `x-postora-key` header
(`partner-api/index.ts:181`). It is never read from a URL, query string, or body —
grep of `index.ts` finds no other read. The CORS layer does not echo it
(`index.ts:35-43` allow-headers lists it, expose-headers does not).

**How it is stored and compared.** SHA-256 hex digest at rest
(`_shared/partnerApiKeys.ts:53-61`); the plaintext is printed once by
`scripts/create-partner-key.ts:90` and never stored. Authentication is a single
lookup by hash equality against `partner_api_keys.key_hash`
(`partnerApiKeys.ts:74-81`), backed by a partial unique index scoped to
non-revoked keys (foundation migration:54-55). Because the comparison is a database
index probe on a hash of a ~190-bit random string, not a byte-wise secret
comparison in application code, the classic string-comparison timing side channel
does not apply in any practical form; considered and accepted. Generation maps 32
random bytes through base62 with a modulo (`partnerApiKeys.ts:44-49`), which
introduces a slight per-character bias (256 % 62 = 8); the effective entropy is
≈5.950 vs 5.954 bits per character — **F1, Informational, reachable: yes (it is how
every future key is minted). Disposition: accepted** — brute force remains a
~2^190 search against a hash, and the prefix format makes offline guessing the only
avenue, which the entropy comfortably defeats.

**Revocation and expiry.** `revoked_at` and `expires_at` are checked on every
request (`partnerApiKeys.ts:87-92`) with distinct typed errors. Revocation is a
one-way door: `revoke_partner_key()` (foundation:340-361) refuses to act on an
already-revoked key, stamps the actor server-side, and is gated to workspace
owner/admin; no role holds `UPDATE` on the table (least-privilege
migration:46-58), so `revoked_at` cannot be cleared through any client path.
A malformed key and an unknown key return the same `invalid_key` 401
(`partnerApiKeys.ts:69-85`) — key guessing is non-enumerable. Distinct
`key_revoked` / `key_expired` codes post-authentication are fine: the presenter
already holds the key.

**What an attacker who obtains an active key can do, today:** authenticate as that
key; run `get_status` (no scope required — see §6 note) and `list_templates`
(requires `whatsapp:templates.read`, a Meta Graph read of the pinned WABA's
templates); attempt `send_template` and receive the 503 suspension. **What they
cannot do:** mint, rotate, or broaden any credential (no lifecycle surface exists
at all — §5); read `partner_api_keys` (anon holds nothing, and `key_hash` is not
selectable even by `authenticated`, foundation:329-334); reach any workspace other
than the key's own (§2); log anything as another tenant; use the key against any
URL (the only outbound destinations are fixed Graph API hosts, §4); or hold
ambient browser authority (the credential is a custom header — see the CORS
decision record).

**F2, Medium (operational, not a code defect), reachable: no (no keys exist).
Disposition: deferred-with-condition.** There is no credential lifecycle surface:
creation is an operator-run local script holding the service-role key
(`scripts/create-partner-key.ts:48-51`), rotation fields do not exist (plan §0,
1.3 not started), and revocation requires hand-issued SQL or an RPC with no UI.
The incident-response path for a leaked key is therefore manual. This is exactly
D12's gap, already scheduled as Phase 1 deliverable 1.3; the condition is that 1.3
lands before GA, as the plan already requires. Recorded here so the threat model
states it: until 1.3 exists, key compromise response time is bounded by operator
availability, not by product surface.

---

## 2. Tenancy (spec §9.1, D4)

Spec §9.1 requires tenancy proven in the database because a service-role client
bypasses RLS by design — and this function is service-role throughout
(`index.ts:139-143`). Verified per table:

| Table | Control | Where |
|---|---|---|
| `partner_api_keys` | composite FK `(social_account_id, workspace_id)` → `social_accounts (id, workspace_id)` | foundation:44-48 |
| `partner_api_key_accounts` | **both** composite FKs (account-in-workspace and key-in-workspace) | key_accounts migration:20-37 |
| `partner_api_usage` | composite FK `(key_id, workspace_id)` → `partner_api_keys (id, workspace_id)` | foundation:100-102 |
| `partner_audit_logs` | no FK on `key_id` (RESTRICT and CASCADE both rejected, reasons recorded in the migration:34-57); compensating control = BEFORE INSERT trigger asserting key∈workspace under `FOR KEY SHARE` + BEFORE UPDATE trigger making a key's workspace immutable | audit migration:91-141, 154-171 |
| `partner_api_idempotency` | plain FK on `key_id` only | foundation:60 |

The request path itself resolves the account by the key's pinned
`record.socialAccountId` through the service-role client (`index.ts:236-243`).
Stated plainly: **this read is safe only because the composite FK makes the
(key, workspace) pairing unrepresentable, not because of anything the code checks
at that point** — the code checks platform, `is_active`, and reauth state
(`index.ts:258-278`), which are health properties, not tenancy properties. This is
the correct layering per spec §9.1 and it holds today.

Downstream writes from a send (`whatsapp_messages`, `whatsapp_contacts`,
`messaging_cache` via `persistOutbound` / `upsertOutboundConversation`,
`whatsappPartnerOps.ts:300-412`) carry `user_id` / `workspace_id` derived from the
account row just read — i.e. from data already inside the key's tenancy boundary,
not from any caller-supplied field. No caller-supplied ID is trusted anywhere in
the alias: the body's only fields are `action`, `recipient_phone`, `template_name`,
`template_language`, `template_components` (spec §9.2 satisfied by construction —
the surface accepts no resource IDs at all).

**F3, Medium, reachable: no (no keys exist; nothing reads the table yet).
Disposition: deferred-with-condition.** `scripts/create-partner-key.ts` inserts
into `partner_api_keys` but does **not** write the `partner_api_key_accounts`
binding row (script:75-83; the migration's own comment at key_accounts:60-63
deferred that to "the credential-lifecycle path that creates keys" — which is this
script today, and it does not). A key minted by the script currently has its
primary account reachable only via the legacy `social_account_id` column. Nothing
reads the join table yet (the alias uses the pinned column, `index.ts:242`), so
there is no live impact — but any future D11 account-selection consumer would see
a key with zero bound accounts. Condition: Phase 1's 1.3 lifecycle writer must
write the binding, and the script should be fixed or retired in the same change.
Found while reviewing, written up rather than fixed, per the 0C brief.

---

## 3. Idempotency and quota under a hostile or buggy client (spec §10, D13)

The claim machinery is one RPC — insert-or-inspect under a row lock, stale-lease
takeover, expiry pruning, and a fencing token (foundation:206-291). Settles and
indeterminate marks are fenced on `attempt_token`
(`partnerApiIdempotency.ts:101-108, 133-136`), so a revived stale writer cannot
settle the new owner's attempt. Checked behaviours:

- **Replaying a completed request** returns the stored response with
  `Idempotency-Replayed: true`, unbilled (`index.ts:343-352`). The stored
  `response_body` contains only the normalized success/failure body (message id,
  state flags) — no secret material. Replays still pass the rate limiter
  (`index.ts:226` precedes the claim), so replay cannot be used to dodge
  throttling.
- **Racing duplicates** get `in_progress` 409 + `Retry-After: 2` while the lease
  (300s, `partnerApiIdempotency.ts:64`) is live (foundation:278-281).
- **Key-body mismatch** (`conflict`) never settles and returns 409
  (`index.ts:353-357`); the row keeps the original hash, so a hostile client
  cannot overwrite a hash, and after lease expiry a correct-hash retry takes over.
  Poisoning an idempotency key therefore self-heals within ≤300s. Validation runs
  **before** claiming (`index.ts:322-329`), so an invalid body cannot strand a
  claim in `processing` at all.
- **Abandoning** a request: a client disconnect does not stop the server work, so
  the only "abandonment" that matters is process death — which is D13, below.
- **Quota** is reserved before the send and released only on definite rejection
  (`index.ts:374-391, 449`); indeterminate outcomes keep the unit
  (`index.ts:429-448`), matching the "charged only for messages Meta accepted"
  contract. A refused reservation increments-then-decrements (net zero,
  `index.ts:384`) and settles 429 so a replay returns 429 rather than wedging.
  A hostile client cannot drive `current_usage_count` monotonically upward with
  rejected sends.

**F4, High if reachable; reachable today: no — blocked twice over.
Disposition: mitigated (suspension) and deferred-with-condition (the defect
itself).** The D13 duplicate-send window: process death between Meta accepting the
message and the durable settle leaves the row `processing`; its lease expires
(300s); a retry takes it over and sends a **second real message**
(foundation:283-289 has no dispatch-intent gate to stop it). This is the known,
recorded defect (decision `2026-08-30-suspend-send-template.md`; spec D13). Today
it is unreachable because (a) `send_template` is suspended in code
(`router.ts:54`, `index.ts:214-222`) and (b) zero keys exist — and the suspension
is deliberately not relied upon as the fix for anything else. Condition: the Phase
3 pre-call dispatch boundary, per the existing decision record. Restated here
only because a threat review that omitted its programme's largest known defect
would be dishonest.

**F5, Informational, reachable: yes (once keys exist). Disposition: accepted.**
`partner_api_idempotency` rows expire after 7 days but are pruned only
opportunistically, per key, on that key's next claim (foundation:228-230). Rows
belonging to keys that never send again linger indefinitely. Bounded by
sends-per-key; an operational housekeeping item, not an attack.

---

## 4. Outbound call surface (spec §9.7 — SSRF)

**No attacker-controlled URL exists in this surface.** The only outbound
destinations are `https://graph.facebook.com/v22.0/...` with paths built from
`ctx.phoneNumberId`, `wabaId` (read from the account's own
`account_metadata`/`platform_user_id` — database values, not request values;
`index.ts:285, 301`), and fixed literal path segments
(`whatsappPartnerOps.ts:5, 188, 251, 427`). Every call carries an explicit timeout
plus a bounded body read (30s/10s sends and register, 20s/10s template list —
`whatsappPartnerOps.ts:187, 196, 248-260, 265, 424-434`), satisfying
ARCHITECTURE.md §26 for what exists. The SSRF requirement of §9.7 attaches to
*webhook destinations*, which do not exist yet (§7) — nothing here implies that
coverage.

The Meta access token travels only in outbound `Authorization: Bearer` headers to
that fixed host (`whatsappPartnerOps.ts:190, 253-256, 430`) and is never returned
to callers: the handler builds its own response body (`index.ts:401-406`) and
deliberately drops `result.raw` (the comment at `whatsappPartnerOps.ts:29-34`
records this contract, and `index.ts` confirms it — `raw` is never referenced
there). Spec §9.4/§13 "returns raw third-party credentials" satisfied.

---

## 5. Rate limiting (spec D7, §3.3.2)

Risk classes are declared per action beside the scope map
(`router.ts:22-26`): `get_status` A, `list_templates` B, `send_template` C, with
prototype-chain-safe lookup so an unknown action resolves *unclassified*
(`router.ts:63-74`). On limiter failure, class A proceeds unthrottled and is
logged; everything else — including unclassified — fails closed with 503
`limiter_unavailable` + `Retry-After: 5`
(`partnerApiMetering.ts:151-168`, `index.ts:126`). A limiter outage now means:
reads work, template lists and sends refuse. **Verified in the branch; not yet in
production** (scope limit 1 above).

The limiter's verdict is trusted only in the exact shape `consume_partner_rate_v2`
produces; drift — null, wrong types, a bare v1 boolean, a multi-row result, or an
arithmetically impossible `remaining` — is treated as unavailable, and for B/C as
a refusal (`partnerApiMetering.ts:179-243`). The refusal path itself publishes no
invented numbers (`index.ts:100-113`). The bucket consume is one atomic statement
(v2 migration:28-62), not count-then-insert.

**F6, Low, reachable: yes (endpoint is public; no key needed). Disposition:
accepted, with a condition noted.** Everything before authentication is
unthrottled: each request with any garbage key costs one indexed DB lookup
(`partnerApiKeys.ts:74-81`) plus a UUID mint. There is no IP-level throttle in the
function and pre-auth failures write no ledger rows (`index.ts:468-493` return
without `finish`), so spraying invalid keys cannot grow `partner_api_usage` —
verified. This is the standard posture for a keyed API; the mitigation layer, if
ever needed, is gateway-side (Kong), which this repo does not control. Condition
attached: if partner-api is ever fronted by a public "try it" surface or sees
abuse, revisit at the gateway, not in the function.

**F7, Low, reachable: yes (once keys exist). Disposition: deferred.**
`partner_api_rate_buckets` grows one row per key per minute of active use and has
no pruning anywhere in the repo (grep across `supabase/` and `scripts/` finds only
schema definitions). Not a security defect and not exploitable beyond ordinary
use, but it is unbounded growth in a security-adjacent table; a pruning job or
TTL belongs in a later phase's operational work.

**F8, Low, reachable: yes. Disposition: accepted.** The request body is parsed
with an unbounded `req.json().catch(() => ({}))` (`index.ts:183`). No size limit
is enforced in code; whatever the Kong/edge-runtime body cap is, is what applies
(that cap is outside this repo and could not be verified from it). A huge body
costs CPU before failing closed at `unknown_action`. Consistent with every other
function in this codebase; noted so the reliance on the gateway cap is explicit
rather than silent.

---

## 6. Logging and redaction (spec §9.8) — checked, not assumed

Every `console.*` call in the reviewed surface was enumerated (there are sixteen;
`index.ts:389, 417, 442, 454, 495`; `partnerApiIdempotency.ts:114, 142`;
`partnerApiMetering.ts:49, 64, 163, 166, 195, 264, 266`;
`whatsappPartnerOps.ts:169, 325, 405`). What they log: fixed prefix strings,
`error.message` from Supabase/Meta failures, the request id, the limiter's
returned row `{allowed, remaining, reset_seconds}` (via `JSON.stringify`,
`partnerApiMetering.ts:195-198`), and — in one place — `keyPrefix`
(`index.ts:495`).

**Finding: I read the code and found no path that logs a key, a token, an
authorization header, or a message body.** Specifically: `x-postora-key` is read
once (`index.ts:181`) and never appears in any log statement; the Meta access
token exists only in `ctx.accessToken` and outbound headers; request bodies
(recipient phone, template components) appear in no `console.*` argument; the
error constructors (`PartnerAuthError`, `RateLimitedError`, `WhatsAppOpError`)
embed no key material in their messages (constructors checked:
`partnerApiKeys.ts:27-36, 111-118`; `partnerApiMetering.ts:111-118`;
`whatsappPartnerOps.ts:48-68`). The usage ledger stores `action`, `http_status`,
`error_code`, ids — no body, no key (`partnerApiMetering.ts:256-263`).

**F9, Informational, reachable: yes. Disposition: accepted.** `keyPrefix` (first
12 characters: the fixed `pk_live_` plus 4 body characters,
`partnerApiKeys.ts:50`) is logged on unhandled errors when a key resolved. This
is the identifier the database stores precisely so humans can discuss a key
without its secret; the 4 exposed body characters are an accepted, by-design
hint, matching how every major keyed API prints key prefixes.

**F10, Informational. Disposition: accepted, with the residual named.** The
unhandled-error log prints the whole `err` object (`index.ts:495`). Its safety
rests on what error constructors put in it — verified clean today — and on
PostgREST error bodies, which echo SQL diagnostics, not request payloads. If a
future error type starts carrying request material, this line would print it.
Residual accepted because the alternative (redaction middleware for one line)
adds more surface than it removes at current scale; ARCHITECTURE.md §17's
centralized-redactor direction applies if logging grows.

One scope note: `get_status` requires no scope (`router.ts:8`) and returns
`phone_number_id` and `workspace_id` (`index.ts:290-297`) to any valid key
regardless of its scopes. These are the workspace's own identifiers, disclosed
only to a credential already bound to that workspace — accepted, noted so the
no-scope map entry is a recorded fact rather than an accident.

---

## 7. What is not defended because it does not exist yet

Stated explicitly, so nothing above implies coverage:

- **Webhooks (spec §9.6, §9.7):** no `partner_webhooks`, no signing secrets, no
  delivery worker, no SSRF validation of destinations. The dormant scope
  `whatsapp:webhooks.manage` authorizes nothing in the alias — verified:
  `ACTION_SCOPES` (`router.ts:7-11`) maps no action to it, and `assertScope`
  (`partnerApiKeys.ts:107-117`) is an exact-match membership test with no
  wildcard expansion, so a legacy key holding it gains zero capability. This is
  the D3 property the plan tests in Phase 1; it holds in the code today.
- **Media (D10):** no upload endpoint, no scanning, no download URLs.
- **Publishing (D9):** no `/v1/posts`, no `PublishPort`.
- **Dispatch intents (D13):** no pre-call durable record — which is exactly why
  F4 is mitigated by suspension instead.
- **The `/v1` REST surface itself:** this entire review is of the frozen alias
  and its shared modules. When `/v1` routes appear they bring new authorization
  intersections (D11 account selection among bound accounts) that the
  single-pinned-account alias never exercises, and this review must be re-run
  against them, not inherited by them.

## Could not verify

- Production runtime state (deployed function version, Kong body-size caps,
  IP-throttling) — outside the repo; scope limit 1 records the known deploy gap.
- Live database constraint state — verified in migration files and the plan §0's
  `pg_constraint` evidence, not re-queried here.
- Log **sinks**: what this review proves is what the code emits. Whether the
  platform's log pipeline redacts further is a deployment property I did not
  inspect.

## Review condition

Re-run this review (not amend it) when any of: the `/v1` router lands (Phase 2),
`send_template` is restored (Phase 3 D13 gate — F4 flips from mitigated to
resolved-or-regressed), the credential lifecycle lands (Phase 1 — F2, F3 close),
or webhooks/media endpoints begin to exist (§7 items move into scope).
