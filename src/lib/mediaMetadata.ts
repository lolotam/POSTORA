/**
 * `media_files.metadata` is a JSONB column, and the upload path writes more into
 * it than the pixel dimensions: `format`, `duration` and `original_filename`
 * live there too.
 *
 * The media grids "heal" rows whose `width` is null by measuring the rendered
 * image and writing the result back. That write must merge, because PostgREST
 * replaces a JSONB column wholesale: sending a bare `{ width, height }` drops
 * every other key for that row, permanently and silently.
 */
export interface MediaFileMetadata {
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  format?: string | null;
  original_filename?: string | null;
  [key: string]: unknown;
}

/**
 * Returns the metadata to persist when healing a row's dimensions: every key the
 * row already carries, with `width`/`height` overwritten by the measured values.
 */
export function mergeHealedDimensions(
  existing: MediaFileMetadata | Record<string, unknown> | null | undefined,
  width: number,
  height: number,
): MediaFileMetadata {
  return { ...(existing ?? {}), width, height };
}
