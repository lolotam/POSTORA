CREATE INDEX IF NOT EXISTS app_settings_n8n_webhook_key_idx
  ON app_settings (key)
  WHERE key LIKE 'n8n\_webhook\_%';
