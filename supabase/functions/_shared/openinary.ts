/**
 * This module decides where bytes are written; src/lib/openinary.ts derives the URL a browser reads. Change one and change the other, or reads stop finding writes.
 */

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

/**
 * Extension implied by the leading bytes of an image payload, or null when unrecognised.
 * Openinary compares the declared extension against the real content and rejects a
 * mismatch with HTTP 400, so a caller that only knows the bytes must ask them, not guess.
 */
export function extensionForBytes(data: Uint8Array): string | null {
  const startsWith = (offset: number, ...bytes: number[]) => bytes.every((b, i) => data[offset + i] === b);
  if (startsWith(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (startsWith(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (startsWith(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (startsWith(0, 0x52, 0x49, 0x46, 0x46) && startsWith(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

export function encodeOpeninaryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").split("/").map((s) => encodeURIComponent(s)).join("/");
}

export function openinaryTarget(publicId: string, folderPrefix = "postora.cloud"): { folder: string; baseName: string } {
  const parts = publicId.split("/").filter(Boolean);
  return { folder: [folderPrefix.replace(/^\/+|\/+$/g, ""), ...parts.slice(0, -1)].filter(Boolean).join("/"), baseName: parts.at(-1) || "image" };
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

export async function deleteFromOpeninary(config: OpeninaryConfig, path: string, timeoutMs = 30_000): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await request(`${config.serverUrl}/api/storage/${encodeOpeninaryPath(path)}`, { method: "DELETE", headers: { Authorization: `Bearer ${config.apiKey}` } }, timeoutMs);
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
  if (!response.ok || !result?.success) return { success: false, error: `Openinary upload failed: ${result?.error || result?.errors?.[0]?.error || response.status}` };
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
