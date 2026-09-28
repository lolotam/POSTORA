import { isDisabledCloudResponse, type CloudinaryResourceType, type DestroyResult } from "./mediaDeletePlan.ts";

/** Cloudinary destroy never waits longer than this, even when the caller has budget left. */
export const CLOUDINARY_DESTROY_TIMEOUT_MS = 10_000;

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export interface DestroyCloudinaryOptions {
  /** Aborts the call early. Combined with the timeout below. */
  signal?: AbortSignal;
  /** Capped at {@link CLOUDINARY_DESTROY_TIMEOUT_MS}. */
  timeoutMs?: number;
  credentials?: CloudinaryCredentials | null;
  fetchImpl?: typeof fetch;
}

function credentialsFromEnv(): CloudinaryCredentials | null {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  if (!cloudName || !apiKey || !apiSecret) return null;
  return { cloudName, apiKey, apiSecret };
}

function abortAfter(ms: number, parent?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onParent = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/**
 * Destroy one Cloudinary object. A disabled cloud counts as gone: the object is
 * unreachable for everyone. Missing credentials are a failure, not that case.
 */
export async function destroyCloudinary(
  objectKey: string,
  resourceType: CloudinaryResourceType,
  options: DestroyCloudinaryOptions = {},
): Promise<DestroyResult> {
  const credentials = options.credentials === undefined ? credentialsFromEnv() : options.credentials;
  if (!credentials) return { success: false, error: "cloudinary credentials unavailable" };

  const timeoutMs = Math.min(
    options.timeoutMs ?? CLOUDINARY_DESTROY_TIMEOUT_MS,
    CLOUDINARY_DESTROY_TIMEOUT_MS,
  );
  if (timeoutMs <= 0 || options.signal?.aborted) return { success: false, error: "timed out" };

  const timestamp = Math.floor(Date.now() / 1000);
  const signatureParams = [`public_id=${objectKey}`, `timestamp=${timestamp}`].sort().join("&");
  const signData = new TextEncoder().encode(signatureParams + credentials.apiSecret);
  const hashBuffer = await crypto.subtle.digest("SHA-1", signData);
  const signature = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const formData = new FormData();
  formData.append("public_id", objectKey);
  formData.append("api_key", credentials.apiKey);
  formData.append("timestamp", timestamp.toString());
  formData.append("signature", signature);

  const abort = abortAfter(timeoutMs, options.signal);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      `https://api.cloudinary.com/v1_1/${credentials.cloudName}/${resourceType}/destroy`,
      { method: "POST", body: formData, signal: abort.signal },
    );
    const result = await response.json().catch(() => ({}));
    if (result.result === "ok" || result.result === "not found") return { success: true, reason: "removed" };
    if (isDisabledCloudResponse(response.status, result?.error?.message)) return { success: true, reason: "provider_disabled" };
    return { success: false, error: result?.error?.message || `HTTP ${response.status}` };
  } catch (error) {
    if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { success: false, error: "timed out" };
    }
    return { success: false, error: "cloudinary destroy failed" };
  } finally {
    abort.cancel();
  }
}
