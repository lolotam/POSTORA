import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MEDIA_QUOTA_CODE, mediaQuotaBody } from "../_shared/mediaQuotaError.ts";
import { mediaQuotaPreflight, quotaInsertRefusal, type QuotaRpc } from "./mediaQuota.ts";

function rpc(handlers: Record<string, { data: unknown; error: { message?: string } | null }>): QuotaRpc {
  return {
    rpc: (fn) => Promise.resolve(handlers[fn] ?? { data: null, error: { message: "unexpected " + fn } }),
  };
}

Deno.test("remaining 0 refuses before a provider callback runs", async () => {
  const providers: string[] = [];
  const blocked = await mediaQuotaPreflight(rpc({
    media_upload_quota_remaining: { data: 0, error: null },
    effective_user_quotas: { data: [{ max_media_uploads_per_day: 5 }], error: null },
  }), "user-1");
  if (blocked) {
    const body = mediaQuotaBody(blocked.limit);
    assertEquals(body, {
      success: false,
      error: "Daily upload limit of 5 reached. Upgrade your plan or try again tomorrow.",
      code: MEDIA_QUOTA_CODE,
    });
  } else {
    providers.push("openinary");
  }
  assertEquals(providers, []);
  assertEquals(blocked, { limit: 5 });
});

Deno.test("a quota read error, a null remaining, and slots left all proceed", async () => {
  assertEquals(await mediaQuotaPreflight(rpc({
    media_upload_quota_remaining: { data: null, error: { message: "down" } },
  }), "user-1"), null);

  assertEquals(await mediaQuotaPreflight(rpc({
    media_upload_quota_remaining: { data: null, error: null },
  }), "user-1"), null);

  assertEquals(await mediaQuotaPreflight(rpc({
    media_upload_quota_remaining: { data: 3, error: null },
  }), "user-1"), null);
});

Deno.test("remaining 0 with an unreadable limit fails open", async () => {
  assertEquals(await mediaQuotaPreflight(rpc({
    media_upload_quota_remaining: { data: 0, error: null },
    effective_user_quotas: { data: null, error: { message: "down" } },
  }), "user-1"), null);

  assertEquals(await mediaQuotaPreflight(rpc({
    media_upload_quota_remaining: { data: 0, error: null },
    effective_user_quotas: { data: [{ max_media_uploads_per_day: -1 }], error: null },
  }), "user-1"), null);
});

Deno.test("an insert refusal cleans up and returns 429", async () => {
  let cleaned = 0;
  const outcome = await quotaInsertRefusal(
    "MEDIA_QUOTA_DAILY_EXCEEDED: Daily upload limit of 5 reached. Upgrade your plan or try again tomorrow.",
    () => {
      cleaned += 1;
      return Promise.resolve();
    },
  );
  assertEquals(cleaned, 1);
  assertEquals(outcome?.status, 429);
  assertEquals(outcome?.body.error, "Daily upload limit of 5 reached. Upgrade your plan or try again tomorrow.");
  assertEquals(outcome?.body.code, MEDIA_QUOTA_CODE);
});

Deno.test("a different insert error does not clean up", async () => {
  let cleaned = 0;
  const outcome = await quotaInsertRefusal("duplicate key value", () => {
    cleaned += 1;
    return Promise.resolve();
  });
  assertEquals(outcome, null);
  assertEquals(cleaned, 0);
});
