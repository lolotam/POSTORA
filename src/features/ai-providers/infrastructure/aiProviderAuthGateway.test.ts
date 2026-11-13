import { describe, expect, it, vi } from "vitest";
import { aiProviderAuthGateway } from "./aiProviderAuthGateway";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));

const claude = {
  provider_code: "claude", oauth_provider: "anthropic", name: "Anthropic", active: true,
  status: "connected", account_label: null, expires_at: null, models: ["claude-sonnet-4-5"],
};

// The edge function and the frontend bundle deploy separately, in either order.
describe("aiProviderAuthGateway.capabilities across a rolling deploy", () => {
  it("reads an older edge payload without flow as the paste flow", async () => {
    invoke.mockResolvedValueOnce({ data: { enabled: true, providers: [claude] }, error: null });

    const result = await aiProviderAuthGateway.capabilities();

    expect(result.providers).toEqual([{ ...claude, flow: "pkce_paste" }]);
  });

  it("drops a provider this bundle does not know and keeps the others", async () => {
    const unknown = { ...claude, provider_code: "zai", oauth_provider: "zai", flow: "pkce_paste" };
    invoke.mockResolvedValueOnce({ data: { enabled: true, providers: [unknown, claude] }, error: null });

    const result = await aiProviderAuthGateway.capabilities();

    expect(result.providers.map((p) => p.provider_code)).toEqual(["claude"]);
  });

  it("fails the read when a provider it knows breaks the contract", async () => {
    const broken = { ...claude, models: "not a list" };
    invoke.mockResolvedValueOnce({ data: { enabled: true, providers: [broken] }, error: null });

    await expect(aiProviderAuthGateway.capabilities()).rejects.toThrow("AI_PROVIDER_AUTH_INVALID_RESPONSE");
  });
});
