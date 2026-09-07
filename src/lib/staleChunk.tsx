import { ToastAction } from "@/components/ui/toast";
import { toast } from "@/hooks/use-toast";

// A deploy renames every hashed chunk. A tab that loaded the previous index.html then asks
// for a chunk that no longer exists, and the browser reports it as one of these.
const CHUNK_ERROR_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "ChunkLoadError",
  "Importing a module script failed",
  "Loading chunk",
  "Loading CSS chunk",
  "error loading dynamically imported module",
];

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return CHUNK_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * A plain reload can hand back the same stale index.html from the HTTP cache, which then
 * requests the same missing chunk (Sentry POSTORA-1 was exactly that second failure). A
 * changed query string forces the document to be fetched again; path and hash are kept so
 * the user lands where they were.
 */
export function newVersionUrl(current: Location | URL = window.location, now: number = Date.now()): string {
  const url = new URL(current.href);
  url.searchParams.set("v", String(now));
  return url.toString();
}

export function reloadForNewVersion(): void {
  window.location.replace(newVersionUrl());
}

let prompted = false;

/**
 * Shows one "new version" toast with a Reload action. Idempotent: a page with several
 * failing imports gets one prompt, not a stack of them.
 */
export function promptForNewVersion(): void {
  if (prompted) return;
  prompted = true;
  toast({
    title: "A new version of Postora is available",
    description: "Reload to keep using the app.",
    duration: Infinity,
    action: (
      <ToastAction altText="Reload" onClick={reloadForNewVersion}>
        Reload
      </ToastAction>
    ),
  });
}

/**
 * Vite raises `vite:preloadError` for any dynamic import that fails, including the ones
 * `lazyWithRetry` does not wrap. Preventing the default turns the uncaught error into a
 * prompt, so it stops reaching Sentry as a crash. Returns the remover for tests.
 */
export function installStaleChunkListener(target: Window = window): () => void {
  const onPreloadError = (event: Event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (!isChunkLoadError(payload)) return;
    event.preventDefault();
    promptForNewVersion();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return () => target.removeEventListener("vite:preloadError", onPreloadError);
}

/** Test-only reset of the one-prompt guard. */
export function resetStaleChunkPromptForTests(): void {
  prompted = false;
}
