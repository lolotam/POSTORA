-- Clear needs_reauth on Meta accounts that were flagged only because the platform
-- does not issue an OAuth refresh token.
--
-- refresh-tokens used to treat a null refresh_token as a refresh failure. Facebook,
-- Instagram and Threads never have one: they exchange their long-lived access token in
-- place (fb_exchange_token / ig_refresh_token / th_refresh_token). Those accounts were
-- healthy, but the cron filters flagged rows out, so nothing could ever un-flag them --
-- and because they were skipped, their tokens were never extended and eventually
-- expired for real.
--
-- Scoped deliberately narrowly: only rows carrying that exact error string, only the
-- three exchange-only platforms, and only where the token has NOT actually expired.
-- The accounts whose tokens ran out while mis-flagged genuinely need a user reconnect
-- now, and must stay red.

update public.social_accounts
set needs_reauth = false,
    failure_count = 0,
    last_refresh_error = null,
    last_alert_sent_at = null,
    updated_at = now()
where needs_reauth = true
  and is_active = true
  and platform in ('facebook', 'instagram', 'threads')
  and last_refresh_error = 'No refresh token available'
  and token_expires_at is not null
  and token_expires_at > now();
