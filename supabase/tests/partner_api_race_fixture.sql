-- Committed fixture for the concurrency check. Separate from the main suite,
-- which rolls back.
INSERT INTO workspaces (id, owner_id, name, is_personal)
VALUES ('55555555-5555-5555-5555-555555555555',
        (SELECT id FROM auth.users LIMIT 1), 'ws-race', false)
ON CONFLICT DO NOTHING;

INSERT INTO social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id)
VALUES ('66666666-6666-6666-6666-666666666666',
        (SELECT id FROM auth.users LIMIT 1), 'whatsapp', '9999999999', 'tok',
        '55555555-5555-5555-5555-555555555555')
ON CONFLICT DO NOTHING;

INSERT INTO partner_api_keys (id, workspace_id, social_account_id, name, key_prefix,
                              key_hash, scopes, rate_limit_per_min, monthly_quota)
VALUES ('77777777-7777-7777-7777-777777777777',
        '55555555-5555-5555-5555-555555555555',
        '66666666-6666-6666-6666-666666666666',
        'race', 'pk_live_race', 'hash-race', ARRAY['whatsapp:template.send'], 1000, NULL)
ON CONFLICT DO NOTHING;
