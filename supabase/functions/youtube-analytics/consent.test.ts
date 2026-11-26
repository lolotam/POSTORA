import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { recordYouTubeAnalyticsConsent } from "./consent.ts";
import type { YouTubeAnalyticsRpcRunner } from "./decision.ts";

const OWNER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function rpcFor(data: unknown, error: unknown = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: YouTubeAnalyticsRpcRunner = (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve({ data, error });
  };
  return { rpc, calls };
}

Deno.test("stale purpose version is refused before record_consent", async () => {
  const { rpc, calls } = rpcFor(null);
  assertEquals(await recordYouTubeAnalyticsConsent(rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    event: "accepted",
    purposeVersion: 2,
    locale: "en",
    requestId: "request",
    expectedRevision: REVISION,
  }), { ok: false, code: "consent_version_stale" });
  assertEquals(calls.length, 0);
});

Deno.test("accept forwards the displayed revision and idempotent recorded flag", async () => {
  const { rpc, calls } = rpcFor({
    ok: true,
    recorded: false,
    connection_revision: REVISION,
    consent: { state: "accepted", version: 1 },
  });
  assertEquals(await recordYouTubeAnalyticsConsent(rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    event: "accepted",
    purposeVersion: 1,
    locale: "ar",
    requestId: "request",
    expectedRevision: REVISION,
  }), {
    ok: true,
    recorded: false,
    connectionRevision: REVISION,
    consent: { state: "accepted", version: 1 },
  });
  assertEquals(calls[0].args, {
    p_owner_id: OWNER_ID,
    p_account_id: ACCOUNT_ID,
    p_event: "accepted",
    p_purpose_version: 1,
    p_locale: "ar",
    p_request_id: "request",
    p_expected_revision: REVISION,
  });
});

Deno.test("withdraw defaults locale to en and never sends an expected revision", async () => {
  const { rpc, calls } = rpcFor({
    ok: true,
    recorded: true,
    connection_revision: REVISION,
    consent: { state: "withdrawn", version: 1 },
  });
  assertEquals((await recordYouTubeAnalyticsConsent(rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    event: "withdrawn",
    requestId: "request",
  })).ok, true);
  assertEquals(calls[0].args.p_locale, "en");
  assertEquals(calls[0].args.p_expected_revision, null);
});

for (const reason of ["not_found", "not_enabled", "provider_unsupported", "connection_changed", "invalid_request"] as const) {
  Deno.test(`record_consent maps ${reason} without reading credentials or Google`, async () => {
    const { rpc, calls } = rpcFor({ ok: false, reason });
    assertEquals(await recordYouTubeAnalyticsConsent(rpc, {
      ownerId: OWNER_ID,
      accountId: ACCOUNT_ID,
      event: "accepted",
      purposeVersion: 1,
      locale: "en",
      requestId: "request",
      expectedRevision: REVISION,
    }), { ok: false, code: reason });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].fn, "youtube_analytics_stage5_record_consent");
  });
}

Deno.test("record_consent RPC errors and malformed success fail closed", async () => {
  const failure = rpcFor(null, { code: "XX000" });
  assertEquals(await recordYouTubeAnalyticsConsent(failure.rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    event: "withdrawn",
    requestId: "request",
  }), { ok: false, code: "settings_unavailable" });
  const malformed = rpcFor({ ok: true, recorded: true });
  assertEquals(await recordYouTubeAnalyticsConsent(malformed.rpc, {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    event: "withdrawn",
    requestId: "request",
  }), { ok: false, code: "settings_unavailable" });
});
