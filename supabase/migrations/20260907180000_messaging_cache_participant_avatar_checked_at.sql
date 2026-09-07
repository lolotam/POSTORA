-- Negative cache for WhatsApp Direct-QR avatar enrichment.
--
-- Evolution's fetchProfilePictureUrl returns null for contacts whose picture is private.
-- Without a timestamp every inbound message from such a contact would trigger another
-- provider round-trip. Set only on a confirmed miss (null picture); a network or upload
-- failure leaves it null so the next message retries.
-- See docs/specs/2026-09-07-whatsapp-qr-inbox-media-avatars.md (Slice B).

ALTER TABLE public.messaging_cache
  ADD COLUMN IF NOT EXISTS participant_avatar_checked_at timestamptz;

COMMENT ON COLUMN public.messaging_cache.participant_avatar_checked_at IS
  'Last time a profile picture lookup confirmed the contact has none (WhatsApp Direct-QR). Null = never checked or last attempt errored.';
