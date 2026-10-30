/**
 * Which provider serves an AI image tool (upscale, background removal).
 *
 * Openinary is the main asset store and has no AI features, so these tools run on
 * Cloudinary only while the admin's CDN policy still writes to Cloudinary, and on
 * AtlasCloud otherwise. "Cloudinary is usable" is decided the way the upload path
 * decides it (`orderWriteProviders`), never from credentials alone: a disabled
 * Cloudinary account keeps its credentials in the environment.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { orderWriteProviders, parseCdnPolicy, type CdnPolicy } from "../cloudinary-upload/providerPolicy.ts";
import { getOpeninaryConfig } from "./openinary.ts";

export type UpscalePlatform = "cloudinary" | "atlascloud";
export type BackgroundRemovalPlatform = "cloudinary" | "atlascloud";

export const UPSCALE_UNAVAILABLE_MESSAGE = "Image upscaling is temporarily unavailable";
export const BACKGROUND_REMOVAL_UNAVAILABLE_MESSAGE = "Background removal is temporarily unavailable";

/** Stable machine code for "no provider can serve this right now" (HTTP 503). */
export const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE";

export type UpscaleDecision =
  | { ok: true; provider: UpscalePlatform; fellBackFromCloudinary: boolean }
  | { ok: false; message: string; reason: string };

export type BackgroundRemovalDecision =
  | { ok: true; provider: BackgroundRemovalPlatform }
  | { ok: false; message: string; reason: string };

/** True when the upload path would write to Cloudinary under this policy and runtime. */
export function cloudinaryUsableForTransforms(
  policy: CdnPolicy,
  env: { cloudinaryConfigured: boolean; openinaryConfigured: boolean },
): boolean {
  return orderWriteProviders(policy, { cloudinary: env.cloudinaryConfigured, openinaryConfigured: env.openinaryConfigured })
    .includes("cloudinary");
}

/**
 * Reads the admin policy and the runtime config. Unlike the upload path (whose reader
 * turns a failed read into the default policy), a failed read here counts as "not usable":
 * the tools then take AtlasCloud instead of sending a paid request to an account that may
 * be disabled.
 */
export async function resolveCloudinaryUsable(db: SupabaseClient): Promise<boolean> {
  const cloudinaryConfigured = !!(
    Deno.env.get("CLOUDINARY_CLOUD_NAME") && Deno.env.get("CLOUDINARY_API_KEY") && Deno.env.get("CLOUDINARY_API_SECRET")
  );
  if (!cloudinaryConfigured) return false;
  try {
    const { data, error } = await db.from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
    if (error) throw new Error(error.message);
    return cloudinaryUsableForTransforms(parseCdnPolicy(data?.value), { cloudinaryConfigured, openinaryConfigured: !!getOpeninaryConfig() });
  } catch (error) {
    console.warn(JSON.stringify({ event: "cdn_policy_read_failed", error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

/**
 * `requested` is the caller's `platform` field. Anything other than "atlascloud" and
 * "cloudinary" (including omitted and "auto") means "pick for me", which keeps the
 * old behaviour of unknown values landing on the default path.
 */
export function resolveUpscaleProvider(input: {
  requested: unknown;
  cloudinaryUsable: boolean;
  atlasConfigured: boolean;
}): UpscaleDecision {
  const { requested, cloudinaryUsable, atlasConfigured } = input;
  const unavailable = (reason: string): UpscaleDecision => ({ ok: false, message: UPSCALE_UNAVAILABLE_MESSAGE, reason });

  if (requested === "atlascloud") {
    return atlasConfigured ? { ok: true, provider: "atlascloud", fellBackFromCloudinary: false } : unavailable("atlascloud_not_configured");
  }
  if (cloudinaryUsable) return { ok: true, provider: "cloudinary", fellBackFromCloudinary: false };
  if (atlasConfigured) return { ok: true, provider: "atlascloud", fellBackFromCloudinary: requested === "cloudinary" };
  return unavailable("no_provider_usable");
}

export function resolveBackgroundRemovalProvider(input: {
  cloudinaryUsable: boolean;
  atlasConfigured: boolean;
}): BackgroundRemovalDecision {
  if (input.cloudinaryUsable) return { ok: true, provider: "cloudinary" };
  if (input.atlasConfigured) return { ok: true, provider: "atlascloud" };
  return { ok: false, message: BACKGROUND_REMOVAL_UNAVAILABLE_MESSAGE, reason: "no_provider_usable" };
}
