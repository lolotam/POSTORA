import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryWrapper } from "../tests/fixtures";
import { AiProvidersPanel } from "./AiProvidersPanel";

const state = vi.hoisted(() => ({ enabled: false, flagsLoading: false, roleLoading: false }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useFeatureFlags", () => ({ useFeatureFlags: () => ({ flags: { byokProviders: state.enabled }, isLoading: state.flagsLoading }) }));
vi.mock("@/hooks/useUserRole", () => ({ useUserRole: () => ({ isAdmin: true, isLoading: state.roleLoading }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke }, from: () => {
  const query = { select: () => query, eq: () => query, in: () => query, order: () => Promise.resolve({ data: [], error: null }), maybeSingle: () => Promise.resolve({ data: null, error: null }), then: (resolve: (value: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve) };
  return query;
} } }));

describe("AI providers panel gate", () => {
  beforeEach(() => { Object.assign(state, { enabled: false, flagsLoading: false, roleLoading: false }); invoke.mockReset().mockResolvedValue({ data: { ok: true, data: { keys: [] } }, error: null }); });
  it("renders nothing and performs no feature queries with the flag off", () => {
    const { container } = render(<AiProvidersPanel />, queryWrapper());
    expect(container).toBeEmptyDOMElement();
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(["flagsLoading", "roleLoading"] as const)("shows a skeleton while %s even if enabled", field => {
    state.enabled = true;
    state[field] = true;
    render(<AiProvidersPanel />, queryWrapper());
    expect(screen.getByRole("status", { name: "Loading AI provider settings" })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("mounts all three cards with the flag on", async () => {
    state.enabled = true;
    render(<AiProvidersPanel />, queryWrapper());
    expect(screen.getByText("Your AI keys")).toBeInTheDocument();
    expect(screen.getByText("Routing")).toBeInTheDocument();
    expect(screen.getByText("Connect ChatGPT / Codex subscription (beta waitlist)")).toBeInTheDocument();
    await screen.findByRole("region", { name: "OpenAI" });
  });
});
