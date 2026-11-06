import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { activeRetryRequest } from "./publishRequest.ts";

const requestedAt = "2026-11-06T11:00:00+00:00";
const marker = { requested_at: requestedAt, account_ids: ["account-1"], platforms: ["instagram"] };

Deno.test("retry targets match equivalent ISO spellings of the request instant", () => {
  assertEquals(activeRetryRequest({
    publish_requested_at: "2026-11-06T14:00:00.000+03:00",
    metadata: { retry_request: marker },
  }), { requestedAt, accountIds: ["account-1"], platforms: ["instagram"] });
});

Deno.test("a stale retry marker cannot target a later publish request", () => {
  assertEquals(activeRetryRequest({
    publish_requested_at: "2026-11-06T11:00:01Z", metadata: { retry_request: marker },
  }), null);
});

Deno.test("missing or malformed retry metadata does not activate retry mode", () => {
  for (const metadata of [undefined, null, [], "garbage", {}, { retry_request: null },
    { retry_request: "garbage" }, { retry_request: { ...marker, requested_at: "invalid" } }]) {
    assertEquals(activeRetryRequest({ publish_requested_at: requestedAt, metadata }), null);
  }
  for (const stamp of [undefined, null, "invalid"]) {
    assertEquals(activeRetryRequest({ publish_requested_at: stamp, metadata: { retry_request: marker } }), null);
  }
});

Deno.test("retry targets require non-empty arrays of non-empty strings", () => {
  for (const field of ["account_ids", "platforms"]) {
    for (const invalid of [undefined, [], "instagram", [1], [""], ["ok", null]]) {
      assertEquals(activeRetryRequest({
        publish_requested_at: requestedAt,
        metadata: { retry_request: { ...marker, [field]: invalid } },
      }), null);
    }
  }
});
