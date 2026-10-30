import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseCdnPolicy } from "../cloudinary-upload/providerPolicy.ts";
import {
  BACKGROUND_REMOVAL_UNAVAILABLE_MESSAGE,
  UPSCALE_UNAVAILABLE_MESSAGE,
  cloudinaryUsableForTransforms,
  resolveBackgroundRemovalProvider,
  resolveCloudinaryUsable,
  resolveUpscaleProvider,
} from "./aiImageProviders.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const openinaryOnly = parseCdnPolicy({ write_policy: { providers: ["openinary"] }, openinary: { enabled: true } });
const withCloudinary = parseCdnPolicy({ write_policy: { providers: ["openinary", "cloudinary"] }, openinary: { enabled: true } });

Deno.test("credentials alone do not make Cloudinary usable when the policy writes only to Openinary", () => {
  assertEquals(cloudinaryUsableForTransforms(openinaryOnly, { cloudinaryConfigured: true, openinaryConfigured: true }), false);
});

Deno.test("an unset policy behaves like the upload path: Cloudinary only as the fallback, and only with credentials", () => {
  assertEquals(cloudinaryUsableForTransforms(parseCdnPolicy(null), { cloudinaryConfigured: true, openinaryConfigured: true }), true);
  assertEquals(cloudinaryUsableForTransforms(parseCdnPolicy(null), { cloudinaryConfigured: false, openinaryConfigured: true }), false);
});

Deno.test("Cloudinary is usable when the policy lists it and its credentials exist", () => {
  assertEquals(cloudinaryUsableForTransforms(withCloudinary, { cloudinaryConfigured: true, openinaryConfigured: true }), true);
});

Deno.test("a policy that lists Cloudinary is not enough without credentials", () => {
  assertEquals(cloudinaryUsableForTransforms(withCloudinary, { cloudinaryConfigured: false, openinaryConfigured: true }), false);
});

Deno.test("when Openinary cannot take the write, the upload path falls back to Cloudinary and so do the AI tools", () => {
  assertEquals(cloudinaryUsableForTransforms(openinaryOnly, { cloudinaryConfigured: true, openinaryConfigured: false }), true);
});

Deno.test("upscale: default request uses Cloudinary while it is usable", () => {
  for (const requested of [undefined, "auto", "cloudinary", "something-else"]) {
    assertEquals(resolveUpscaleProvider({ requested, cloudinaryUsable: true, atlasConfigured: true }), {
      ok: true,
      provider: "cloudinary",
      fellBackFromCloudinary: false,
    });
  }
});

Deno.test("upscale: an explicit atlascloud request always uses AtlasCloud", () => {
  assertEquals(resolveUpscaleProvider({ requested: "atlascloud", cloudinaryUsable: true, atlasConfigured: true }), {
    ok: true,
    provider: "atlascloud",
    fellBackFromCloudinary: false,
  });
});

Deno.test("upscale: with Cloudinary unusable, the default request goes to AtlasCloud", () => {
  assertEquals(resolveUpscaleProvider({ requested: undefined, cloudinaryUsable: false, atlasConfigured: true }), {
    ok: true,
    provider: "atlascloud",
    fellBackFromCloudinary: false,
  });
});

Deno.test("upscale: an explicit cloudinary request falls back to AtlasCloud and says so", () => {
  assertEquals(resolveUpscaleProvider({ requested: "cloudinary", cloudinaryUsable: false, atlasConfigured: true }), {
    ok: true,
    provider: "atlascloud",
    fellBackFromCloudinary: true,
  });
});

Deno.test("upscale: no usable provider is unavailable, with the reason for the log", () => {
  assertEquals(resolveUpscaleProvider({ requested: undefined, cloudinaryUsable: false, atlasConfigured: false }), {
    ok: false,
    message: UPSCALE_UNAVAILABLE_MESSAGE,
    reason: "no_provider_usable",
  });
});

Deno.test("upscale: an explicit atlascloud request without a key is unavailable even if Cloudinary works", () => {
  assertEquals(resolveUpscaleProvider({ requested: "atlascloud", cloudinaryUsable: true, atlasConfigured: false }), {
    ok: false,
    message: UPSCALE_UNAVAILABLE_MESSAGE,
    reason: "atlascloud_not_configured",
  });
});

Deno.test("background removal: Cloudinary while usable, else AtlasCloud, else unavailable", () => {
  assertEquals(resolveBackgroundRemovalProvider({ cloudinaryUsable: true, atlasConfigured: true }), { ok: true, provider: "cloudinary" });
  assertEquals(resolveBackgroundRemovalProvider({ cloudinaryUsable: false, atlasConfigured: true }), { ok: true, provider: "atlascloud" });
  assertEquals(resolveBackgroundRemovalProvider({ cloudinaryUsable: false, atlasConfigured: false }), {
    ok: false,
    message: BACKGROUND_REMOVAL_UNAVAILABLE_MESSAGE,
    reason: "no_provider_usable",
  });
});

/** A db whose app_settings read answers `{ data, error }`. */
function dbAnswering(answer: { data: unknown; error: { message: string } | null }): SupabaseClient {
  const query = { select: () => query, eq: () => query, maybeSingle: () => Promise.resolve(answer) };
  return { from: () => query } as unknown as SupabaseClient;
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) setEnv(k, v);
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(before)) setEnv(k, v);
  }
}

const cloudinaryEnv = {
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "fixture-value-1",
  CLOUDINARY_API_SECRET: "fixture-value-2",
  OPENINARY_SERVER_URL: "https://o.example",
  OPENINARY_API_KEY: "fixture-value-3",
};

Deno.test("resolveCloudinaryUsable follows the stored policy: Openinary only means no, Cloudinary listed means yes", async () => {
  await withEnv(cloudinaryEnv, async () => {
    const only = { write_policy: { providers: ["openinary"] }, openinary: { enabled: true } };
    const both = { write_policy: { providers: ["openinary", "cloudinary"] }, openinary: { enabled: true } };
    assertEquals(await resolveCloudinaryUsable(dbAnswering({ data: { value: only }, error: null })), false);
    assertEquals(await resolveCloudinaryUsable(dbAnswering({ data: { value: both }, error: null })), true);
  });
});

Deno.test("resolveCloudinaryUsable fails closed when the policy cannot be read", async () => {
  await withEnv(cloudinaryEnv, async () => {
    assertEquals(await resolveCloudinaryUsable(dbAnswering({ data: null, error: { message: "connection reset" } })), false);
  });
});

Deno.test("resolveCloudinaryUsable is false without Cloudinary credentials, whatever the policy says", async () => {
  await withEnv({ ...cloudinaryEnv, CLOUDINARY_API_SECRET: undefined }, async () => {
    const both = { write_policy: { providers: ["openinary", "cloudinary"] }, openinary: { enabled: true } };
    assertEquals(await resolveCloudinaryUsable(dbAnswering({ data: { value: both }, error: null })), false);
  });
});
