/**
 * Removes a Direct QR connection attempt that never paired.
 *
 * `create_and_get_qr` writes a `social_accounts` row on a `pending_<uuid>` placeholder and an
 * Evolution instance before the phone scans anything. When the owner closes the popup, or the
 * browser never comes back, both stay behind as an inactive connection the owner cannot use:
 * a placeholder can never be reconnected (reconnect.ts refuses it). This module deletes them.
 *
 * Only a row that is still a never-paired attempt is deleted: Direct QR, inactive, and on the
 * `pending_` placeholder. The delete carries those conditions itself, so a pairing that lands
 * between the read and the delete leaves the row alone, and a paired-then-disconnected account
 * (real number, kept for Reconnect) is never touched.
 */

export type PendingQrDiscardReason = "abandoned" | "expired";

export interface PendingQrCleanupPorts {
  /** The Evolution instance name stored for the account, or null when there is none. */
  findInstanceName(accountId: string): Promise<string | null>;
  /**
   * Deletes the account when it is still a never-paired attempt (and, with `ownerId`, owned by
   * that user). True when a row was deleted. The instance row goes with it (ON DELETE CASCADE).
   */
  deleteIfPending(accountId: string, ownerId: string | null): Promise<boolean>;
  deleteEvolutionInstance(instanceName: string): Promise<void>;
  log(level: "info" | "warn", message: string, metadata: Record<string, unknown>): Promise<void>;
}

export interface PendingQrDiscardInput {
  accountId: string;
  /** The requesting user. Null only for the service-role sweep. */
  ownerId: string | null;
  reason: PendingQrDiscardReason;
}

export interface PendingQrDiscardResult {
  deleted: boolean;
  /** Set when the Evolution session could not be removed; the database rows are gone regardless. */
  evolutionError?: string;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export async function discardPendingQrAccount(
  ports: PendingQrCleanupPorts,
  input: PendingQrDiscardInput,
): Promise<PendingQrDiscardResult> {
  // Read before the delete: the cascade removes the row that names the remote instance.
  const instanceName = await ports.findInstanceName(input.accountId);
  const deleted = await ports.deleteIfPending(input.accountId, input.ownerId);
  if (!deleted) return { deleted: false };

  let evolutionError: string | undefined;
  if (instanceName) {
    try {
      await ports.deleteEvolutionInstance(instanceName);
    } catch (error) {
      evolutionError = errorText(error);
    }
  }

  // The reason is what lets /admin/logs explain why an attempt disappeared.
  await ports.log(evolutionError ? "warn" : "info", "Unpaired WhatsApp QR attempt removed", {
    social_account_id: input.accountId,
    reason: input.reason,
    instance_name: instanceName,
    ...(evolutionError ? { evolution_error: evolutionError } : {}),
  });
  return evolutionError ? { deleted: true, evolutionError } : { deleted: true };
}
