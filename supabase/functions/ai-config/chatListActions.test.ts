import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { chatActionDeps, runChatListAction, type ChatActionDeps } from "./chatListActions.ts";
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

Deno.test("a rejected refusal logger preserves the original sanitized error", async () => {
  const response = await runChatListAction("chat-list-policy", {}, {
    isAdmin: async () => false,
    flags: () => { throw new Error("must not read flags"); },
    snapshot: () => { throw new Error("must not read readiness"); },
    persist: () => { throw new Error("must not write a tier"); },
    logRefusal: () => Promise.reject(new Error("private logging failure")),
  });
  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: "not_admin" });
});

// PR #419: real SDK cancellation at the HTTP boundary, with real timeout budgets.
for (const stalled of ["role", "tier", "readiness", "refusal"] as const) {
  Deno.test(`a stalled ${stalled} returns a sanitized refusal within its budget`, async () => {
    const signals: AbortSignal[] = [];
    const writes: string[] = [];
    const admin = createClient("http://127.0.0.1:54321", crypto.randomUUID(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (url, init) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === "POST") writes.push(path);
        const hangs = path.endsWith("/system_logs") ||
          (stalled === "role" && path.endsWith("/user_roles")) ||
          (stalled === "tier" && path.endsWith("/write_ai_chat_tier")) ||
          (stalled === "readiness" && path.endsWith("/ai_providers"));
        if (hangs) return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signals.push(signal);
          const abort = () => reject(new DOMException("private storage detail", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        return Promise.resolve(Response.json(path.endsWith("/user_roles") ?
          (stalled === "refusal" ? [] : [{ role: "admin" }]) : []));
      } },
    });
    const deps = chatActionDeps(admin, crypto.randomUUID(), AbortSignal.timeout(10_000));
    deps.flags = async () => flags;
    if (stalled !== "readiness") deps.snapshot = async () => ({ flags,
      providers: [{ id: "p", provider_code: "claude", name: "Claude", is_active: true }], models: [], settings: [],
      statuses: [{ provider_code: "claude", status: "connected" }], apiKeys: {}, registry: { claude: ["same"] },
    });
    const started = performance.now();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        runChatListAction("set-chat-tier", input, deps),
        new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), stalled === "refusal" ? 1_000 : 11_500); }),
      ]);
      assert(response, "Chat action exceeded its deadline");
      assertEquals(response.status, stalled === "refusal" ? 403 : 503);
      assertEquals(await response.json(), { error: stalled === "refusal" ? "not_admin" : "configuration_read_or_write_failed" });
      assert(performance.now() - started < (stalled === "refusal" ? 1_000 : 11_500));
      assertEquals(signals.length, stalled === "refusal" ? 1 : 2);
      assert(signals.every(signal => signal.aborted), "Every stalled HTTP request must be cancelled");
      assertEquals(writes.filter(path => path.endsWith("/write_ai_chat_tier")).length, stalled === "tier" ? 1 : 0);
    } finally {
      clearTimeout(deadline);
    }
  });
}
