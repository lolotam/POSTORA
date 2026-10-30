/**
 * One sweep of the AI image staging area.
 *
 * upscale-image and remove-background copy an uploaded image to
 * `<prefix>/postora/<user>/ai-tmp/<uuid>` so AtlasCloud can read it by URL, and remove the copy
 * when the job finishes or fails. A browser that never comes back with its follow-up token
 * leaves the copy behind. Once the token has expired (TOKEN_MAX_AGE_MS) nobody can redeem the
 * job, so a copy older than that, plus a margin for clock skew, is deleted here.
 *
 * A listing that fails is an error, never an empty folder: nothing is deleted on a guess.
 */

import { TOKEN_MAX_AGE_MS } from "../_shared/aiImageJob.ts";
import type { OpeninaryFile, OpeninaryFolder } from "../_shared/openinary.ts";

export const STAGING_MAX_AGE_MS = TOKEN_MAX_AGE_MS + 30 * 60 * 1000;
/** Bounds one run well inside the 60 s worker limit; the next run picks up the rest. */
export const RUN_BUDGET_MS = 40_000;
export const MAX_DELETES_PER_RUN = 200;
const CONCURRENCY = 4;
const MAX_REPORTED_FAILURES = 20;

export interface SweepPorts {
  /** `<prefix>/postora/<user>` folders. Throws when the listing fails. */
  listUserFolders(): Promise<string[]>;
  /** Files in `<userFolder>/ai-tmp`. Throws when the listing fails. */
  listStaged(userFolder: string): Promise<OpeninaryFile[]>;
  remove(path: string): Promise<{ success: boolean; error?: string }>;
  log(level: "info" | "warn" | "error", message: string, metadata: Record<string, unknown>): Promise<void>;
}

export interface SweepOptions {
  now?: () => number;
  /** In [0, 1): where in the folder list this run starts. */
  random?: () => number;
  budgetMs?: number;
  maxDeletes?: number;
}

export interface SweepSummary {
  user_folders: number;
  scanned: number;
  deleted: number;
  kept_fresh: number;
  undated: number;
  list_errors: number;
  delete_errors: number;
  /** The budget or the delete cap ran out before every folder was handled. */
  incomplete: boolean;
}

type Failure = { path: string; error: string };

/** A full RFC 3339 date-time with a zone. A date alone, or a zoneless time, cannot prove an age. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The modification instant in ms, or NaN when the listing's mtime cannot be trusted as one. */
export function modifiedAt(mtime: string | undefined): number {
  if (!mtime || !RFC3339.test(mtime)) return NaN;
  // Date.parse rolls impossible dates over (02-31 becomes 03-03): the calendar date must exist.
  const [year, month, day] = mtime.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return NaN;
  return Date.parse(mtime);
}

/** The user folders among `root`'s children: direct children only, named like the path says. */
export function userFolderPaths(root: string, folders: OpeninaryFolder[]): string[] {
  return folders.filter((f) => f.name && !f.name.includes("/") && f.path === `${root}/${f.name}`).map((f) => f.path);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export async function runSweep(ports: SweepPorts, options: SweepOptions = {}): Promise<SweepSummary> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? RUN_BUDGET_MS);
  const maxDeletes = options.maxDeletes ?? MAX_DELETES_PER_RUN;

  const listed = await ports.listUserFolders();
  // Each run starts at a random folder and wraps around, so a run that runs out of budget does
  // not leave the same tail of the list unvisited every time.
  const start = Math.floor((options.random ?? Math.random)() * listed.length);
  const folders = [...listed.slice(start), ...listed.slice(0, start)];
  const summary: SweepSummary = {
    user_folders: folders.length, scanned: 0, deleted: 0, kept_fresh: 0, undated: 0, list_errors: 0, delete_errors: 0, incomplete: false,
  };
  const failures: Failure[] = [];
  let deleteSlots = maxDeletes;

  const sweepFolder = async (folder: string) => {
    let files: OpeninaryFile[];
    try {
      files = await ports.listStaged(folder);
    } catch (error) {
      summary.list_errors++;
      failures.push({ path: `${folder}/ai-tmp`, error: message(error) });
      return;
    }
    const stagingPrefix = `${folder}/ai-tmp/`;
    for (const file of files) {
      // Only direct children of this folder's ai-tmp, whatever the listing claims.
      if (!file.path.startsWith(stagingPrefix) || file.path.slice(stagingPrefix.length).includes("/")) continue;
      summary.scanned++;
      const modified = modifiedAt(file.mtime);
      if (Number.isNaN(modified)) {
        summary.undated++;
        continue;
      }
      if (now() - modified <= STAGING_MAX_AGE_MS) {
        summary.kept_fresh++;
        continue;
      }
      if (deleteSlots <= 0 || now() >= deadline) {
        summary.incomplete = true;
        return;
      }
      deleteSlots--;
      const removed = await ports.remove(file.path).catch((error) => ({ success: false, error: message(error) }));
      if (removed.success) summary.deleted++;
      else {
        summary.delete_errors++;
        failures.push({ path: file.path, error: removed.error ?? "unknown" });
      }
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < folders.length) {
      if (now() >= deadline || deleteSlots <= 0) {
        summary.incomplete = true;
        return;
      }
      await sweepFolder(folders[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, folders.length) }, worker));

  // A quiet run leaves no row; anything deleted, skipped or failed does.
  const metadata = { ...summary, failures: failures.slice(0, MAX_REPORTED_FAILURES) };
  if (failures.length > 0) await ports.log("error", "AI image staging sweep hit errors", metadata);
  else if (summary.undated > 0) await ports.log("warn", "AI image staging sweep found files without a modification time", metadata);
  else if (summary.deleted > 0 || summary.incomplete) await ports.log("info", "AI image staging sweep removed expired copies", metadata);
  return summary;
}
