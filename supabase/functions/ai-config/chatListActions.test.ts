import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runChatListAction, type ChatActionDeps } from "./chatListActions.ts";
import type { ChatPolicySnapshot } from "./chatListPolicy.ts";

const flags = { feature_ai_provider_oauth: true, feature_ai_text_auth_lists: true, feature_ai_category_text_ladders: false, feature_ai_oauth_tools_claude: false, feature_ai_oauth_tools_codex: false };
const input = { category: "chat", slot: "primary", provider_code: "claude", model_id: "same", auth_method: "oauth" };

for (const scenario of ["success", "not_admin", "flag_read_failed", "catalogue_read_failed", "status_read_failed", "save_failed", "unknown_auth", "draft", "flag_off"] as const) {
  Deno.test(`Chat boundary: ${scenario}, no unsafe overwrite or credential disclosure`, async () => {
    const persisted: unknown[] = [];
    const refusals: string[] = [];
    let snapshotReads = 0;
    let flagReads = 0;
    const deps: ChatActionDeps = {
      isAdmin: async () => scenario !== "not_admin",
      flags: async () => {
        flagReads++;
        if (scenario === "flag_read_failed") throw new Error("secret SQL failure");
        return { ...flags, feature_ai_text_auth_lists: scenario !== "flag_off" };
      },
      snapshot: async effectiveFlags => {
        snapshotReads++;
        if (scenario === "catalogue_read_failed" || scenario === "status_read_failed") throw new Error("secret provider failure");
        return { flags: effectiveFlags, providers: [{ id: "p", provider_code: "claude", name: "Claude", is_active: true }], models: [], settings: [],
          statuses: [{ provider_code: "claude", status: "connected" }], apiKeys: { claude: false }, registry: { claude: ["same"] } } satisfies ChatPolicySnapshot;
      },
      persist: async tier => {
        if (scenario === "save_failed") throw new Error("secret storage failure");
        persisted.push(tier.value);
      },
      logRefusal: async reason => { refusals.push(reason); },
    };
    const request = scenario === "unknown_auth" ? { ...input, auth_method: "bad" } : scenario === "draft" ? { ...input, model_id: "" } : input;
    const response = await runChatListAction("set-chat-tier", request, deps);
    const envelope = await response.json();
    assertEquals(persisted.length, scenario === "success" ? 1 : 0);
    assertEquals(JSON.stringify(envelope).includes("secret"), false);
    if (scenario === "success") {
      assertEquals(persisted[0], { provider_code: "claude", model_id: "same", auth_method: "oauth" });
      assertEquals(envelope, { success: true });
      assertEquals(response.status, 200);
    }
    else assertEquals(refusals.length, 1);
    if (scenario === "not_admin" || scenario === "flag_read_failed" || scenario === "flag_off") assertEquals(snapshotReads, 0);
    if (scenario === "not_admin") { assertEquals(response.status, 403); assertEquals(flagReads, 0); }
  });
}

Deno.test("disabled list policy skips server-only readiness reads", async () => {
  const response = await runChatListAction("chat-list-policy", {}, {
    isAdmin: async () => true,
    flags: async () => ({ ...flags, feature_ai_text_auth_lists: false }),
    snapshot: () => { throw new Error("must not read statuses"); },
    persist: () => { throw new Error("must not persist"); },
    logRefusal: async () => {},
  });
  assertEquals(await response.json(), { enabled: false });
});
