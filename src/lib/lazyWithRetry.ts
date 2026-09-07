import { lazy } from "react";
import { isChunkLoadError, reloadForNewVersion } from "@/lib/staleChunk";

type LazyImporter = Parameters<typeof lazy>[0];
type ComponentModule = Awaited<ReturnType<LazyImporter>>;

export function lazyWithRetry(
  importer: () => Promise<ComponentModule>,
  moduleId?: string
) {
  const key = `lazy-retry:${moduleId ?? importer.toString().slice(0, 64)}`;

  return lazy(() =>
    importer().then(
      (module) => {
        // Successful load — clear any previous retry guard
        sessionStorage.removeItem(key);
        return module;
      },
      (error) => {
        if (!isChunkLoadError(error)) throw error;

        // If we already reloaded once for this chunk, don't loop — let ErrorBoundary handle it
        if (sessionStorage.getItem(key)) {
          sessionStorage.removeItem(key);
          throw error;
        }

        // Set guard and reload with a cache-busting query so the browser fetches a fresh
        // index.html rather than the cached one that still names the missing chunk.
        sessionStorage.setItem(key, "1");
        reloadForNewVersion();

        // Return a never-resolving promise to prevent React from rendering stale tree
        return new Promise<ComponentModule>(() => {});
      }
    )
  );
}
