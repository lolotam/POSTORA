import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryWrapper } from "./fixtures";
import { AiProvidersPanel } from "../ui/AiProvidersPanel";

const state = vi.hoisted(() => ({ flag: false, override: null as boolean | null }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "admin-1" } }) }));
vi.mock("@/hooks/useUserRole", () => ({ useUserRole: () => ({ isAdmin: true, isLoading: false }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  from: (table: string) => {
    const data = table === "app_settings" ? [{ key: "feature_byok_providers", value: state.flag }]
      : table === "user_feature_overrides" && state.override !== null ? [{ feature_key: "feature_byok_providers", enabled: state.override, expires_at: null }] : [];
    const query = { select: () => query, eq: () => query, in: () => query, order: () => query,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (value: unknown) => void) => Promise.resolve({ data, error: null }).then(resolve),
    };
    return query;
  },
  functions: { invoke: () => Promise.resolve({ data: { ok: true, data: { keys: [] } }, error: null }) },
  channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; },
  removeChannel: vi.fn(),
} }));

describe("BYOK stored visibility for administrators (real feature flag hook)", () => {
  beforeEach(() => { state.flag = false; state.override = null; sessionStorage.clear(); vi.spyOn(console, "debug").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());
  it.each([false, true])("stored flag %s controls the admin panel", async enabled => {
    state.flag = enabled;
    const { container } = render(<AiProvidersPanel />, queryWrapper());
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading AI provider settings" })).not.toBeInTheDocument());
    if (enabled) expect(screen.getByText("Your AI keys")).toBeInTheDocument();
    else expect(container).toBeEmptyDOMElement();
  });
  it("honors a per-user beta override while the global flag is false", async () => {
    state.override = true;
    render(<AiProvidersPanel />, queryWrapper());
    expect(await screen.findByText("Your AI keys")).toBeInTheDocument();
  });
});
