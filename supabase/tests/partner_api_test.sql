-- Integration tests for the partner API database objects.
-- Run against a scratch database that has the partner API migration applied.
-- Any FAIL raises an exception and aborts the script.

CREATE OR REPLACE FUNCTION assert_eq(actual ANYELEMENT, expected ANYELEMENT, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL %: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok - %', label;
END; $fn$;

BEGIN;

-- Fixture: two workspaces, one WhatsApp account in workspace A, one key.
INSERT INTO workspaces (id, owner_id, name, is_personal) VALUES
  ('11111111-1111-1111-1111-111111111111', (SELECT id FROM auth.users LIMIT 1), 'ws-a', false),
  ('22222222-2222-2222-2222-222222222222', (SELECT id FROM auth.users LIMIT 1), 'ws-b', false);

INSERT INTO social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id)
VALUES ('33333333-3333-3333-3333-333333333333',
        (SELECT id FROM auth.users LIMIT 1), 'whatsapp', '1234567890', 'tok',
        '11111111-1111-1111-1111-111111111111');

INSERT INTO partner_api_keys (id, workspace_id, social_account_id, name, key_prefix, key_hash,
                              scopes, rate_limit_per_min, monthly_quota)
VALUES ('44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        'test', 'pk_live_test', 'hash-1', ARRAY['whatsapp:template.send'], 3, 2);

-- === Tenancy: the control the whole design rests on ===
DO $t$
BEGIN
  INSERT INTO partner_api_keys (workspace_id, social_account_id, name, key_prefix, key_hash)
  VALUES ('22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333', 'bad', 'pk_live_bad', 'hash-bad');
  RAISE EXCEPTION 'FAIL tenancy: a cross-workspace key was accepted';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'ok - cross-workspace key rejected by the database';
END $t$;

-- === Quota: reserve, exceed, release, lazy monthly reset ===
SELECT assert_eq((SELECT allowed FROM reserve_partner_quota('44444444-4444-4444-4444-444444444444')),
                 true, 'first reservation allowed');
SELECT assert_eq((SELECT allowed FROM reserve_partner_quota('44444444-4444-4444-4444-444444444444')),
                 true, 'second reservation allowed (quota = 2)');
SELECT assert_eq((SELECT allowed FROM reserve_partner_quota('44444444-4444-4444-4444-444444444444')),
                 false, 'third reservation refused');

-- The refused reservation above still incremented, so the caller releases it.
-- Without that release, repeated refusals inflate the count indefinitely.
SELECT assert_eq((SELECT current_usage_count FROM partner_api_keys
                   WHERE id = '44444444-4444-4444-4444-444444444444'),
                 3, 'a refused reservation still incremented, so it must be released');

SELECT release_partner_quota('44444444-4444-4444-4444-444444444444');
SELECT assert_eq((SELECT current_usage_count FROM partner_api_keys
                   WHERE id = '44444444-4444-4444-4444-444444444444'),
                 2, 'release refunds exactly one unit');

UPDATE partner_api_keys SET last_reset_at = date_trunc('month', now()) - INTERVAL '1 month'
 WHERE id = '44444444-4444-4444-4444-444444444444';
SELECT assert_eq((SELECT allowed FROM reserve_partner_quota('44444444-4444-4444-4444-444444444444')),
                 true, 'new month allows again');
SELECT assert_eq((SELECT current_usage_count FROM partner_api_keys
                   WHERE id = '44444444-4444-4444-4444-444444444444'),
                 1, 'new month resets the count to 1');

-- === Rate limit ===
SELECT assert_eq(consume_partner_rate('44444444-4444-4444-4444-444444444444', 3), true,  'rate 1 of 3');
SELECT assert_eq(consume_partner_rate('44444444-4444-4444-4444-444444444444', 3), true,  'rate 2 of 3');
SELECT assert_eq(consume_partner_rate('44444444-4444-4444-4444-444444444444', 3), true,  'rate 3 of 3');
SELECT assert_eq(consume_partner_rate('44444444-4444-4444-4444-444444444444', 3), false, 'rate 4 refused');

-- === Idempotency ===
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-a')),
                 'claimed', 'first claim wins');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-a')),
                 'in_progress', 'concurrent duplicate sees in_progress');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-DIFFERENT')),
                 'conflict', 'same key with a different body is a conflict');

