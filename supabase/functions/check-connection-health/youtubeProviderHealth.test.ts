import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { checkYouTubeProviderHealth } from "./youtubeProviderHealth.ts";

Deno.test("Composio YouTube health comes from its scoped connection and never calls Google", async () => {
  let googleCalls = 0;
  let lookupCalls = 0;
  const result = await checkYouTubeProviderHealth({
    auth_provider: "composio",
    connection_id: "connection-1",
    workspace_id: "workspace-1",
  }, {
    testNative: async () => {
      googleCalls++;
      return { success: true, message: "native" };
    },
    loadConnectionStatus: async (connectionId, workspaceId) => {
      lookupCalls++;
      assertEquals([connectionId, workspaceId], [
        "connection-1",
        "workspace-1",
      ]);
      return "failed";
    },
  });
  assertEquals(result, {
    success: false,
    message: "Composio YouTube connection requires reconnection",
    tokenStatus: "expired",
  });
  assertEquals(googleCalls, 0);
  assertEquals(lookupCalls, 1);
});

Deno.test("native YouTube health still calls Google", async () => {
  let googleCalls = 0;
  const result = await checkYouTubeProviderHealth({ auth_provider: "native" }, {
    testNative: async () => {
      googleCalls++;
      return { success: true, message: "native" };
    },
    loadConnectionStatus: async () => {
      throw new Error("unused");
    },
  });
  assertEquals(result, { success: true, message: "native" });
  assertEquals(googleCalls, 1);
});
