export interface OpeninaryConfig { serverUrl: string; folderPrefix?: string }
export interface OpeninaryTransformOptions { width?: number; height?: number; crop?: string; quality?: string | number; format?: string; gravity?: string; aspectRatio?: string; dpr?: string | number; blur?: number; effect?: string }
export const DEFAULT_OPENINARY_WIDTHS = [320, 640, 768, 1024, 1280, 1536];

const clean = (v: string) => v.replace(/\/+$/, "");
export function buildOpeninaryTransform(o: OpeninaryTransformOptions = {}): string {
  const pairs: string[] = [];
  if (o.width) pairs.push(`w_${o.width}`); if (o.height) pairs.push(`h_${o.height}`);
  if (o.crop) pairs.push(`c_${o.crop}`); if (o.gravity) pairs.push(`g_${o.gravity}`);
  if (o.quality) pairs.push(`q_${o.quality}`); if (o.format) pairs.push(`f_${o.format}`);
  if (o.aspectRatio) pairs.push(`ar_${o.aspectRatio}`);
  // Deliberate: Openinary has no dpr_ or e_blur:. Blur placeholders use a tiny width instead.
  return pairs.join(",");
}
function encodePath(path: string) { return path.split("/").map((s) => { try { return encodeURIComponent(decodeURIComponent(s)); } catch { return encodeURIComponent(s); } }).join("/"); }
export function getOpeninaryUrl(objectKey: string, options: OpeninaryTransformOptions = {}, cfg: OpeninaryConfig): string {
  if (!objectKey || !cfg?.serverUrl) return objectKey;
  const key = [cfg.folderPrefix?.replace(/^\/+|\/+$/g, ""), objectKey.replace(/^\/+/, "")].filter(Boolean).join("/");
  const transforms = buildOpeninaryTransform({ format: "auto", quality: "auto", ...options });
  return `${clean(cfg.serverUrl)}/t/${transforms ? `${transforms}/` : ""}${encodePath(key)}`;
}
export function isOpeninaryUrl(url: string, serverUrl?: string): boolean { return Boolean(url && /^https?:\/\/[^/]+\/t\//.test(url) && (!serverUrl || url.startsWith(`${clean(serverUrl)}/t/`))); }
export function getOpeninarySrcSet(key: string, cfg: OpeninaryConfig, widths = DEFAULT_OPENINARY_WIDTHS) { return widths.map((w) => `${getOpeninaryUrl(key, { width: w, crop: "limit" }, cfg)} ${w}w`).join(", "); }
export function getOpeninaryThumbnail(key: string, cfg: OpeninaryConfig, size = 150) { return getOpeninaryUrl(key, { width: size, height: size, crop: "thumb", gravity: "auto" }, cfg); }
export function getOpeninaryPlaceholder(key: string, cfg: OpeninaryConfig) { return getOpeninaryUrl(key, { width: 20 }, cfg); }
