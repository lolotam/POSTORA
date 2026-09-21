# Request inventory — `/dashboard`, cold load

Account: the admin account (`user_id` `7fe4d34e…`), 199 posts, 413 media files, 0 subscription rows.
Query strings are shown with the user id elided; authorization headers and API keys are never recorded here.

## A. Vite dev, `localhost:8080` → production Supabase, StrictMode on — before fixes

28 XHR/fetch on a cold (`ignoreCache`) load.

| # | Method | Endpoint | Note |
|---|---|---|---|
| 1–2 | GET | `rest/v1/app_settings?key=eq.dark_theme_variant` / `key=eq.app_theme` | two single-key reads |
| 3 | GET | `rest/v1/app_settings?key=in.(feature_*)` | feature flags |
| 4 | GET | `rest/v1/app_settings?key=in.(app_name,app_logo,app_favicon)` | branding |
| 5–7 | GET | `rest/v1/profiles?select=*` | **×3 identical** — F5 |
| 8 | POST | `rest/v1/rpc/get_user_role` | |
| 9 | GET | `rest/v1/app_settings?key=in.(feature_*)` | **repeat of #3** |
| 10 | POST | `functions/v1/check-subscription` | 2284 ms |
| 11–12 | GET | `user_credits`, `credit_transactions?limit=50` | |
| 13–14 | GET | `admin_notifications?select=*`, `blog_posts?select=*` | unbounded |
| 15–16 | GET | `social_accounts` (full), `social_accounts` (needs_reauth) | |
| 17 | GET | `rest/v1/posts?select=*&order=created_at.desc` | **199 rows / 244 KB** — F4 |
| 18 | GET | `rest/v1/posts?select=*&limit=3` | dashboard recent list |
| 19 | GET | `rest/v1/posts?select=status,scheduled_at` | stats |
| 20 | GET | `user_feature_overrides` | |
| 21–22 | GET | `admin_inbox_messages?limit=20`, `support_messages?limit=20` | admin-only |
| 23 | GET | `platform_posts?post_id=in.(3 ids)` | |
| 24 | GET | `user_notification_reads` | |
| 25–26 | POST | `functions/v1/messaging-api` (`list_conversations`, MESSENGER + INSTAGRAM) | **Meta Graph round trips** — F3, 706 ms upstream, empty result |
| 27 | GET | `user_blog_post_reads` | |
| 28 | GET | `user_subscriptions?limit=1` | |

### Idle behaviour, ~100 s, tab focused, before fixes

14 further requests with no user interaction:

| Endpoint | Count in ~100 s | Source |
|---|---|---|
| `functions/v1/messaging-api` | 5 | `NotificationBell` → `useConversations` (30 s) |
| `support_messages` | 3 | `useSupportMessageNotifications` (30 s) |
| `admin_inbox_messages` | 3 | `useAdminInbox` (10 s configured) |
| `functions/v1/check-subscription` | 1 | `useSubscription` (60 s) |
| `social_accounts` (needs_reauth) | 1 | `TokenReauthBanner` (60 s) |
| `user_subscriptions` | 1 | `useSubscription` (60 s) |

## B. `vite preview`, `localhost:4173` → production Supabase, no StrictMode — before fixes

26 XHR/fetch. The composition matches A except:

- `rest/v1/profiles?select=*` appears **twice**, not three times. The third call in dev is StrictMode's
  second effect mount; **two is the real production count**.
- `rest/v1/posts?select=*` (unbounded) is present.

## C. `vite preview`, `localhost:4173` → production Supabase, no StrictMode — after fixes

- `rest/v1/profiles` → **1 request**, `select=id,email,full_name,avatar_url,api_key,ai_model,…`
  (`api_key_hash`, `referral_code`, `referred_by`, `admin_notified_at` no longer transferred).
- `rest/v1/posts?select=*&order=created_at.desc` → replaced by
  `HEAD rest/v1/posts?select=id&status=in.(pending,scheduled)&scheduled_at=gt.<now>`
  with `Prefer: count=exact`; response `content-range: */0`, **zero-byte body**.
- No new console errors, warnings or issues on the route.

## D. Client-side navigation `/dashboard` → `/post`

Zero additional application requests in either build: React Query's 5-minute `staleTime` serves
`social_accounts`, `profiles`, feature flags and subscription from cache. `/post` also issues no media,
Library or Stock request until the user opens those panels — deferred loading here is correct and was
left alone.
