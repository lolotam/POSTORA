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

Deno.test("native row with all scopes recorded can browse, upload, edit metadata and comment", () => {
  const result = deriveYouTubeCapabilities(account());
  assertEquals(result.provider, "native");
  assertEquals(result.connection, "ok");
  assertEquals(result.scopes, { readonly: "granted", upload: "granted", force_ssl: "granted" });
  assertEquals(result.capabilities, {
    browse: { state: "available" },
    upload: { state: "available" },
    edit_metadata: { state: "available" },
    manage_thumbnail: { state: "available" },
    manage_captions: { state: "available" },
    manage_playlists: { state: "available" },
    comments: { state: "available" },
  });
});

Deno.test("native row with no recorded scopes is unknown for browse, upload and edit_metadata, and keeps the comment rule", () => {
  const result = deriveYouTubeCapabilities(account({ accountMetadata: {} }));
  assertEquals(result.scopes, { readonly: "unknown", upload: "unknown", force_ssl: "unknown" });
  assertEquals(result.capabilities.browse, { state: "unknown" });
  assertEquals(result.capabilities.upload, { state: "unknown" });
  assertEquals(result.capabilities.edit_metadata, { state: "unknown" });
  assertEquals(result.capabilities.manage_thumbnail, { state: "unknown" });
  assertEquals(result.capabilities.manage_captions, { state: "unknown" });
  assertEquals(result.capabilities.manage_playlists, { state: "unknown" });
  assertEquals(result.capabilities.comments, { state: "unavailable", reason: "missing_scope" });
});

Deno.test("a recorded list without readonly blocks browse, edit_metadata, thumbnail replacement, and captions", () => {
  const result = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(result.scopes.readonly, "missing");
  assertEquals(result.capabilities.browse, { state: "unavailable", reason: "missing_scope" });
  assertEquals(result.capabilities.upload, { state: "available" });
  assertEquals(result.capabilities.edit_metadata, { state: "unavailable", reason: "missing_scope" });
  assertEquals(result.capabilities.manage_thumbnail, { state: "unavailable", reason: "missing_scope" });
  assertEquals(result.capabilities.manage_captions, { state: "unavailable", reason: "missing_scope" });
  assertEquals(result.capabilities.manage_playlists, { state: "unavailable", reason: "missing_scope" });
  assertEquals(result.capabilities.comments, { state: "available" });
});

Deno.test("needs_reauth makes every capability reconnect_required", () => {
  const result = deriveYouTubeCapabilities(account({ needsReauth: true }));
  assertEquals(result.connection, "reconnect_required");
  const expected: YouTubeCapabilityState = { state: "unavailable", reason: "reconnect_required" };
  assertEquals(result.capabilities, {
    browse: expected,
    upload: expected,
    edit_metadata: expected,
    manage_thumbnail: expected,
    manage_captions: expected,
    manage_playlists: expected,
    comments: expected,
  });
});

Deno.test("a native row with no token at all needs a reconnect", () => {
  const result = deriveYouTubeCapabilities(account({ hasAccessToken: false, hasRefreshToken: false }));
  assertEquals(result.connection, "reconnect_required");
  assertEquals(result.capabilities.manage_thumbnail, { state: "unavailable", reason: "reconnect_required" });
  assertEquals(result.capabilities.manage_captions, { state: "unavailable", reason: "reconnect_required" });
  assertEquals(result.capabilities.manage_playlists, { state: "unavailable", reason: "reconnect_required" });
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
  assertEquals(result.capabilities.manage_thumbnail, { state: "unavailable", reason: "provider_unsupported" });
  assertEquals(result.capabilities.manage_captions, { state: "unavailable", reason: "provider_unsupported" });
  assertEquals(result.capabilities.manage_playlists, { state: "unavailable", reason: "provider_unsupported" });
  assertEquals(result.capabilities.comments, { state: "available" });
});

Deno.test("manage_thumbnail derivation across readonly-only, upload-only, force_ssl-only, and readonly+upload/force_ssl scopes", () => {
  const readonlyOnly = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly] } }),
  );
  assertEquals(readonlyOnly.capabilities.manage_thumbnail, { state: "unavailable", reason: "missing_scope" });

  const uploadOnly = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload] } }),
  );
  assertEquals(uploadOnly.capabilities.manage_thumbnail, { state: "unavailable", reason: "missing_scope" });

  const forceSslOnly = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(forceSslOnly.capabilities.manage_thumbnail, { state: "unavailable", reason: "missing_scope" });

  const readonlyAndUpload = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload] } }),
  );
  assertEquals(readonlyAndUpload.capabilities.manage_thumbnail, { state: "available" });

  const readonlyAndForceSsl = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(readonlyAndForceSsl.capabilities.manage_thumbnail, { state: "available" });
});

