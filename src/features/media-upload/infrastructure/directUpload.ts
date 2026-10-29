/**
 * Browser-direct upload for files over the 10 MB edge-function cap.
 *
 * media-direct-upload `start` returns signed targets for the providers chosen in
 * Settings → CDN storage (Openinary first). The file goes straight to each one,
 * then `complete` confirms it and records the library row.
 */

import { supabase } from "@/integrations/supabase/client";
import { combinedProgress } from "../domain/chunks";
import {
  uploadToCloudinary,
  uploadToOpeninary,
  type CloudinaryResult,
  type UploadTarget,
} from "./providerUploads";
import { xhrPostForm, type PostForm } from "./transport";

/** Same shape cloudinary-upload returns, so callers handle both paths alike. */
export interface MediaUploadResult {
  success: true;
  url: string;
  mediaFileId: string;
  publicId?: string;
  bytes?: number;
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
  partial?: boolean;
}

type Invoke = (body: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;

export interface DirectUploadDeps {
  invoke: Invoke;
  postForm: PostForm;
}

const defaultDeps: DirectUploadDeps = {
  invoke: (body) => supabase.functions.invoke("media-direct-upload", { body }),
  postForm: xhrPostForm,
};

async function messageOf(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    const payload = await context.clone().json().catch(() => null) as { error?: unknown } | null;
    if (typeof payload?.error === "string") return payload.error;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

async function call<T>(deps: DirectUploadDeps, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await deps.invoke(body);
  if (error) throw new Error(await messageOf(error, fallback));
  const payload = data as { success?: boolean; error?: string } | null;
  if (!payload?.success) throw new Error(payload?.error || fallback);
  return payload as T;
}

export async function uploadLargeMedia(
  file: File,
  onProgress: (percent: number) => void = () => {},
  deps: DirectUploadDeps = defaultDeps,
): Promise<MediaUploadResult> {
  const started = await call<{ session: string; targets: UploadTarget[] }>(
    deps,
    { action: "start", fileName: file.name, size: file.size, mimeType: file.type || null },
    "Could not start the upload",
  );

  const results: { openinary?: { path: string }; cloudinary?: CloudinaryResult } = {};
  const failures: Partial<Record<UploadTarget["provider"], string>> = {};
  const total = started.targets.length;
  for (const [index, target] of started.targets.entries()) {
    const report = (fraction: number) => onProgress(combinedProgress(index, fraction, total));
    try {
      if (target.provider === "openinary") results.openinary = await uploadToOpeninary(target, file, deps.postForm, report);
      else results.cloudinary = await uploadToCloudinary(target, file, deps.postForm, report);
    } catch (error) {
      // One provider failing is not the end: `complete` keeps whichever copy landed.
      failures[target.provider] = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    }
  }
  if (!results.openinary && !results.cloudinary) {
    throw new Error(Object.values(failures)[0] || "Upload failed");
  }

  return call<MediaUploadResult>(
    deps,
    { action: "complete", session: started.session, results, failures },
    "Could not save the upload",
  );
}
