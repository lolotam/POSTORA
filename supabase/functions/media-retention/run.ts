import type { ProviderDeleteRow } from "../_shared/mediaDeletePlan.ts";

export const RETENTION_BUDGET_MS = 40_000;
export const RETENTION_BATCH_LIMIT = 50;

export interface ClaimedMediaFile {
  media_file_id: string;
  user_id: string;
  file_type: string;
  cloudinary_public_id: string | null;
  file_path: string;
}

export interface PreviewRow {
  media_file_id: string;
  user_id: string;
  action: "would_warn" | "due" | string;
}

export interface RetentionFilePreview {
  id: string;
  action: string;
}

export interface RetentionCounts {
  warned: number;
  due: number;
  deleted: number;
  failed: number;
  backlog: number;
}

/**
 * Whether the admin delete switch could be read this run. "unknown" covers a
 * missing settings row, a read error, or anything else that is not a clean
 * boolean -- it is never coerced into "disabled", so a log reader can tell
 * "admin turned it off" apart from "the switch could not be read".
 */
export type DeleteSwitchState = "enabled" | "disabled" | "unknown";

/** Counts only. Never ids, urls, or names. */
export interface RetentionLog {
  warned: number;
  cleared: number;
  claimed: number;
  deleted: number;
  failed: number;
  backlog: number;
  delete_state: DeleteSwitchState;
}

export interface RetentionReport {
  dryRun: boolean;
  /** True only when the switch was read as enabled. False when disabled or unknown. */
  deleteEnabled: boolean;
  deleteState: DeleteSwitchState;
  result: RetentionCounts;
  filesToDelete: RetentionFilePreview[];
}

export interface RetentionPorts {
  sweep(pNow: string, pLimit: number): Promise<Array<{ phase: string; count: number }>>;
  claim(pNow: string, pLimit: number): Promise<ClaimedMediaFile[]>;
  /**
   * `failed` true counts a failed attempt. False returns an unstarted claim to
   * the queue. Scoped to `userId`, the owner the row was claimed under, so a
   * release can only ever touch the file it claimed.
   */
  release(id: string, userId: string, failed: boolean): Promise<void>;
  preview(userId: string | null): Promise<PreviewRow[]>;
  /** Fail-closed: only "enabled" allows claiming or deleting. */
  readDeleteState(): Promise<DeleteSwitchState>;
  /** Best-effort. Called once when readDeleteState resolves to "unknown". */
  logDeleteSwitchUnreadable(): Promise<void>;
  loadProviders(mediaFileId: string): Promise<{ rows: ProviderDeleteRow[] } | { error: string }>;
  deleteFile(file: ClaimedMediaFile, providers: ProviderDeleteRow[], timeoutMs: number): Promise<{ confirmed: boolean }>;
  /**
   * Delete one claimed row. `removed` is false when no row matched the claim.
   * `stillDeleting` is true only when that id is still in `deleting`.
   */
  removeMediaRow(id: string, claimedUserId: string): Promise<{ removed: boolean; stillDeleting: boolean; error?: string }>;
  logRun(entry: RetentionLog): Promise<void>;
}

function phaseCount(rows: Array<{ phase: string; count: number }>, needle: string): number {
  let total = 0;
  for (const row of rows) {
    if (String(row.phase ?? "").toLowerCase().includes(needle)) total += Number(row.count) || 0;
  }
  return total;
}

async function safeRelease(ports: RetentionPorts, id: string, userId: string, failed: boolean): Promise<void> {
  try {
    await ports.release(id, userId, failed);
  } catch {
    console.error("[media-retention] release failed");
  }
}

async function safeLogSwitchUnreadable(ports: RetentionPorts): Promise<void> {
  try {
    await ports.logDeleteSwitchUnreadable();
  } catch {
    console.error("[media-retention] delete-switch-unreadable log failed");
  }
}

/**
 * One retention run. Dry run reads the preview and writes nothing.
 * A live run sweeps, then claims batches until the budget is spent or the queue is empty.
 * A file is removed only after its provider delete is confirmed.
 */
