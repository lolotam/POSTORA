// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PartnerAuthError } from "./partnerApiKeys.ts";
import { recordUsage, releaseQuota, reserveQuota } from "./partnerApiMetering.ts";

const RECORD = {
  id: "key-1", workspaceId: "ws-1", socialAccountId: "acct-1",
  keyPrefix: "pk_live_abcd", scopes: ["whatsapp:template.send"],
  rateLimitPerMin: 60, monthlyQuota: 100, expiresAt: null, revokedAt: null,
};

function stubRpc(result: { allowed: boolean; usage_count: number }) {
  return {
    rpc() { return Promise.resolve({ data: [result], error: null }); },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("reserveQuota returns true when the key is under quota", async () => {
  assertEquals(await reserveQuota(stubRpc({ allowed: true, usage_count: 5 }), RECORD), true);
});

Deno.test("reserveQuota returns false when the reservation exceeds quota", async () => {
  assertEquals(await reserveQuota(stubRpc({ allowed: false, usage_count: 101 }), RECORD), false);
});

Deno.test("releaseQuota refunds a reservation without throwing", async () => {
  let called = false;
  const client = { rpc() { called = true; return Promise.resolve({ error: null }); } } as any;
  await releaseQuota(client, RECORD);
  assertEquals(called, true);
});

Deno.test("recordUsage writes one row with the billable flag it was given", async () => {
  const inserted: unknown[] = [];
  const client = {
    from() {
      return { insert(row: unknown) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;

  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "send_template",
    billable: true, httpStatus: 200,
  });

  assertEquals(inserted.length, 1);
  assertEquals((inserted[0] as Record<string, unknown>).billable, true);
  assertEquals((inserted[0] as Record<string, unknown>).action, "send_template");
});

Deno.test("recordUsage never throws — metering must not fail a real send", async () => {
  const client = {
    from() {
      return { insert() { return Promise.resolve({ error: { message: "boom" } }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "send_template",
    billable: true, httpStatus: 200,
  });
});
