# Remove unpaired WhatsApp Direct QR attempts

Owner request, 2026-11-12: a Direct QR connection that never paired must not stay in the
database, and why it was removed must be visible.

## Problem

`create_and_get_qr` writes a `social_accounts` row (inactive, `platform_user_id =
pending_<uuid>`) and an Evolution instance before the phone scans. If the scan never
succeeds, both stay forever. A `pending_` row can never be reconnected (`reconnect.ts`
refuses it), so it is dead weight in the account list and in Evolution. Production had 13
such rows on 2026-11-12.

## Decision (owner card: "both")

1. **Popup close.** Closing the QR popup without a successful scan calls the bridge action
   `discard_pending_qr` for that account.
2. **Sweep.** The cron function `sweep-pending-whatsapp-qr` runs every 10 minutes. It removes
   attempts whose `connected_at` (set at insert) is older than 30 minutes, at most 50 per run.

## Rules

- Only a never-paired attempt is removed. The delete itself carries the conditions:
  `platform = whatsapp`, `connection_mode = evolution_qr`, `is_active = false`,
  `platform_user_id LIKE 'pending_%'`, plus `user_id` for the owner's own call. A pairing
  that lands between the read and the delete therefore keeps the row. A paired account
  that was later disconnected has its real number and is never touched, so Reconnect
  still works.
- The instance row goes with the account (ON DELETE CASCADE). The Evolution instance is
  then deleted; a 404 there counts as already gone. An Evolution failure is logged as a
  warning and does not restore the rows.
- Every removal writes one `system_logs` row: `social_account_id`, `reason` (`abandoned`
  for the popup, `expired` for the sweep), `instance_name`, and `evolution_error` when set.
- A scan still running 30 minutes after it started is removed by the sweep. The popup then
  reports the account as gone and the owner starts a new connection.

## Files

- `supabase/functions/_shared/pendingQrCleanup.ts` (+ test): the removal.
- `supabase/functions/_shared/pendingQrCleanupPorts.ts`: service-role, Evolution and log ports.
- `supabase/functions/whatsapp-evolution-bridge/index.ts`: `discard_pending_qr`.
- `supabase/functions/sweep-pending-whatsapp-qr/` (+ test): the sweep.
- `supabase/migrations/20261112200000_sweep_pending_whatsapp_qr_cron.sql`: the cron job.
- `src/hooks/useWhatsAppConnect.ts`, `src/components/messaging/WhatsAppSetup.tsx` (+ test).
