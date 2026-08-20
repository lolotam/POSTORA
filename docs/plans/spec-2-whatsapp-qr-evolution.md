# TASK: Implement WhatsApp 3rd Connection Mode (Direct QR Connect via Evolution API v2) with Risk Disclaimers

## Objective

Add a 3rd WhatsApp connection method to Postora alongside Official Cloud API and Coexistence Mode:
**"Direct QR Connect (Beta / Unofficial Web Connection)"**.

This method uses a dedicated **Evolution API v2** microservice running in Docker on our Contabo
server to handle Baileys WebSockets, session persistence, QR generation, and message webhooks.
Postora acts as the frontend, auth layer, database registry, and n8n dispatcher.

## Architecture & Component Breakdown

### 1. Infrastructure (Dokploy on Contabo VPS)

Deploy Evolution API v2 as a Dokploy Docker Compose stack connected to Postgres and Redis:

- **Service Name:** `evolution-api` (Image: `atendai/evolution-api:v2.2.0`)
- **Internal/External URL:** `https://wa-engine.postora.cloud` (or internal network proxy)
- **Database:** PostgreSQL for auth sessions and instance metadata
- **Cache:** Redis for high-speed socket events and QR cache
- **Global API Key:** Stored securely in Dokploy/Supabase secrets (`EVOLUTION_API_KEY`)

```yaml
version: '3.8'
services:
  evolution-api:
    image: atendai/evolution-api:v2.2.0
    container_name: evolution_api
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - SERVER_URL=https://wa-engine.postora.cloud
      - CORS_ORIGIN=*
      - CORS_METHODS=GET,POST,PUT,DELETE,OPTIONS
      - AUTHENTICATION_API_KEY=${EVOLUTION_GLOBAL_KEY}
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/evolution_db
      - CACHE_REDIS_ENABLED=true
      - CACHE_REDIS_URI=redis://:${REDIS_PASSWORD}@redis:6379/2
      - WEBHOOK_GLOBAL_ENABLED=false
      - DEL_INSTANCE=true
    volumes:
      - evolution_instances:/evolution/instances
    networks:
      - dokploy-network
volumes:
  evolution_instances:
networks:
  dokploy-network:
    external: true
```

### 2. Database Schema Updates (`supabase/migrations/`)

Extend `social_accounts` to natively support the Evolution API instance type:

1. `platform`: `'whatsapp'`
2. `connection_mode`: ENUM or TEXT check: `'cloud_api' | 'coexistence' | 'evolution_qr'`
3. `account_metadata`: JSONB containing:
   - `instance_name`: e.g. `postora_user_<userId>_<accountId>`
   - `instance_id`: UUID
   - `evolution_token`: Instance-specific auth token
   - `risk_consent_accepted_at`: ISO timestamp (Legal audit trail)
   - `risk_consent_user_ip`: IP address of user when accepting terms
   - `phone_number`: Cleaned international MSISDN
4. `is_active`: Boolean status reflecting live socket connectivity

Migration (`supabase/migrations/20260820_evolution_qr_support.sql`):

```sql
-- Add connection_mode column to social_accounts if not present
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'social_accounts' AND column_name = 'connection_mode'
  ) THEN
    ALTER TABLE social_accounts ADD COLUMN connection_mode TEXT DEFAULT 'cloud_api';
  END IF;
END $$;

-- Index for querying active evolution accounts
CREATE INDEX IF NOT EXISTS idx_social_accounts_evolution
ON social_accounts (user_id, platform, connection_mode)
WHERE platform = 'whatsapp' AND connection_mode = 'evolution_qr';
```

### 3. Backend Bridge (`supabase/functions/whatsapp-evolution-bridge/` & `messaging-api`)

Create/extend edge functions to manage Evolution API instances:

- **`ACTION: qr_create_instance`**
  - Validates user quota for social accounts.
  - Calls Evolution API: `POST /instance/create` with unique `instanceName`, webhook URL pointing to
    Postora, and auto-generated API key.
  - Returns instance details.
- **`ACTION: qr_get_code`**
  - Calls Evolution API: `GET /instance/connect/{instanceName}`.
  - Returns the base64 QR code and pairing code.
- **`ACTION: qr_disconnect_instance`**
  - Calls Evolution API: `DELETE /instance/logout/{instanceName}` and
    `DELETE /instance/delete/{instanceName}`.
  - Marks `social_accounts.is_active = false`.
- **`ACTION: qr_send_message` / `qr_send_media`**
  - Routes outbound messages to Evolution API: `POST /message/sendText/{instanceName}` and
    `POST /message/sendMedia/{instanceName}`.
  - Saves outbound message in `whatsapp_messages` and updates `messaging_cache`.

Directory layout:

```
supabase/functions/whatsapp-evolution-bridge/
├── index.ts                 # Main request router and authorization
├── _shared/evolutionApi.ts  # Typed client for Evolution API v2 endpoints
└── deno.json
```

