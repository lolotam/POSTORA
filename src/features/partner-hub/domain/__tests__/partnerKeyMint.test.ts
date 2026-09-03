import { describe, it, expect } from "vitest";
import { generatePartnerKey, KEY_PREFIX_BY_ENVIRONMENT } from "../partnerKeyMint";

// Browser twin of supabase/functions/_shared/partnerApiKeys.ts generatePartnerKey.
// The database enforces prefix<->environment and the 64-hex digest; this
// pins the shape the database will accept.
describe("generatePartnerKey", () => {
  it("mints a production key with the pk_live_ prefix and a 32-char base62 body", async () => {
    const { key, prefix, hash } = await generatePartnerKey("production");
    expect(key.startsWith(KEY_PREFIX_BY_ENVIRONMENT.production)).toBe(true);
    expect(key.slice(8)).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("mints a staging key with the pk_test_ prefix", async () => {
    const { key } = await generatePartnerKey("staging");
    expect(key.startsWith("pk_test_")).toBe(true);
  });
  it("hashes deterministically", async () => {
    const { hashPartnerKey } = await import("../partnerKeyMint");
    expect(await hashPartnerKey("pk_live_x")).toBe(await hashPartnerKey("pk_live_x"));
  });
  it("never mints the same key twice", async () => {
    const a = await generatePartnerKey("production");
    const b = await generatePartnerKey("production");
    expect(a.key).not.toBe(b.key);
  });
});