export async function runMediaRetention(args: {
  dryRun: boolean;
  ports: RetentionPorts;
  now?: () => number;
  budgetMs?: number;
}): Promise<RetentionReport> {
  const now = args.now ?? Date.now;
  const budgetMs = args.budgetMs ?? RETENTION_BUDGET_MS;
  const started = now();
  const remaining = () => budgetMs - (now() - started);
  const deleteState = await args.ports.readDeleteState().catch(() => "unknown" as const);
  if (deleteState === "unknown") await safeLogSwitchUnreadable(args.ports);
  const deleteEnabled = deleteState === "enabled";

  if (args.dryRun) {
    const rows = await args.ports.preview(null);
    const warned = rows.filter((row) => row.action === "would_warn").length;
    const due = rows.filter((row) => row.action === "due").length;
    return {
      dryRun: true,
      deleteEnabled,
      deleteState,
      result: { warned, due, deleted: 0, failed: 0, backlog: due },
      filesToDelete: rows.map((row) => ({ id: row.media_file_id, action: row.action })),
    };
  }

  let warned = 0;
  let cleared = 0;
  let claimed = 0;
  let deleted = 0;
  let failed = 0;
  const seen = new Set<string>();

  try {
    while (remaining() > 0) {
      const phases = await args.ports.sweep(new Date(now()).toISOString(), RETENTION_BATCH_LIMIT);
      warned += phaseCount(phases, "warn");
      cleared += phaseCount(phases, "clear");

      if (!deleteEnabled || remaining() <= 0) break;

      const batch = await args.ports.claim(new Date(now()).toISOString(), RETENTION_BATCH_LIMIT);
      const fresh = batch.filter((file) => file.media_file_id && !seen.has(file.media_file_id));
      if (fresh.length === 0) break;

      let stoppedForBudget = false;
      for (const file of fresh) {
        seen.add(file.media_file_id);
        claimed += 1;
        const budgetLeft = remaining();
        if (budgetLeft <= 0) {
          stoppedForBudget = true;
          await safeRelease(args.ports, file.media_file_id, file.user_id, false);
          continue;
        }

        const loaded = await args.ports.loadProviders(file.media_file_id);
        if ("error" in loaded) {
          failed += 1;
          await safeRelease(args.ports, file.media_file_id, file.user_id, true);
          continue;
        }

        let confirmed = false;
        try {
          const outcome = await args.ports.deleteFile(file, loaded.rows, Math.min(10_000, budgetLeft));
          confirmed = outcome.confirmed;
        } catch {
          confirmed = false;
        }
        if (!confirmed) {
          failed += 1;
          await safeRelease(args.ports, file.media_file_id, file.user_id, true);
          continue;
        }

        const removed = await args.ports.removeMediaRow(file.media_file_id, file.user_id);
        if (!removed.removed) {
          failed += 1;
          if (removed.error || removed.stillDeleting) {
            await safeRelease(args.ports, file.media_file_id, file.user_id, true);
          }
          continue;
        }
        deleted += 1;
      }
      if (stoppedForBudget || remaining() <= 0) break;
    }
  } catch (error) {
    await writeLog(args.ports, { warned, cleared, claimed, deleted, failed, backlog: 0, delete_state: deleteState });
    throw error;
  }

  let backlog = 0;
  try {
    const rows = await args.ports.preview(null);
    backlog = rows.filter((row) => row.action === "due").length;
  } catch {
    console.error("[media-retention] backlog preview failed");
  }

  await writeLog(args.ports, { warned, cleared, claimed, deleted, failed, backlog, delete_state: deleteState });

  return {
    dryRun: false,
    deleteEnabled,
    deleteState,
    result: { warned, due: claimed, deleted, failed, backlog },
    filesToDelete: [],
  };
}

async function writeLog(ports: RetentionPorts, entry: RetentionLog): Promise<void> {
  try {
    await ports.logRun(entry);
  } catch {
    console.error("[media-retention] run log failed");
  }
}
