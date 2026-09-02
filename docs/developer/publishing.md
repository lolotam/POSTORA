# Publishing

## Posts — only API-created posts are addressable

`POST /v1/posts` creates a post for explicit `targets: [acc_…]` (one workspace, non-empty, no WhatsApp targets). Optional `scheduled_at` must be ISO-8601 with explicit offset. Quota may refuse with `quota_exceeded`. Requires `Idempotency-Key`. Scope `posts:write`.

A post created in the Postora UI answers `resource_not_found` on every `/v1/posts` route, permanently and by design (`docs/decisions/2026-09-02-phase8-posts-scheduling.md` Decision A).

- `GET /v1/posts/{id}` — fetch the post. Scope `posts:read`.
- `GET /v1/posts/{id}/status` — per-target `platform_posts` rows with `provider_post_id`/`provider_post_url`. Scope `posts:read`.
- `POST /v1/posts/{id}/schedule` — set `scheduled_at` (pending or scheduled only). Scope `posts:schedule`.
- `DELETE /v1/posts/{id}/schedule` — clear schedule, parks as `pending`. Scope `posts:schedule`.

There is no `POST /v1/posts/{id}/publish` yet. Publish by scheduling; `process-scheduled-posts` picks up rows matching `status IN ('pending','scheduled') AND scheduled_at IS NOT NULL AND scheduled_at <= now()` and publishes them.

## Events

`post.scheduled` is certified and emitted by a database trigger for every schedule writer (`docs/decisions/2026-09-02-phase8-posts-scheduling.md`). `post.published`/`post.failed` have a live producer but remain uncertified until observed in production. Unschedule emits no event.

Reference: `supabase/functions/partner-api/v1/posts.ts`, `docs/api/openapi.yaml` paths `/v1/posts`.