Deno.test("manage_captions derivation requires readonly and force_ssl", () => {
  const readonlyOnly = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly] } }),
  );
  assertEquals(readonlyOnly.capabilities.manage_captions, { state: "unavailable", reason: "missing_scope" });

  const readonlyAndUpload = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload] } }),
  );
  assertEquals(readonlyAndUpload.capabilities.manage_captions, { state: "unavailable", reason: "missing_scope" });

  const forceSslOnly = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(forceSslOnly.capabilities.manage_captions, { state: "unavailable", reason: "missing_scope" });

  const readonlyAndForceSsl = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(readonlyAndForceSsl.capabilities.manage_captions, { state: "available" });
});

Deno.test("manage_playlists derivation table: requires readonly and force_ssl; readonly + upload alone is missing_scope", () => {
  const rows: Array<{
    name: string;
    input: Partial<YouTubeCapabilityAccountInput>;
    expected: YouTubeCapabilityState;
  }> = [
    {
      name: "composio provider",
      input: { authProvider: "composio", hasAccessToken: false, hasRefreshToken: false, accountMetadata: {} },
      expected: { state: "unavailable", reason: "provider_unsupported" },
    },
    {
      name: "composio provider even when needsReauth is true",
      input: { authProvider: "composio", needsReauth: true, accountMetadata: { granted_scopes: ALL_SCOPES } },
      expected: { state: "unavailable", reason: "provider_unsupported" },
    },
    {
      name: "native needsReauth",
      input: { needsReauth: true, accountMetadata: { granted_scopes: ALL_SCOPES } },
      expected: { state: "unavailable", reason: "reconnect_required" },
    },
    {
      name: "native without access or refresh token",
      input: { hasAccessToken: false, hasRefreshToken: false, accountMetadata: { granted_scopes: ALL_SCOPES } },
      expected: { state: "unavailable", reason: "reconnect_required" },
    },
    {
      name: "readonly only",
      input: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly] } },
      expected: { state: "unavailable", reason: "missing_scope" },
    },
    {
      name: "upload only (missing readonly)",
      input: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload] } },
      expected: { state: "unavailable", reason: "missing_scope" },
    },
    {
      name: "force_ssl only (missing readonly)",
      input: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.force_ssl] } },
      expected: { state: "unavailable", reason: "missing_scope" },
    },
    {
      name: "upload + force_ssl without readonly",
      input: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.upload, YOUTUBE_SCOPE.force_ssl] } },
      expected: { state: "unavailable", reason: "missing_scope" },
    },
    {
      name: "readonly + upload without force_ssl (OD-10: upload does not authorize playlists.insert)",
      input: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload] } },
      expected: { state: "unavailable", reason: "missing_scope" },
    },
    {
      name: "readonly + force_ssl",
      input: { accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.force_ssl] } },
      expected: { state: "available" },
    },
    {
      name: "all three scopes granted",
      input: { accountMetadata: { granted_scopes: ALL_SCOPES } },
      expected: { state: "available" },
    },
    {
      name: "unrecorded scope list (empty metadata)",
      input: { accountMetadata: {} },
      expected: { state: "unknown" },
    },
  ];

  for (const row of rows) {
    const derived = deriveYouTubeCapabilities(account(row.input));
    assertEquals(derived.capabilities.manage_playlists, row.expected, row.name);
  }
});


Deno.test("edit_metadata derivation across scopes, reconnect, composio, and editWriteEnabled=false", () => {
  const readonlyAndUpload = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload] } }),
  );
  assertEquals(readonlyAndUpload.capabilities.edit_metadata, { state: "unavailable", reason: "missing_scope" });

  const forceSslOnly = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(forceSslOnly.capabilities.edit_metadata, { state: "unavailable", reason: "missing_scope" });

  const readonlyAndForceSsl = deriveYouTubeCapabilities(
    account({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.force_ssl] } }),
  );
  assertEquals(readonlyAndForceSsl.capabilities.edit_metadata, { state: "available" });

  const noToken = deriveYouTubeCapabilities(account({ hasAccessToken: false, hasRefreshToken: false }));
  assertEquals(noToken.capabilities.edit_metadata, { state: "unavailable", reason: "reconnect_required" });

  const composio = deriveYouTubeCapabilities(
    account({ authProvider: "composio", hasAccessToken: false, hasRefreshToken: false, accountMetadata: {} }),
  );
  assertEquals(composio.capabilities.edit_metadata, { state: "unavailable", reason: "provider_unsupported" });

  const disabled = deriveYouTubeCapabilities(account(), { editWriteEnabled: false });
  assertEquals(disabled.capabilities.edit_metadata, { state: "unavailable", reason: "provider_unsupported" });
});

Deno.test("capabilities publish the two-unit enriched videos page cost", () => {
  const result = deriveYouTubeCapabilities(account());
  assertEquals(result.quota.unit_costs.videos_page, 2);
});
