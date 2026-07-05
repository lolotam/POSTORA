-- Per-user, per-day media upload sequence counter.
-- Backs the "postora_<date>_<userId>_<seq>" file naming convention:
-- next_media_seq() atomically allocates the next number so concurrent
-- uploads (e.g. multi-file posts) can never collide on a name.

CREATE TABLE IF NOT EXISTS public.media_upload_counters (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  upload_date DATE NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, upload_date)
);

-- No policies on purpose: only reachable through the SECURITY DEFINER
-- function below or the service role.
ALTER TABLE public.media_upload_counters ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.next_media_seq(p_user_id UUID, p_upload_date DATE)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq INTEGER;
BEGIN
  -- Authenticated callers may only allocate numbers for themselves;
  -- service-role callers (edge functions) have auth.uid() = NULL.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'next_media_seq: cannot allocate sequence for another user';
  END IF;

  INSERT INTO public.media_upload_counters (user_id, upload_date, last_seq)
  VALUES (p_user_id, p_upload_date, 1)
  ON CONFLICT (user_id, upload_date)
  DO UPDATE SET last_seq = media_upload_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;

  RETURN v_seq;
END;
$$;

REVOKE ALL ON FUNCTION public.next_media_seq(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_media_seq(UUID, DATE) TO authenticated, service_role;
