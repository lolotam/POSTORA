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

/** Counts only. Never ids, urls, or names. */
export interface RetentionLog {
  warned: number;
  cleared: number;
  claimed: number;
  deleted: number;
  failed: number;
  backlog: number;
  delete_enabled: boolean;
}

export interface RetentionReport {
  dryRun: boolean;
  deleteEnabled: boolean;
  result: RetentionCounts;
  filesToDelete: RetentionFilePreview[];
}

export interface RetentionPorts {
  sweep(pNow: string, pLimit: number): Promise<Array<{ phase: string; count: number }>>;
  claim(pNow: string, pLimit: number): Promise<ClaimedMediaFile[]>;
  /** `failed` true counts a failed attempt. False returns an unstarted claim to the queue. */
  release(id: string, failed: boolean): Promise<void>;
  preview(userId: string | null): Promise<PreviewRow[]>;
  readDeleteEnabled(): Promise<boolean>;
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

async function safeRelease(ports: RetentionPorts, id: string, failed: boolean): Promise<void> {
  try {
    await ports.release(id, failed);
  } catch {
    console.error("[media-retention] release failed");
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
  const deleteEnabled = await args.ports.readDeleteEnabled().catch(() => false);

  if (args.dryRun) {
    const rows = await args.ports.preview(null);
    const warned = rows.filter((row) => row.action === "would_warn").length;
    const due = rows.filter((row) => row.action === "due").length;
    return {
      dryRun: true,
      deleteEnabled,
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
          await safeRelease(args.ports, file.media_file_id, false);
          continue;
        }

        const loaded = await args.ports.loadProviders(file.media_file_id);
        if ("error" in loaded) {
          failed += 1;
          await safeRelease(args.ports, file.media_file_id, true);
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
          await safeRelease(args.ports, file.media_file_id, true);
          continue;
        }

        const removed = await args.ports.removeMediaRow(file.media_file_id, file.user_id);
        if (!removed.removed) {
          failed += 1;
          if (removed.error || removed.stillDeleting) {
            await safeRelease(args.ports, file.media_file_id, true);
          }
          continue;
        }
        deleted += 1;
      }
      if (stoppedForBudget || remaining() <= 0) break;
    }
  } catch (error) {
    await writeLog(args.ports, { warned, cleared, claimed, deleted, failed, backlog: 0, delete_enabled: deleteEnabled });
    throw error;
  }

  let backlog = 0;
  try {
    const rows = await args.ports.preview(null);
    backlog = rows.filter((row) => row.action === "due").length;
  } catch {
    console.error("[media-retention] backlog preview failed");
  }

  await writeLog(args.ports, { warned, cleared, claimed, deleted, failed, backlog, delete_enabled: deleteEnabled });

  return {
    dryRun: false,
    deleteEnabled,
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
