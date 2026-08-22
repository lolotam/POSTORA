import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseSubscriptionFilters } from "./webhookFilters.ts";

Deno.test("no filters → empty object", () => {
  assertEquals(parseSubscriptionFilters({}), { ok: true, filters: {} });
});

Deno.test("valid platform is kept", () => {
  assertEquals(parseSubscriptionFilters({ platform: "threads" }), { ok: true, filters: { platform: "threads" } });
});

Deno.test("unknown platform is rejected", () => {
  assertEquals(parseSubscriptionFilters({ platform: "myspace" }), { ok: false, error: "platform must be one of facebook, instagram, threads, whatsapp" });
});

Deno.test("social_account_id must be a UUID", () => {
  assertEquals(parseSubscriptionFilters({ social_account_id: "nope" }), { ok: false, error: "social_account_id must be a UUID" });
  assertEquals(
    parseSubscriptionFilters({ social_account_id: "3f2b1a0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c" }),
    { ok: true, filters: { social_account_id: "3f2b1a0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c" } },
  );
});
