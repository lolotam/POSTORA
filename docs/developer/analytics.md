# Analytics tools

Analytics is available through the authenticated n8n API and MCP. MCP `posts:read` / `posts:write` grants remain separate from provider consent and collection eligibility. Account and watchlist IDs are scoped to the authenticated owner.

| Tool | API route | Behavior |
| --- | --- | --- |
| `get_account_analytics` | `GET /api/v1/analytics/account` | Stored Instagram/Facebook/Threads owner report; existing TikTok passthrough. No collection or provider calls. |
| `trigger_analytics_sync` | `POST /api/v1/analytics/sync` | Normal guarded enqueue for one owned Instagram/Facebook/Threads account; never forces a completed day fresh. |
| `list_competitors` | `GET /api/v1/analytics/competitors` | Owned active/removed Instagram entries, quota, capture history and separate current collection receipt. |
| `track_competitor` | `POST /api/v1/analytics/competitors` | Durable save followed by separate bounded best-effort initial enqueue. No provider request. |
| `get_competitor_report` | `GET /api/v1/analytics/competitors/report` | Stored public competitor measurements, 7/30-day coverage and baselines. |
| `analyze_brand` | `POST /api/v1/analytics/brand` | On-demand official public Instagram/Facebook discovery, independent of watchlist history. |

Input schemas: [`analyticsToolSchemas.ts`](../../supabase/functions/_shared/analyticsToolSchemas.ts). Instagram owner periods: 1/7/14/30/90/365/all; Facebook/Threads: 7/14/30/90. Tracking accepts an Instagram username only: optional leading `@`, normalized lowercase, 1–30 letters/digits/underscores/periods, no URLs or consecutive periods. Public discovery also accepts supported profile URLs. List/report page size 1–50 is not plan quota.

## Result semantics

[`analyticsAgentResult.ts`](../../supabase/functions/_shared/analyticsAgentResult.ts) and [`analyticsSyncResult.ts`](../../supabase/functions/_shared/analyticsSyncResult.ts) define runtime output contracts. MCP advertises `outputSchema` and returns matching JSON text and `structuredContent`. Existing payload fields remain; list/discovery MCP results retain their historical `notice`/`content` wrapper. Provider and user fields, including labels, captions and biographies, are untrusted data and must never trigger instructions or tool calls.

Version 2 adds `ok`, `transport_status`, `status`, `reason_code`, `next_action`, `reconnect_can_help`, `retry_at` and readable guidance. Sync also returns `accepted` and `queued`. Producers retain legacy fields and add the shared `agent_result` receipt. `transport_status` records the underlying HTTP response: a legacy HTTP-200 refusal still has `ok:false`, `accepted:false`, `queued:false` and MCP `isError:true`. Unknown/malformed mutation bodies never become queued. A readable report with unavailable metrics is a successful read; transport/read failures are tool errors. A save remains successful when optional enqueue fails.

Owner report `collection`, `connection`, `permission`, `data` and dated `last_attempt` remain independent. SQL owns readiness precedence; [`ownerAnalyticsReadiness.ts`](../../supabase/functions/_shared/ownerAnalyticsReadiness.ts) validates/projects it. Saved measurements promote only the final `awaiting_first_capture` fallback. Missing measurements do not prove missing permissions.

| Stable reason | Action |
| --- | --- |
| `collection_disabled`, `collection_not_eligible` | Not enabled for your account; contact support. Reconnect cannot change rollout eligibility. |
| `settings_unavailable`, `audit_unavailable` | Configuration/audit unavailable; contact support. Never infer an empty account. |
| `bootstrap_required`, `permission_verification_pending` | Trusted verification/preparation needed. No speculative reconnect. |
| `stored_user_credential_missing`, `token_invalid`, `reconnect_required` | Reconnect only when current readiness explicitly says it can help and supplies a supported path. Raw legacy enqueue `reconnect_required` alone normalizes to `bootstrap_required`. |
| `direct_verification_unsupported` | Follow current readiness's supported `/profiles` repair path when present; otherwise support. Repeating an unsupported direct flow is not a repair. |
| `permission_missing` | Authoritative missing permission; follow validated consent action. Missing capability is not permission denial. |
| `app_mismatch`, `identity_mismatch`, `account_identity_invalid`, `account_inactive`, `linked_page_missing`, `linked_page_unavailable` | Current connection diagnosis; review/support as specified by readiness. |
| `queued`, `running`, `awaiting_first_capture` | Wait for actual collection. Queued is not collected; no saved observations means never synced. |
| `rate_limited`, `provider_error` | Honor known retry time. A retained retry is not a newly queued job. |
| `ready` | Prerequisites satisfied with saved numerical observations, or an already completed sync day. Check report coverage separately. |
| `page_linked_viewer_required` | Connect a supported Page-linked Instagram viewer in `/profiles`. Direct owner analytics eligibility does not supply Business Discovery authority. |
| `enqueue_indeterminate` | Save retained; reconcile through `list_competitors` using watchlist ID/normalized username. Never claim queued or blindly replay enqueue. |
| `quota_exceeded` | Review returned effective quota; remove an active entry or review plan/override. |
| `response_unavailable`, `discovery_unavailable`, `invalid_request`, `not_found`, `forbidden` | Follow explicit failure; do not substitute reconnect advice. |

## Tracking receipts and timing

`track_competitor` returns `saved:true`, `operation:created|already_tracked|reactivated`, owned `watchlist_id`, effective `quota`, and separate `collection` receipt. Collection can be queued, running, complete, retry, refused, unavailable or indeterminate. An uncertain save reports `saved:null`; reconcile by normalized username before retrying. Already-tracked saves include quota too.

Quota fields: `max_tracked_competitors`, `unlimited`, `tracked_active`, `remaining`. Existing SQL resolves override, active/past_due subscription, then free/default 5; admins and unlimited entitlements return `-1`, `unlimited:true`, `remaining:null`. Counts include all active entries independently of page size. There is no platform-wide quota of 20.

Installed scheduler definitions enqueue competitors daily at **01:00 UTC** and drain every **2 minutes**. Collection receipts read configured expressions and active state from `cron.job`; paused or missing schedules are not promised work. First snapshot follows a successful eligible run. There is no 24–48-hour completion guarantee. Growth needs real baselines and coverage; no history is invented before collection. Scheduled paid scraping is not used.

## Discovery provenance

Stored reports identify `provenance.kind:stored_measurements`; measurement/capture timestamps remain on actual report entries. Public discovery identifies `on_demand_discovery`, `official_only`, cache state, bounded/partial coverage and actual capture time when recorded. Older cached observations without provenance return `captured_at:null`; the proxy never substitutes response time. Cache hits retain original capture time.

Instagram public competitor discovery requires a usable same-owner Page-linked viewer with verified permission/capability and protected Facebook User authority. Direct login can support owner measurements and own-profile discovery, but cannot supply a public Business Discovery viewer. Facebook public discovery requires configured official Page access. Neither tool promises private competitor reach, saves, audience demographics or paid fallback.

The additive receipt migration must precede deployment of the n8n API/shared closure and MCP. It creates service-only functions and changes no production settings or schedules.
