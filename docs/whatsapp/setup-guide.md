# WhatsApp Setup Guide (self-hosted)

Everything required to make the WhatsApp mini-app work on a self-hosted Postora deployment: Meta App Dashboard configuration, edge-function secrets, and `app_settings` rows.

The in-app version of the Meta steps (with copy buttons and a live "Test connection" check) is available to admins on `/messaging/whatsapp/setup` → "Setup guide for admins" (`src/components/messaging/WhatsAppAdminSetupGuide.tsx`).

## 1. Meta App Dashboard

Prerequisites: a Meta app with the **WhatsApp** product and **Facebook Login for Business** added, owned by your Business Manager.

### 1.1 Facebook Login for Business → Settings

- Add your domains under **Allowed Domains for the JavaScript SDK**: `postora.cloud` (and any staging domains you use).
- Enable: Client OAuth login, Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Strict Mode for redirect URIs, Login with the JavaScript SDK.

### 1.2 Facebook Login for Business → Configurations

Create **two** configurations with the **WhatsApp Embedded Signup** login variation:

| Configuration | Product | Used for |
|---|---|---|
| Postora — Cloud API | WhatsApp Business Platform Cloud API | `cloud_api` mode (Postora fully controls the number) |
| Postora — Coexistence | WhatsApp Business App Onboarding | `coexistence` mode (number keeps working in the WhatsApp Business app) |

Copy each **Configuration ID** — they go into Postora app settings (section 3).

### 1.3 App Review → Permissions and Features

Request **Advanced Access** for:

- `whatsapp_business_messaging`
- `whatsapp_business_management`
- `business_management`

The app must also pass Meta's Tech Provider / Business verification requirements for Embedded Signup to onboard third-party numbers (see the error message surfaced by `whatsapp-config-test` if a Configuration ID cannot be read: it usually means the configuration belongs to a different Meta app than `FACEBOOK_APP_ID`).

### 1.4 WhatsApp → Configuration → Webhooks

- **Callback URL:** `https://api.postora.cloud/functions/v1/whatsapp-webhook` (replace the host with your own Kong gateway URL if different — it must resolve to the `whatsapp-webhook` edge function).
- **Verify token:** the value of your `WHATSAPP_WEBHOOK_VERIFY_TOKEN` secret. Meta sends a `GET` with `hub.mode`/`hub.verify_token`/`hub.challenge`; the function echoes the challenge when the token matches.
- **Subscribe to WhatsApp Business Account fields:**

| Field | Needed for |
|---|---|
| `messages` | Both modes — required. This is the only `change.field` the webhook processes for inbound messages. |
| `history` | Coexistence |
| `smb_app_state_sync` | Coexistence |
| `smb_message_echoes` | Coexistence |
| `account_update` | Recommended |

`whatsapp-oauth` also subscribes each connected WABA to the app at connect time via `POST /<WABA_ID>/subscribed_apps`, so per-WABA subscription does not need manual setup.

## 2. Edge-function secrets

Set these as Supabase edge-function secrets (self-hosted: in the functions container environment). Verified against the source of each function:

| Secret | Read by | Required? | Notes |
|---|---|---|---|
| `FACEBOOK_APP_ID` | `whatsapp-oauth`, `whatsapp-config-test` | Yes | Meta app ID that owns the Embedded Signup configurations. |
| `FACEBOOK_APP_SECRET` | `whatsapp-oauth`, `whatsapp-config-test`, `whatsapp-webhook` | Yes | Token exchange; last-resort webhook HMAC fallback. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | `whatsapp-webhook` | Yes | Must equal the verify token entered in the Meta webhook config. |
| `WHATSAPP_APP_SECRET` | `whatsapp-webhook` | Recommended | First choice for validating `X-Hub-Signature-256` on webhook POSTs. Falls back to `META_APP_SECRET`, then `FACEBOOK_APP_SECRET`. |
| `META_APP_SECRET` | `whatsapp-webhook` | Optional | HMAC fallback (see above). |
| `WHATSAPP_VERIFY_PIN` | `whatsapp-oauth`, `messaging-api` | Optional | Two-step PIN used when registering a phone in `cloud_api` mode. Defaults to `000000`. |
| `WHATSAPP_ACCESS_TOKEN` | `whatsapp-webhook`, `whatsapp-profile`, `whatsapp-broadcast`, `whatsapp-scheduled-sender`, `messaging-api` | Depends | Platform-level (System User) token. Used as the token for accounts without their own stored token; several paths currently rely on it (see `docs/whatsapp/` audit notes). |
| `WHATSAPP_PHONE_NUMBER_ID` | `whatsapp-profile`, `whatsapp-broadcast`, `messaging-api` | Optional | Fallback phone number ID when an account doesn't carry one. |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | `messaging-api` | Optional | Fallback WABA ID (template listing etc.). |

