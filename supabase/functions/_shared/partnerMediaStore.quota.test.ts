import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { partnerMediaQuotaRefusal } from "./partnerMediaStore.ts";

// Fake PostgREST boundary: the workspace owner lookup and the two quota RPCs.
function admin(rpcResults: Record<string, { data: unknown; error: unknown }> | "throws") {
  const workspaceQuery = {
    select: () => workspaceQuery,
    eq: () => workspaceQuery,
    maybeSingle: () => Promise.resolve({ data: { owner_id: "owner-1" }, error: null }),
  };
  return {
    from: () => workspaceQuery,
    rpc: (fn: string) => {
      if (rpcResults === "throws") return Promise.reject(new Error("network"));
      return Promise.resolve(rpcResults[fn]);
    },
  };
}

Deno.test("partner upload is refused before the idempotency claim when the owner's daily limit is spent", async () => {
  const refusal = await partnerMediaQuotaRefusal(admin({
    media_upload_quota_remaining: { data: 0, error: null },
    effective_user_quotas: { data: [{ max_media_uploads_per_day: 20 }], error: null },
  }), "ws-1");
  assertEquals(refusal, "Daily upload limit of 20 reached. Upgrade your plan or try again tomorrow.");
});

Deno.test("partner upload proceeds when slots remain or the quota read fails", async () => {
  for (const results of [
    { media_upload_quota_remaining: { data: 3, error: null } },
    { media_upload_quota_remaining: { data: null, error: null } },
    "throws" as const,
  ]) {
    assertEquals(await partnerMediaQuotaRefusal(admin(results as never), "ws-1"), null);
  }
});
