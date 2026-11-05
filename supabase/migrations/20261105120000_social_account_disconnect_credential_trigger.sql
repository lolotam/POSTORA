-- Disconnecting a Facebook or Page-linked Instagram account failed.
--
-- The browser removes an account with a plain DELETE on social_accounts
-- (RLS: the owner may delete their own row). The delete cascades to
-- facebook_user_credential_bindings, whose AFTER DELETE trigger purges the
-- compatibility linkage, burns the connection fence and drops an orphaned
-- Facebook User secret. That trigger ran with the caller's privileges, and
-- the authenticated role deliberately holds no privilege on any of those
-- relations, so every disconnect of a protected account aborted with
-- "permission denied for table instagram_account_credentials"
-- (production 2026-11-05, xsellpoint Facebook and Instagram).
--
-- The trigger now runs as its owner. It only touches rows keyed by the
-- binding that is being deleted, so it grants the caller nothing beyond
-- the cleanup of their own account. A trigger function cannot be called
-- directly, and EXECUTE is withdrawn from every client role regardless.

ALTER FUNCTION public.facebook_user_credential_binding_deleted()
  SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.facebook_user_credential_binding_deleted()
  FROM PUBLIC, anon, authenticated, service_role;
