/**
 * Where new media is written, read from the admin's `cdn_storage` setting.
 *
 * Shared by the edge-function upload (index.ts) and the browser-direct upload
 * (media-direct-upload), so both honour the same Settings → CDN storage choice.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type CdnPolicy = { providers: string[]; required: string[]; readPreference: string; openinaryEnabled: boolean };

/** The stored `cdn_storage` value; every field may be missing or malformed. */
interface CdnSetting {
  write_policy?: { providers?: unknown; required?: unknown };
  read_preference?: unknown;
  openinary?: { enabled?: unknown };
}

export async function getCdnPolicy(db: SupabaseClient): Promise<CdnPolicy> {
  const { data } = await db.from("app_settings").select("value").eq("key", "cdn_storage").maybeSingle();
  return parseCdnPolicy(data?.value);
}

export function parseCdnPolicy(value: unknown): CdnPolicy {
  const setting = (value || {}) as CdnSetting;
  const policy = setting.write_policy;
  // Openinary is the primary provider, so an unreadable setting falls back to
  // it. Defaulting to Cloudinary let a transient read error reinstate a provider
  // the admin had turned off — and mark it required, which then failed every
  // upload as partial against a cloud account that answers 401.
  return {
    providers: Array.isArray(policy?.providers) && policy.providers.length ? policy.providers as string[] : ["openinary"],
    required: Array.isArray(policy?.required) && policy.required.length ? policy.required as string[] : ["openinary"],
    readPreference: typeof setting.read_preference === "string" ? setting.read_preference : "openinary",
    openinaryEnabled: setting.openinary?.enabled === true,
  };
}

/**
 * The providers to write, Openinary first. A provider the policy names but this
 * runtime cannot reach is skipped; when none is left, whichever one is usable
 * takes the write so an upload is never refused over a stale setting.
 */
export function orderWriteProviders(
  policy: CdnPolicy,
  usable: { cloudinary: boolean; openinaryConfigured: boolean },
): string[] {
  const openinaryUsable = policy.openinaryEnabled && usable.openinaryConfigured;
  const ordered: string[] = [];
  if (policy.providers.includes("openinary") && openinaryUsable) ordered.push("openinary");
  for (const provider of policy.providers) {
    if (provider === "openinary" && !openinaryUsable) continue;
    if (provider === "cloudinary" && !usable.cloudinary) continue;
    ordered.push(provider);
  }
  const fallback = usable.cloudinary ? ["cloudinary"] : openinaryUsable ? ["openinary"] : [];
  return [...new Set(ordered.length ? ordered : fallback)];
}
