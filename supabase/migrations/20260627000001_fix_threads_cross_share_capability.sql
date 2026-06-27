-- Fix: Update canCrossShareToIg for Threads accounts that have the scope
-- in granted_scopes but have null capability due to the old probe logic bug.

-- Set true for accounts that have the scope granted
UPDATE social_accounts
SET account_metadata = jsonb_set(
    account_metadata,
    '{capabilities,canCrossShareToIg}',
    'true'::jsonb
)
WHERE platform = 'threads'
  AND is_active = true
  AND (account_metadata->'granted_scopes') @> '["threads_share_to_instagram"]'::jsonb
  AND (account_metadata->'capabilities'->>'canCrossShareToIg') IS NULL;

-- Set false for accounts that have a non-empty granted_scopes but DON'T have the scope
UPDATE social_accounts
SET account_metadata = jsonb_set(
    account_metadata,
    '{capabilities,canCrossShareToIg}',
    'false'::jsonb
)
WHERE platform = 'threads'
  AND is_active = true
  AND account_metadata ? 'granted_scopes'
  AND jsonb_array_length(account_metadata->'granted_scopes') > 0
  AND NOT (account_metadata->'granted_scopes') @> '["threads_share_to_instagram"]'::jsonb
  AND (account_metadata->'capabilities'->>'canCrossShareToIg') IS NULL;
