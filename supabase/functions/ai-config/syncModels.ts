import { type CatalogDb, CatalogSyncError, runCatalogSync } from "../_shared/modelCatalogSyncRun.ts";

/** Serialize the legacy admin action with health syncs and fence its writes. */
export async function syncModels(db: CatalogDb, providerCode: string, dryRun: boolean, fetchImpl: typeof fetch = fetch) {
  if (!db.rpc) throw new Error("Catalogue lease fencing is unavailable");
  const holder = crypto.randomUUID();
  const job = "ai-provider-health";
  const { data, error } = await db.rpc("acquire_cron_run_lease", {
    p_job: job, p_holder: holder, p_ttl: "120 seconds",
  }).abortSignal(AbortSignal.timeout(5_000));
  if (error) throw new Error("Catalogue lease acquisition failed");
  if (data !== true) throw new CatalogSyncError("A provider check or model sync is already running. Try again later.");
  try {
    return await runCatalogSync(db, providerCode, fetchImpl, {
      dryRun, leaseHolder: holder, signal: AbortSignal.timeout(30_000),
    });
  } finally {
    try {
      const { error: releaseError } = await db.rpc("release_cron_run_lease", {
        p_job: job, p_holder: holder,
      }).abortSignal(AbortSignal.timeout(3_000));
      if (releaseError) console.error("event: 'ai_catalogue_lease_release_failed'");
    } catch {
      console.error("event: 'ai_catalogue_lease_release_failed'");
    }
  }
}
