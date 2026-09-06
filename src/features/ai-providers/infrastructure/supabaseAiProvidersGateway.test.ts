import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAiProvidersGateway } from "./supabaseAiProvidersGateway";

const { invoke, response, operations } = vi.hoisted(() => ({
  invoke: vi.fn(), response: { data: null as unknown, error: null as null | { code: string } },
  operations: [] as Array<[string, ...unknown[]]>,
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  functions: { invoke }, from: (table: string) => {
    operations.push(["from", table]);
    const query = {
      select: (...args: unknown[]) => { operations.push(["select", ...args]); return query; },
      eq: (...args: unknown[]) => { operations.push(["eq", ...args]); return query; },
      in: (...args: unknown[]) => { operations.push(["in", ...args]); return query; },
      order: () => query, maybeSingle: () => query,
      upsert: (...args: unknown[]) => { operations.push(["upsert", ...args]); return query; },
      delete: () => { operations.push(["delete"]); return query; },
      then: (resolve: (value: typeof response) => void) => Promise.resolve(response).then(resolve),
    };
    return query;
  },
} }));
const gateway = createSupabaseAiProvidersGateway("user-1");

describe("Supabase AI provider gateway", () => {
  beforeEach(() => { response.data = null; response.error = null; invoke.mockReset(); operations.length = 0; });
  it.each(["getPreferences", "isOnWaitlist", "listModels"] as const)("%s throws a coded Error on a failed read", async method => {
    response.error = { code: "42501" };
    await expect(gateway[method]()).rejects.toMatchObject({ message: "42501", code: "42501" });
  });
  it("throws on both preference write and delete errors", async () => {
    response.error = { code: "42501" };
    await expect(gateway.upsertPreference({ capability: "chat", mode: "postora_only", preferred_provider_code: null, preferred_model_id: null, allow_platform_fallback: false })).rejects.toThrow("42501");
    await expect(gateway.deletePreference("chat")).rejects.toThrow("42501");
  });
  it.each(["AI_USER_KEY_INVALID", "AI_PROVIDER_UNREACHABLE", "AI_CONNECTION_REQUIRED"])("surfaces a failed function envelope with %s", async code => {
    invoke.mockResolvedValue({ data: { ok: false, code }, error: null });
    await expect(gateway.testKey("openai")).rejects.toMatchObject({ message: code, code });
  });
  it("maps a 429 HTTP response to a rate-limit code", async () => {
    invoke.mockResolvedValue({ data: null, error: { context: new Response("", { status: 429 }) } });
    await expect(gateway.testKey("openai")).rejects.toThrow("429");
  });
  it("throws on a transport error without reflecting raw error messages", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("request with a secret") });
    await expect(gateway.listKeys()).rejects.toThrow("AI_PROVIDERS_REQUEST_FAILED");
  });
  it("scopes writes to the user and exactly one capability", async () => {
    const pref = { capability: "chat", mode: "user_only", preferred_provider_code: "openai", preferred_model_id: "gpt-test", allow_platform_fallback: false } as const;
    await gateway.upsertPreference(pref);
    expect(operations).toContainEqual(["upsert", { ...pref, user_id: "user-1" }, { onConflict: "user_id,capability" }]);
    operations.length = 0;
    await gateway.deletePreference("chat");
    expect(operations).toEqual([["from", "user_ai_routing_preferences"], ["delete"], ["eq", "user_id", "user-1"], ["eq", "capability", "chat"]]);
  });
  it("rejects a preference violating the consent constraint before writing", async () => {
    await expect(gateway.upsertPreference({ capability: "*", mode: "user_first", preferred_provider_code: "openai", preferred_model_id: "gpt-test", allow_platform_fallback: false })).rejects.toThrow("AI_ROUTING_PREFERENCE_INVALID");
    expect(operations).toEqual([]);
  });
});
