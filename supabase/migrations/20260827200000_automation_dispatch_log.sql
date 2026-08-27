-- Records that an inbound message or comment was handed to the user's n8n workflow.
--
-- Why a new table rather than a column somewhere: the agent setup pages show a log built
-- entirely from `ai_agent_logs`, and that table only ever holds rows the Postora agent
-- wrote. When an account's automation_handler is "n8n" the dispatch went out over HTTP and
-- left nothing behind but a console line, so the log looked empty and a user could not tell
-- "n8n answered this" from "nothing answered this". This is the missing half.
--
-- Deliberately not a copy of ai_agent_logs. Postora cannot see what the workflow replied --
-- only that the event reached it, and how many subscriptions matched. A row with
-- destination_count = 0 is the useful negative: routed to n8n, but no webhook was listening.

CREATE TABLE IF NOT EXISTS public.automation_dispatch_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    social_account_id uuid,
    platform text NOT NULL,
    event text NOT NULL,
    conversation_id text,
    inbound_text text,
    destination_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Matches how the logs view reads: one user, one platform, newest first.
CREATE INDEX IF NOT EXISTS idx_automation_dispatch_log_user_platform
    ON public.automation_dispatch_log (user_id, platform, created_at DESC);

GRANT SELECT ON public.automation_dispatch_log TO authenticated;
GRANT ALL ON public.automation_dispatch_log TO service_role;

ALTER TABLE public.automation_dispatch_log ENABLE ROW LEVEL SECURITY;

-- Created only when absent, never dropped and recreated. Run through plain psql with no
-- enclosing transaction, a DROP POLICY + CREATE POLICY pair commits the drop on its own,
-- and a failure between the two leaves the table readable by nobody.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'automation_dispatch_log'
          AND policyname = 'automation_dispatch_log_read_own'
    ) THEN
        CREATE POLICY "automation_dispatch_log_read_own"
            ON public.automation_dispatch_log FOR SELECT
            TO authenticated
            USING (user_id = auth.uid());
    END IF;
END $$;
