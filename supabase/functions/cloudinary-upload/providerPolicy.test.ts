import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { orderWriteProviders, parseCdnPolicy } from "./providerPolicy.ts";

Deno.test("an unreadable setting falls back to Openinary, never to Cloudinary", () => {
  assertEquals(parseCdnPolicy(null), { providers: ["openinary"], required: ["openinary"], readPreference: "openinary", openinaryEnabled: false });
});

Deno.test("Openinary is written first whatever order the setting lists", () => {
  const policy = parseCdnPolicy({ write_policy: { providers: ["cloudinary", "openinary"] }, openinary: { enabled: true } });
  assertEquals(orderWriteProviders(policy, { cloudinary: true, openinaryConfigured: true }), ["openinary", "cloudinary"]);
});

Deno.test("a disabled or unconfigured Openinary is skipped", () => {
  const disabled = parseCdnPolicy({ write_policy: { providers: ["openinary", "cloudinary"] }, openinary: { enabled: false } });
  assertEquals(orderWriteProviders(disabled, { cloudinary: true, openinaryConfigured: true }), ["cloudinary"]);
  const enabled = parseCdnPolicy({ write_policy: { providers: ["openinary"] }, openinary: { enabled: true } });
  assertEquals(orderWriteProviders(enabled, { cloudinary: true, openinaryConfigured: false }), ["cloudinary"]);
  assertEquals(orderWriteProviders(enabled, { cloudinary: false, openinaryConfigured: false }), []);
});
