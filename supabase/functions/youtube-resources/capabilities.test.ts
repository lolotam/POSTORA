import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { deriveYouTubeCapabilities, type YouTubeCapabilityAccountInput } from "./capabilities.ts";
import { YOUTUBE_SCOPE, type YouTubeCapabilityState } from "./contracts.ts";

const ALL_SCOPES = [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl];

function account(overrides: Partial<YouTubeCapabilityAccountInput> = {}): YouTubeCapabilityAccountInput {
  return {
    id: "0ee20001-0000-4000-8000-000000000021",
    channelId: "UCfixturechannel000000001",
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    hasAccessToken: true,
    hasRefreshToken: true,
    accountMetadata: { granted_scopes: ALL_SCOPES },
    ...overrides,
  };
}

Deno.test("native row with all scopes recorded can browse, upload and comment", () => {
  const result = deriveYouTubeCapabilities(account());
  assertEquals(result.provider, "native");
  assertEquals(result.connection, "ok");
  assertEquals(result.scopes, { readonly: "granted", upload: "granted", force_ssl: "granted" });
  assertEquals(result.capabilities, {
    browse: { state: "available" },
    upload: { state: "available" },
    comments: { state: "available" },
  });
});

Deno.test("native row with no recorded scopes is unknown for browse and upload, and keeps the comment rule", () => {
  const result = deriveYouTubeCapabilities(account({ accountMetadata: {} }));
  assertEquals(result.scopes, { readonly: "unknown", upload: "unknown", force_ssl: "unknown" });
  assertEquals(result.capabilities.browse, { state: "unknown" });
  assertEquals(result.capabilities.upload, { state: "unknown" });
  assertEquals(result.capabilities.comments, { state: "unavailable", reason: "missing_scope" });
});

Deno.test("a recorded list without readonly blocks browse only", () => {
  const result = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(result.scopes.readonly, "missing");
  assertEquals(result.capabilities.browse, { state: "unavailable", reason: "missing_scope" });
  assertEquals(result.capabilities.upload, { state: "available" });
  assertEquals(result.capabilities.comments, { state: "available" });
});

Deno.test("needs_reauth makes every capability reconnect_required", () => {
  const result = deriveYouTubeCapabilities(account({ needsReauth: true }));
  assertEquals(result.connection, "reconnect_required");
  const expected: YouTubeCapabilityState = { state: "unavailable", reason: "reconnect_required" };
  assertEquals(result.capabilities, { browse: expected, upload: expected, comments: expected });
});

Deno.test("a native row with no token at all needs a reconnect", () => {
  const result = deriveYouTubeCapabilities(account({ hasAccessToken: false, hasRefreshToken: false }));
  assertEquals(result.connection, "reconnect_required");
});

Deno.test("composio row: browse unsupported, upload unknown, comments by the existing rule", () => {
  const result = deriveYouTubeCapabilities(
    account({ authProvider: "composio", hasAccessToken: false, hasRefreshToken: false, accountMetadata: {} }),
  );
  assertEquals(result.provider, "composio");
  assertEquals(result.connection, "ok");
  assertEquals(result.scopes, { readonly: "unknown", upload: "unknown", force_ssl: "unknown" });
  assertEquals(result.capabilities.browse, { state: "unavailable", reason: "provider_unsupported" });
  assertEquals(result.capabilities.upload, { state: "unknown" });
  assertEquals(result.capabilities.comments, { state: "available" });
});
