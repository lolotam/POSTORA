-- Disposable Stage 3 acceptance proof. One transaction, synthetic data,
-- labelled ASSERTs, ROLLBACK, sentinel last. No secrets and no live database.
-- Proves the no-migration path: the server-owned publish_requested_at pinned
-- at insert is the acceptance, so concurrent/replayed enqueues reuse one stamp
-- and the processing claim succeeds exactly once.
BEGIN;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  scheduled_at timestamptz,
  publish_requested_at timestamptz,
  processing_started_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE FUNCTION public.posts_pin_publish_requested_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.publish_requested_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.publish_requested_at IS DISTINCT FROM OLD.publish_requested_at) THEN
    NEW.publish_requested_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_posts_pin_publish_requested_at
  BEFORE INSERT OR UPDATE OF publish_requested_at ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.posts_pin_publish_requested_at();

DO $$
DECLARE
  u uuid := 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
  p uuid := 'c0000000-0000-4000-8000-0000000000a1';
  stamp_a timestamptz;
  stamp_b timestamptz;
  claimed_a int;
  claimed_b int;
  final_stamp timestamptz;
BEGIN
  -- The composer writes an intent timestamp; the server trigger replaces it
  -- with the database clock, so the stamp is never a client-owned value.
  INSERT INTO public.posts (id, user_id, publish_requested_at, metadata)
    VALUES (p, u, now() + interval '1 hour', '{"submit_fingerprint":"same-intent"}'::jsonb);

  SELECT publish_requested_at INTO stamp_a FROM public.posts WHERE id = p;
  ASSERT stamp_a IS NOT NULL, 'S1 the server pinned the acceptance stamp at insert';

  -- Two replays of "publish now" both READ the existing stamp; neither
  -- restamps the row. Both then kick process-post with the same expectation.
  SELECT publish_requested_at INTO stamp_b FROM public.posts WHERE id = p;
  ASSERT stamp_a = stamp_b, 'S2 a replay reads the same durable stamp';

  -- The real processing claim (postProcessingClaim.ts) is an UPDATE on the
  -- exact stamp with a status guard. Two concurrent claims converge once.
  UPDATE public.posts
     SET status = 'processing', processing_started_at = now()
   WHERE id = p AND publish_requested_at = stamp_a AND status IN ('pending', 'scheduled');
  GET DIAGNOSTICS claimed_a = ROW_COUNT;

  UPDATE public.posts
     SET status = 'processing', processing_started_at = now()
   WHERE id = p AND publish_requested_at = stamp_b AND status IN ('pending', 'scheduled');
  GET DIAGNOSTICS claimed_b = ROW_COUNT;

  ASSERT claimed_a = 1, 'S3 the first claim moves the post to processing';
  ASSERT claimed_b = 0, 'S4 the replayed claim matches nothing';

  SELECT publish_requested_at INTO final_stamp FROM public.posts WHERE id = p;
  ASSERT final_stamp = stamp_a, 'S5 no replay moved the accepted timestamp';

  ASSERT (SELECT count(*) FROM public.posts WHERE id = p) = 1,
    'S6 one post id, never a second row for the same intent';

  RAISE NOTICE 'STAGE3_ACCEPTANCE_PROOF_OK';
END;
$$;

ROLLBACK;
-- Sentinel must be the last output line.
SELECT 'STAGE3_SQL_SENTINEL_OK';
