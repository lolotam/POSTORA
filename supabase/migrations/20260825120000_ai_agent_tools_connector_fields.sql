-- Connector metadata for AI agent tools (PR #36 follow-up).
--
-- The Database Connectors studio collects a connector type, a capability
-- checklist, a read-only flag and a cache toggle. Before this migration those
-- values existed only in the browser and silently vanished on save. They are
-- now persisted on ai_agent_tools so the UI reflects what the agent will
-- actually execute with.
--
-- RLS: the existing "Users manage own ai agent tools" FOR ALL policy covers
-- the new columns; no policy change is needed.

ALTER TABLE public.ai_agent_tools
  ADD COLUMN connector_type TEXT NOT NULL DEFAULT 'custom_rest'
    CHECK (connector_type IN (
      'supabase', 'mysql_postgres', 'woocommerce', 'shopify',
      'salla', 'zid', 'formula', 'custom_rest'
    )),
  ADD COLUMN permissions JSONB NOT NULL
    DEFAULT '{"search_products": false, "check_stock": false, "lookup_orders": false}'::jsonb
    CHECK (jsonb_exists_all(permissions, ARRAY['search_products', 'check_stock', 'lookup_orders'])),
  ADD COLUMN read_only_mode BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN enable_cache BOOLEAN NOT NULL DEFAULT true;
