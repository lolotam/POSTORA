-- media_file_providers write policies: the dual-cloud uploader (cloudinary-upload edge
-- function, authenticated JWT path) inserts/updates provider rows right after the
-- media_files insert. RLS previously had SELECT-only policies, so every frontend
-- upload failed with "new row violates row-level security policy" AFTER the file had
-- already reached Cloudinary -- surfacing to users as a generic "Upload failed".

DROP POLICY IF EXISTS "Users can insert own media file providers"
  ON public.media_file_providers;

CREATE POLICY "Users can insert own media file providers"
  ON public.media_file_providers FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.media_files
      WHERE media_files.id = media_file_providers.media_file_id
        AND auth.uid() = media_files.user_id
    )
  );

DROP POLICY IF EXISTS "Users can update own media file providers"
  ON public.media_file_providers;

CREATE POLICY "Users can update own media file providers"
  ON public.media_file_providers FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.media_files
      WHERE media_files.id = media_file_providers.media_file_id
        AND auth.uid() = media_files.user_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.media_files
      WHERE media_files.id = media_file_providers.media_file_id
        AND auth.uid() = media_files.user_id
    )
  );

DROP POLICY IF EXISTS "Users can delete own media file providers"
  ON public.media_file_providers;

CREATE POLICY "Users can delete own media file providers"
  ON public.media_file_providers FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.media_files
      WHERE media_files.id = media_file_providers.media_file_id
        AND auth.uid() = media_files.user_id
    )
  );
DROP POLICY IF EXISTS "Admins can insert media file providers"
  ON public.media_file_providers;

CREATE POLICY "Admins can insert media file providers"
  ON public.media_file_providers FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can update media file providers"
  ON public.media_file_providers;

CREATE POLICY "Admins can update media file providers"
  ON public.media_file_providers FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can delete media file providers"
  ON public.media_file_providers;

CREATE POLICY "Admins can delete media file providers"
  ON public.media_file_providers FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));
