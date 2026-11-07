// The worker answers 202 at once; cron is the safety net if this kick is lost.
const KICK_TIMEOUT_MS = 5_000;

export async function kickBackgroundJobsWorker(
  fetchFn: typeof fetch,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<void> {
  const resp = await fetchFn(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/background-jobs-worker`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
  });
  await resp.body?.cancel();
  if (!resp.ok) {
    console.warn(
      `[background-jobs] worker kick answered ${resp.status}; cron will pick the job up`,
    );
  }
}
