
-- Partner API v1, Phase 1 (spec D4): one key may bind MANY social accounts.
--
-- partner_api_keys.social_account_id stays NOT NULL and keeps its meaning as
-- the "primary account" of the frozen partner-api alias, whose request body
-- has no way to express account selection. Nothing about that column changes
-- here; this table is purely additive.

CREATE TABLE public.partner_api_key_accounts (
  key_id            UUID NOT NULL,
  social_account_id UUID NOT NULL,
  workspace_id      UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Natural key: one binding per (key, account). Its leftmost column also
  -- serves lookups by key_id, so no separate key_id index is needed.
  PRIMARY KEY (key_id, social_account_id),
  -- Composite FK #1 (account tenancy): the account must belong to this row's
  -- workspace. On its own it proves nothing about the KEY -- that is FK #2's
  -- job.
  CONSTRAINT partner_api_key_accounts_account_in_workspace
    FOREIGN KEY (social_account_id, workspace_id)
    REFERENCES public.social_accounts (id, workspace_id) ON DELETE CASCADE,
  -- Composite FK #2 (key tenancy): the key must belong to this row's
  -- workspace as well. With only FK #1, a malformed or compromised
  -- administrative write could bind workspace A's key to workspace B's
  -- account while satisfying every constraint; two independent
  -- single-column FKs would silently lose the same guarantee. Both
  -- composite FKs together are what make the cross-workspace binding
  -- unrepresentable (spec section 9.1, D4). Do not remove either one.
  -- CASCADE, unlike the RESTRICT on partner_api_usage: bindings are
  -- day-to-day configuration, not history. A key that still has usage rows
  -- cannot be hard-deleted anyway (that FK RESTRICTs), so this cascade only
  -- fires for keys with no billing history, whose bindings are meaningless
  -- without them.
  CONSTRAINT partner_api_key_accounts_key_in_workspace
    FOREIGN KEY (key_id, workspace_id)
    REFERENCES public.partner_api_keys (id, workspace_id) ON DELETE CASCADE
);

-- Reverse lookup: which keys are bound to a given account (also serves the
-- account-side composite FK above).
CREATE INDEX partner_api_key_accounts_account_idx
  ON public.partner_api_key_accounts (social_account_id);

-- Backfill: one row per existing partner_api_keys row, taking workspace_id
-- and social_account_id from the key. Every key row satisfies
-- partner_api_keys_account_in_workspace, so the mirrored rows always satisfy
-- both composite FKs here.
--
-- The NOT EXISTS guard is what makes a re-run safe: it seeds only keys that
-- have no binding at all yet, so re-running never adds a second seeding row
-- for a key (even if its primary account changed) and never fights bindings
-- a lifecycle path may have created in the meantime.
INSERT INTO public.partner_api_key_accounts (key_id, social_account_id, workspace_id)
SELECT k.id, k.social_account_id, k.workspace_id
FROM public.partner_api_keys k
WHERE NOT EXISTS (
  SELECT 1 FROM public.partner_api_key_accounts b
   WHERE b.key_id = k.id
)
ON CONFLICT (key_id, social_account_id) DO NOTHING;

ALTER TABLE public.partner_api_key_accounts ENABLE ROW LEVEL SECURITY;

-- Bindings are managed exclusively by service-role lifecycle paths (edge
-- functions / SECURITY DEFINER), the same convention as
-- partner_api_idempotency and partner_api_usage: RLS on, no policies.
-- Grants are stated explicitly so the table does not depend on
-- environment-specific default privileges.
REVOKE ALL ON public.partner_api_key_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_api_key_accounts TO service_role;
