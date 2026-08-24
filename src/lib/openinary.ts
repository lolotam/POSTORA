/**
 * Openinary's delivery grammar, read side.
 *
 * `supabase/functions/_shared/openinary.ts` decides where bytes are written;
 * this module states how a transform is spelled in the URL a browser reads.
 * `src/lib/mediaUrl.ts` is the only consumer — it is the canonical resolver and
 * owns which URL gets requested. Keep the grammar here so the write side has a
 * single counterpart to stay in step with.
 */
export type OpeninaryConfig = { serverUrl: string; folderPrefix?: string };
export interface OpeninaryTransformOptions { width?: number; height?: number; crop?: string; quality?: string | number; format?: string; gravity?: string; aspectRatio?: string; dpr?: string | number; blur?: number; effect?: string }

export function buildOpeninaryTransform(o: OpeninaryTransformOptions = {}): string {
  const pairs: string[] = [];
  if (o.width) pairs.push(`w_${o.width}`); if (o.height) pairs.push(`h_${o.height}`);
  if (o.crop) pairs.push(`c_${o.crop}`); if (o.gravity) pairs.push(`g_${o.gravity}`);
  if (o.quality) pairs.push(`q_${o.quality}`); if (o.format) pairs.push(`f_${o.format}`);
  if (o.aspectRatio) pairs.push(`ar_${o.aspectRatio}`);
  // Deliberate: Openinary has no dpr_ or e_blur:. Blur placeholders use a tiny width instead.
  return pairs.join(",");
}

/** Openinary serves every rendition under a public `/t/` path. */
export function isOpeninaryUrl(url: string, serverUrl?: string): boolean {
  return Boolean(url && /^https?:\/\/[^/]+\/t\//.test(url) && (!serverUrl || url.startsWith(`${serverUrl.replace(/\/+$/, "")}/t/`)));
}
