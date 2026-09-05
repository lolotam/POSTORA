-- The connector ledger is meant to hold every connector call, and audience-sheets-sync is a new
-- caller: it appends contact rows to a customer's Google Sheet through the same Composio path the
-- agent uses. Its calls do not belong under any of the four existing sources — it is neither the
-- AI agent, a partner key, a connection test, nor a publish — so recording them honestly needs a
-- value of their own rather than a borrowed one.
ALTER TABLE public.connector_call_logs
  DROP CONSTRAINT IF EXISTS connector_call_logs_source_check;

ALTER TABLE public.connector_call_logs
  ADD CONSTRAINT connector_call_logs_source_check
  CHECK (source IN ('agent', 'partner', 'test', 'publish', 'audience'));
