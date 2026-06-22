> **⚠️ Self-hosted migration notice (2026-06):** This project now runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference below to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

# Lovable Development Connection & Migration Instructions

> **IMPORTANT:** The database and backend hosting for Postora have been migrated from Supabase Cloud (`efruibswazzuuupgyzmf.supabase.co`) to a **self-hosted Supabase instance** running on a private VPS.

---

## 1. Connection Details Overview

Lovable and local development environments must connect to the self-hosted Kong API gateway instead of Supabase Cloud.

- **Main API Endpoint (Kong Gateway):** `https://api.postora.cloud` (or fallback `https://supabase.postora.cloud`)
- **Supabase Studio Dashboard:** Accessible at `https://api.postora.cloud`
- **Deployment Host:** Contabo VPS `86.48.2.205` managed via Dokploy

---

## 2. Setting Up Your Local `.env` File

To connect your local development server or the Lovable environment to the self-hosted Supabase database, create a `.env` file in the root directory (copy from `.env.example`) and fill in the following variables:

```env
# Self-Hosted Supabase Connection URL (pointing to the Kong gateway)
VITE_SUPABASE_URL="https://api.postora.cloud"

# Self-Hosted Supabase Publishable (Anon) Key 
# This key is required to authorize requests through Kong.
VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVmcnVpYnN3YXp6dXV1cGd5em1mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcyOTE4NjgsImV4cCI6MjA4Mjg2Nzg2OH0.A591L2M5dMAaVm-W-DZYg5wsvtVp9qkzTrzWsRolRDA"

# Supabase Project/Ref ID (used internally by CLI and config paths)
VITE_SUPABASE_PROJECT_ID="efruibswazzuuupgyzmf"

# Stripe Publishable Key for Subscription/Billing flow
VITE_STRIPE_PUBLISHABLE_KEY="pk_test_51SouyCFgUZa0JWcAlQ5gQmsSs6T66zpBmHH32XUmqrJPsADs0XREuFECFCB2n3LaCzt2Z15wZIbA9ZuOLfJWnW6900zBUNOOpD"
```

> [!TIP]
> Keep the `VITE_SUPABASE_PROJECT_ID` as `efruibswazzuuupgyzmf` because it is still used by the CLI configurations (`supabase/config.toml`) and directory mappings in the self-hosted Docker compose stack.

---

## 3. How the Self-Hosted Supabase Stack Works

The self-hosted architecture runs as a Docker Swarm stack under **Dokploy** on the Contabo host server:

1. **Kong Gateway:** Listens to incoming requests on `https://api.postora.cloud` and routes them to Auth (`/auth`), Database REST API (`/rest`), Storage (`/storage`), and Edge Functions (`/functions/v1`).
2. **Database:** Standard PostgreSQL instance with Row Level Security (RLS) enabled.
3. **Edge Functions:** Run locally inside the Deno edge runtime container and are invoked via `supabase.functions.invoke()`, which automatically maps to `https://api.postora.cloud/functions/v1/<function-name>`.

---

## 4. Guidelines for Lovable / Frontend Updates

- **Do NOT use hardcoded `.supabase.co` domains:** Ensure all database, auth, and storage requests go through the initialized Supabase client in `src/integrations/supabase/client.ts`. This client reads `VITE_SUPABASE_URL` dynamically from the environment.
- **OAuth Callback Domain:** Ensure all OAuth callback redirect URIs configured on platform developer consoles (Meta, TikTok, Google, etc.) route back to the self-hosted domains (e.g., `https://new.postora.cloud` or `https://postora.cloud`).
- **Edge Function Secrets:** If you write or update Edge Functions, do not commit raw API keys to git. Instead, update them via the **App Credentials Manager** inside the Admin Dashboard `/admin/settings` (backed by the `manage-app-secrets` function).