UPDATE partner_api_idempotency
   SET state = 'completed', http_status = 200,
       response_body = '{"message_id":"wamid.X"}'::jsonb, locked_until = NULL
 WHERE key_id = '44444444-4444-4444-4444-444444444444' AND idempotency_key = 'idem-1';

SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-a')),
                 'replay', 'completed claim replays');
SELECT assert_eq((SELECT response_body->>'message_id' FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-a')),
                 'wamid.X', 'replay returns the stored response');

-- An indeterminate row must never hand out a fresh claim.
INSERT INTO partner_api_idempotency (key_id, idempotency_key, request_hash, state)
VALUES ('44444444-4444-4444-4444-444444444444', 'idem-2', 'hash-b', 'indeterminate');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-2', 'hash-b')),
                 'indeterminate', 'indeterminate never re-sends');

-- A crashed attempt must not wedge the key forever.
INSERT INTO partner_api_idempotency (key_id, idempotency_key, request_hash, state, locked_until)
VALUES ('44444444-4444-4444-4444-444444444444', 'idem-3', 'hash-c', 'processing',
        now() - INTERVAL '5 minutes');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-3', 'hash-c')),
                 'claimed', 'an expired lease is taken over');

-- === Fencing: a revived stale writer must not settle the new owner's attempt ===
-- This is the case a state predicate alone cannot catch, because a takeover
-- leaves state = 'processing'.
INSERT INTO partner_api_idempotency (key_id, idempotency_key, request_hash, state, locked_until)
VALUES ('44444444-4444-4444-4444-444444444444', 'idem-5', 'he', 'processing',
        now() - INTERVAL '5 minutes');

-- Capture the token the ORIGINAL (now stale) attempt held.
CREATE TEMP TABLE fence_probe AS
SELECT attempt_token AS stale_token FROM partner_api_idempotency
 WHERE key_id = '44444444-4444-4444-4444-444444444444' AND idempotency_key = 'idem-5';

-- A new caller takes over the expired lease and gets a fresh token.
CREATE TEMP TABLE fence_new AS
SELECT attempt_token AS new_token FROM claim_partner_idempotency(
  '44444444-4444-4444-4444-444444444444', 'idem-5', 'he');

SELECT assert_eq((SELECT stale_token FROM fence_probe) IS DISTINCT FROM
                 (SELECT new_token FROM fence_new),
                 true, 'a takeover mints a different attempt token');

-- The stale writer now tries to settle using its OLD token. It must affect
-- zero rows; otherwise it would overwrite the new owner's result.
WITH stale_settle AS (
  UPDATE partner_api_idempotency
     SET state = 'completed', http_status = 200,
         response_body = '{"message_id":"STALE"}'::jsonb
   WHERE key_id = '44444444-4444-4444-4444-444444444444'
     AND idempotency_key = 'idem-5'
     AND state = 'processing'
     AND attempt_token = (SELECT stale_token FROM fence_probe)
  RETURNING 1)
SELECT assert_eq((SELECT count(*)::INTEGER FROM stale_settle), 0,
                 'a stale writer cannot settle a taken-over attempt');

SELECT assert_eq((SELECT state FROM partner_api_idempotency
                   WHERE key_id = '44444444-4444-4444-4444-444444444444'
                     AND idempotency_key = 'idem-5'),
                 'processing', 'the new owner''s attempt is untouched');

-- Expired rows are pruned, not replayed as stale successes.
INSERT INTO partner_api_idempotency (key_id, idempotency_key, request_hash, state,
                                     http_status, response_body, expires_at)
VALUES ('44444444-4444-4444-4444-444444444444', 'idem-4', 'hash-d', 'completed',
        200, '{"message_id":"old"}'::jsonb, now() - INTERVAL '1 day');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-4', 'hash-d')),
                 'claimed', 'an expired row is pruned, not replayed');

ROLLBACK;
