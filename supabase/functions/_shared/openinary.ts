/**
 * This module decides where bytes are written; src/lib/openinary.ts derives the URL a browser reads. Change one and change the other, or reads stop finding writes.
 */

import { sniffBytesMimeType } from "./base64Media.ts";

export interface OpeninaryConfig { serverUrl: string; apiKey: string; folderPrefix: string }
export interface OpeninaryFile { name: string; path: string; size: number; mtime?: string }
export interface OpeninaryUploadResult { success: boolean; path?: string; url?: string; adopted?: boolean; error?: string }

const TYPES: Record<string, string> = {
  "image/avif":"avif", "image/gif":"gif", "image/heic":"heic", "image/heif":"heif",
  "image/jpeg":"jpg", "image/jpg":"jpg", "image/png":"png", "image/webp":"webp",
  "model/gltf-binary":"glb", "model/gltf+json":"gltf", "video/quicktime":"mov",
  "video/mp4":"mp4", "video/webm":"webm", "audio/mpeg":"mp3", "audio/ogg":"ogg",
  "audio/wav":"wav", "image/vnd.adobe.photoshop":"psd",
};

export function getOpeninaryConfig(): OpeninaryConfig | null {
  const serverUrl = Deno.env.get("OPENINARY_SERVER_URL")?.replace(/\/+$/, "");
  const apiKey = Deno.env.get("OPENINARY_API_KEY");
  if (!serverUrl || !apiKey) return null;
  return { serverUrl, apiKey, folderPrefix: (Deno.env.get("OPENINARY_FOLDER_PREFIX") || "postora.cloud").replace(/^\/+|\/+$/g, "") };
}

export function extensionForContentType(contentType: string | null): string | null {
  return contentType ? TYPES[contentType.split(";")[0].trim().toLowerCase()] ?? null : null;
}

export function encodeOpeninaryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").split("/").map((s) => encodeURIComponent(s)).join("/");
}

export function openinaryTarget(publicId: string, folderPrefix = "postora.cloud"): { folder: string; baseName: string } {
  const parts = publicId.split("/").filter(Boolean);
  return { folder: [folderPrefix.replace(/^\/+|\/+$/g, ""), ...parts.slice(0, -1)].filter(Boolean).join("/"), baseName: parts.at(-1) || "image" };
}

// Reverse of TYPES: extension -> the content-type the type is stored and served with.
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(TYPES).map(([mime, ext]) => [ext, mime]),
);

const SVG_MIME = "image/svg+xml";

/**
 * SVG is deliberately excluded from Openinary's upload whitelist (stored-XSS
 * vector when served inline), so an attempt can never succeed. Detecting it here
 * lets callers refuse with that reason instead of a misleading content-mismatch
 * 400 from the server.
 */