Key actions supported:

1. `create_and_get_qr`: Calls Evolution API `/instance/create`, sets instance webhooks pointing to
   `whatsapp-evolution-webhook`, and fetches initial QR.
2. `get_qr_status`: Fetches updated QR code or connection state (`open`, `connecting`, `close`).
3. `logout_instance`: Cleanly removes linked device from Evolution API and updates DB.

### 4. Inbound Webhook Listener (`supabase/functions/whatsapp-evolution-webhook/`)

1. Validates `apikey` header from Evolution API.
2. Accepts verified webhook events from Evolution API:
   - `MESSAGES_UPSERT` (Inbound customer messages):
     - Filters out `fromMe: true` (anti-echo loop).
     - Extracts sender name, sender phone, text, and media URLs.
     - Inserts row into `whatsapp_messages`.
     - Upserts `messaging_cache` (incrementing unread counter).
     - Asynchronously triggers user's registered n8n webhooks (`message.received`,
       `message.whatsapp`).
   - `CONNECTION_UPDATE` (Socket state: `open`, `connecting`, `close`):
     - Updates `social_accounts.is_active` in real-time.
   - `QRCODE_UPDATED` (New QR generated).

### 5. Frontend UI: Connection Modal & Risk Acceptance (`src/components/`)

1. **Connection Method Selection Screen (`WhatsAppConnectModal.tsx`)**
   - **Option 1: Official Cloud API** (Recommended / Enterprise / Verified)
   - **Option 2: Coexistence Mode** (Meta Facebook Login)
   - **Option 3: Direct QR Connect** (Beta / Unofficial Web Connection)

2. **Mandatory Risk & Responsibility Disclaimer Dialog**
   - When Option 3 is clicked, open a non-bypassable modal containing:
     - **Clear Risk Warning**: Informs the user that this method uses an unofficial WhatsApp Web
       protocol and that Meta may suspend or ban numbers used for unsolicited bulk messaging or spam.
     - **Mandatory Acceptance Checkbox**: *"I understand the risks of unofficial WhatsApp Web
       connections and accept full responsibility for my phone number and messaging practices."*
     - **"Proceed to QR Scan"** button remains disabled until the box is checked.

3. **Live QR Code Scanner Screen**
   - Displays real-time 512px QR Code with a 45-second countdown timer.
   - "Refresh QR Code" button.
   - Polling / Supabase Realtime listener on connection status.
   - Instructions on opening WhatsApp -> Linked Devices -> Scan.
   - Success animation once connected.

Frontend code locations:

- `src/components/messaging/WhatsAppConnectModal.tsx`: Updated with 3-tab / card selection.
- `src/components/messaging/WhatsAppQrDisclaimerDialog.tsx`: New disclaimer dialog with strict
  validation.
- `src/components/messaging/WhatsAppQrScanner.tsx`: Auto-refreshing QR canvas with countdown and
  success listener.

### 6. n8n Community Node Bridge Compatibility

The existing `PostoraTrigger` and `Postora.node.ts` message actions will seamlessly work with
QR-connected accounts:

- Inbound messages from Evolution API produce the exact same standardized `message.received` schema
  in n8n.
- Outbound replies routed to `POST /api/v1/messages/reply` check `social_accounts.connection_mode`:
  - If `connection_mode === 'evolution_qr'` -> Dispatches via Evolution API REST bridge.
  - If `connection_mode === 'cloud_api'` -> Dispatches via Meta Graph API.
- **Zero changes required in the user's n8n workflow logic.**

## Production & Security Requirements

1. **No Raw Baileys in Core Repo**: Postora must remain a clean API consumer; all WebSocket
   complexities stay isolated inside the Evolution API Docker container.
2. **Secret Isolation**: Store `EVOLUTION_API_URL` and `EVOLUTION_API_KEY` in Supabase Secrets /
   `.env`.
3. **Audit Logging**: Store timestamp and user ID of the disclaimer acceptance in `account_metadata`
   for liability protection.
4. **Clean Code Guard**: Run unit tests, linting, and verify hash deployments before submitting.

## Verification Plan

1. **Docker Container Smoke Test**
   - Verify `curl -H "apikey: $KEY" https://wa-engine.postora.cloud/instance/fetchInstances` returns
     `200 OK`.
2. **QR Pairing Test**
   - Open Postora UI -> Select QR Connect -> Accept disclaimer -> Scan QR with test phone.
   - Confirm status changes to `Connected` (`is_active = true`).
3. **Two-Way Messaging & n8n Test**
   - Send message from external phone to test number -> Verify message arrives in Postora Inbox and
     triggers n8n workflow.
   - Send reply from n8n / Postora -> Verify message delivers to external phone in < 2 seconds.
4. **Disclaimer Audit Log Verification**
   - Verify `social_accounts.account_metadata` has valid `risk_consent_accepted_at` timestamp.