All functions also use the standard `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`.

## 3. `app_settings` rows (SQL)

Feature flags (read by `src/hooks/useFeatureFlags.tsx`) and the Embedded Signup Configuration IDs live in the `app_settings` table. Run in the SQL editor:

```sql
-- Feature flags
INSERT INTO app_settings (key, value)
VALUES
  ('feature_msg_whatsapp',        'true'::jsonb),  -- WhatsApp mini-app at /messaging/whatsapp
  ('feature_tab_whatsapp',        'true'::jsonb),  -- WhatsApp tab in the post composer
  ('feature_wa_cloud_api_enabled','true'::jsonb),  -- allow cloud_api connection mode (server-enforced in whatsapp-oauth)
  ('feature_whatsapp_shop',       'true'::jsonb),  -- WhatsApp Shop page (/whatsapp-shop)
  ('feature_human_agent',         'true'::jsonb)   -- human-agent queue
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Embedded Signup Configuration IDs (from Meta step 1.2)
INSERT INTO app_settings (key, value)
VALUES
  ('META_WHATSAPP_CONFIG_ID',             '"<cloud-api-configuration-id>"'::jsonb),
  ('META_WHATSAPP_COEXISTENCE_CONFIG_ID', '"<coexistence-configuration-id>"'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

The Configuration IDs can also be set from the UI at `/admin/settings`, and validated with the **Test connection** button in the admin setup guide (calls `whatsapp-config-test`, which reads each ID from `app_settings` and queries Meta with `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`).

## 4. What happens on connect (`whatsapp-oauth`)

1. The Setup page launches Meta Embedded Signup with the Configuration ID for the chosen mode; Meta returns a `code` plus `waba_id` / `phone_number_id`.
2. `whatsapp-oauth` exchanges the code for an access token using `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`.
3. For `cloud_api` mode it first checks the `feature_wa_cloud_api_enabled` flag in `app_settings` (server-side enforcement — disabling the flag blocks cloud_api connects even if the UI shows it).
4. It subscribes the WABA to the app's webhooks (`POST /<WABA_ID>/subscribed_apps`).
5. `cloud_api` only: it registers the phone number (`POST /<PHONE_ID>/register`) with `WHATSAPP_VERIFY_PIN` (default `000000`). Result is stored as `registration_status`: `registered`, `skipped_coexistence`, or `failed`.
6. It upserts a `social_accounts` row (`platform = 'whatsapp'`) with `account_metadata` containing `waba_id`, `phone_number_id`, `connection_mode`, `registration_status`, and `subscribed`.

Common failure: Meta error **2388001** during registration — the number has two-step verification enabled in the WhatsApp Business app; disable it there, then reconnect. Note: `whatsapp-oauth` records a failed registration as `registration_status: "failed"` without surfacing the code; the friendly 2388001 message comes from the re-register path in `messaging-api` (used by Setup diagnostics).

## 5. Deploying edge functions

The self-hosted stack does not pick up `supabase/functions/` changes from git. Copy changed function files into the Dokploy functions volume and restart the `functions` service — full steps in [`docs/runbooks/deploy-edge-function.md`](../runbooks/deploy-edge-function.md).