function looksLikeSvg(bytes: Uint8Array | null, headerType: string | null): boolean {
  if (headerType?.split(";")[0].trim().toLowerCase() === SVG_MIME) return true;
  if (!bytes) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

export interface DerivedUploadType {
  ext: string;
  mimeType: string;
  /** Set when the content can never be stored on Openinary, with the reason. */
  unsupportedReason?: string;
}

/**
 * Resolves the extension and content-type an Openinary upload must claim for
 * these bytes.
 *
 * Openinary validates file content against the extension it is stored under, so
 * the claim has to describe the bytes, not the filename — a caller passing
 * "app_logo" (no extension) used to default to .jpg and be rejected with 400
 * whenever the logo was a PNG or WebP. Evidence order: magic bytes (a header
 * can lie, octet-stream is common), then the origin's content-type, then the
 * caller's filename-derived fallback.
 *
 * ISO-BMFF containers (mp4/mov/avif/heic) share one box signature the sniffer
 * reports as video/mp4, so a header naming one of the other brands wins there.
 */
export function deriveOpeninaryUploadType(
  bytes: Uint8Array | null,
  headerType: string | null,
  fallbackExt: string,
): DerivedUploadType {
  const headerBase = headerType ? headerType.split(";")[0].trim().toLowerCase() : null;
  const headerExt = extensionForContentType(headerBase);
  const sniffed = bytes ? sniffBytesMimeType(bytes) : null;

  let ext: string | null;
  if (sniffed === "video/mp4" && headerExt && ["avif", "heic", "heif", "mov"].includes(headerExt)) {
    ext = headerExt === "heif" ? "heic" : headerExt;
  } else {
    ext = (sniffed && extensionForContentType(sniffed)) || headerExt || fallbackExt;
  }

  if (looksLikeSvg(bytes, headerBase)) {
    return {
      ext,
      mimeType: SVG_MIME,
      unsupportedReason: "SVG is not supported by the CDN — use a PNG, WebP, or JPEG logo",
    };
  }

  const mimeType = sniffed ??
    (headerExt ? headerBase! : MIME_BY_EXT[ext] ?? "application/octet-stream");
  return { ext, mimeType };
}

/** Reads the failure reason out of an Openinary upload response body. */
export function openinaryUploadError(result: unknown, status: number): string {
  const body = result as { error?: unknown; errors?: { error?: unknown }[] } | null;
  if (typeof body?.error === "string" && body.error) return body.error;
  const listed = body?.errors?.map((e) => (typeof e?.error === "string" ? e.error : null)).filter(Boolean);
  if (listed && listed.length) return listed.join("; ");
  return String(status);
}

export function openinaryDeliveryUrl(config: OpeninaryConfig, path: string): string {
  return `${config.serverUrl}/t/${encodeOpeninaryPath(path)}`;
}

export function shouldAdoptOpeninaryFile(file: OpeninaryFile | undefined, requestedPath: string, expectedByteCount: number): boolean {
  return !!file && file.path === requestedPath && file.size === expectedByteCount;
}

async function request(url: string, init: RequestInit = {}, timeout = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
}

export async function listOpeninaryFolder(config: OpeninaryConfig, folder: string): Promise<OpeninaryFile[]> {
  const response = await request(`${config.serverUrl}/api/storage?path=${encodeURIComponent(folder)}`, { headers: { Authorization: `Bearer ${config.apiKey}` } });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Openinary listing failed: ${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.files) ? data.files.filter((f: OpeninaryFile) => typeof f?.name === "string" && typeof f?.path === "string" && Number.isFinite(f?.size)) : [];
}

export async function deleteFromOpeninary(config: OpeninaryConfig, path: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await request(`${config.serverUrl}/api/storage/${encodeOpeninaryPath(path)}`, { method: "DELETE", headers: { Authorization: `Bearer ${config.apiKey}` } });
    if (response.status === 404 || response.ok) return { success: true };
    return { success: false, error: `Openinary delete failed: ${response.status}` };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function uploadToOpeninary(config: OpeninaryConfig, imageUrl: string, folder: string, baseName: string, requiredExtension?: string, expectedByteCount?: number): Promise<OpeninaryUploadResult> {
  try {
    const source = await request(imageUrl, {}, 30_000);
    if (!source.ok) return { success: false, error: `Source fetch failed: ${source.status}` };
    const contentType = source.headers.get("content-type")?.split(";")[0].trim() || null;
    const extension = extensionForContentType(contentType);
    if (!extension) return { success: false, error: `Unsupported content type: ${contentType || "unknown"}` };
    if (requiredExtension && requiredExtension.toLowerCase().replace("jpeg", "jpg") !== extension) return { success: false, error: `Content type resolves to .${extension}, expected .${requiredExtension}` };
    const body = await source.blob();
    if (!body.size) return { success: false, error: "Source returned an empty body" };
    return await storeOpeninaryObject(config, body, folder, baseName, requiredExtension || extension, expectedByteCount);
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

/**
 * Direct byte upload (Openinary-priority path): no upstream URL required.
 * Same ADOPT-BEFORE-UPLOAD / COLLISION-AS-FAILURE semantics as uploadToOpeninary.
 */
export async function uploadBytesToOpeninary(config: OpeninaryConfig, data: Blob | Uint8Array, folder: string, baseName: string, extension: string, mimeType?: string, expectedByteCount?: number): Promise<OpeninaryUploadResult> {
  try {
    // The slice() is a type fix, not a copy for its own sake: a Uint8Array can be backed by a
    // SharedArrayBuffer, which BlobPart does not accept, and newer lib.dom types reject the
    // union outright. Slicing yields a Uint8Array whose buffer is a plain ArrayBuffer.
    const body = data instanceof Blob
      ? data
      : new Blob([data.slice().buffer as ArrayBuffer], { type: mimeType || "application/octet-stream" });
    if (!body.size) return { success: false, error: "Empty upload body" };
    return await storeOpeninaryObject(config, body, folder, baseName, extension, expectedByteCount);
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

async function storeOpeninaryObject(config: OpeninaryConfig, body: Blob, folder: string, baseName: string, extension: string, expectedByteCount?: number): Promise<OpeninaryUploadResult> {
  const fileName = `${baseName}.${extension}`;
  const expectedSize = expectedByteCount ?? body.size;
  // ADOPT-BEFORE-UPLOAD: exact object identity (path + byte count) means the prior upload succeeded; upload nothing on retry.
  const existing = await listOpeninaryFolder(config, folder);
  const match = existing.find((file) => file.name === fileName && shouldAdoptOpeninaryFile(file, `${folder}/${fileName}`, expectedSize));
  if (match) return { success: true, adopted: true, path: match.path, url: openinaryDeliveryUrl(config, match.path) };
  const form = new FormData(); form.append("folder", folder); form.append("files", new File([body], fileName, { type: body.type || "application/octet-stream" }));
  const response = await request(`${config.serverUrl}/api/upload`, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}` }, body: form }, 120_000);
  const result = await response.json().catch(() => null);
  // The upload API reports failures as { success: false, errors: [{ filename, error }] };
  // some callers also use a flat `error`. Read both or the real reason is swallowed
  // and admins only ever see the status code.
  const serverError = result?.error
    || (Array.isArray(result?.errors) ? result.errors.map((e: { error?: string }) => e?.error).filter(Boolean).join("; ") : "")
    || "";
  if (!response.ok || !result?.success) return { success: false, error: `Openinary upload failed: ${serverError || response.status}` };
  const stored = result.files?.[0]?.path;
  const requested = `${folder}/${fileName}`;
  // COLLISION-AS-FAILURE: a suffixed path is unreachable by the deterministic read URL.
  if (typeof stored !== "string") return { success: false, error: "Openinary upload returned no stored path" };
  if (stored !== requested) return { success: false, path: stored, error: `Openinary stored "${stored}" instead of requested "${requested}" (collision rename)` };
  return { success: true, path: stored, url: openinaryDeliveryUrl(config, stored) };
}

export async function openinaryHealthCheck(config: OpeninaryConfig): Promise<{ ok: boolean; moved?: string[]; error?: string }> {
  const base = `${config.folderPrefix}/_healthcheck/${crypto.randomUUID()}`; const moved: string[] = []; const paths: string[] = [];
  try {
    const data = new Blob([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (c) => c.charCodeAt(0))], { type: "image/png" });
    const upload = async (name: string, type = "image/png") => { const form = new FormData(); form.append("folder", base); form.append("files", new File([data], name, { type })); const r = await request(`${config.serverUrl}/api/upload`, { method:"POST", headers:{Authorization:`Bearer ${config.apiKey}`}, body:form }); const j=await r.json().catch(()=>null); if(!r.ok||!j?.success) throw new Error(`upload behavior moved: ${j?.error||r.status}`); return j.files?.[0]?.path as string; };
    const first = await upload("probe.png"); paths.push(first); if (first !== `${base}/probe.png`) throw new Error(`path identity behavior moved: ${first}`);
    const delivery = await request(openinaryDeliveryUrl(config, first)); if (!delivery.ok) throw new Error(`delivery behavior moved: ${delivery.status}`);
    const second = await upload("probe.png"); paths.push(second); if (second === first) throw new Error("collision behavior moved: duplicate was not suffixed"); moved.push("collision suffix");
    const octet = await (async()=>{ const form=new FormData(); form.append("folder",base); form.append("files",new File([data],"octet.png",{type:"application/octet-stream"})); return request(`${config.serverUrl}/api/upload`,{method:"POST",headers:{Authorization:`Bearer ${config.apiKey}`},body:form}); })(); if (octet.ok) throw new Error("MIME rejection behavior moved: octet-stream accepted"); moved.push("MIME rejection");
    return { ok:true, moved };
  } catch(error) { return { ok:false, moved, error:error instanceof Error?error.message:String(error) }; } finally { for (const path of paths) { try { await deleteFromOpeninary(config,path); } catch { /* cleanup is best effort */ } } try { await deleteFromOpeninary(config,base); } catch { } }
}
