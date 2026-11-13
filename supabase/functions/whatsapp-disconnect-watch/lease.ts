// Reuse the scheduler's atomic SQL lease: a slow or manually invoked watcher must not
// apply an older healthy read after another watcher has recorded a newer outage.
export const WATCH_LEASE_JOB = "whatsapp-disconnect-watch";
export const WATCH_LEASE_TTL = "10 minutes";
export const WATCH_REQUEST_TIMEOUT_MS = 150_000;

export interface WatchLease {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export async function withWatchLease<T>(lease: WatchLease, run: () => Promise<T>): Promise<T | null> {
  if (!await lease.acquire()) return null;
  try {
    return await run();
  } finally {
    await lease.release();
  }
}
