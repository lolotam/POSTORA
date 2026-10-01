import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useSetupMoveCandidates } from "@/hooks/useSetupMoveCandidates";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-test-123" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function getCandidates(result: { current: any }): any[] {
  if (Array.isArray(result.current)) return result.current;
  return result.current?.data ?? [];
}

const nonZeroSummary = {
  agent_config: 1,
  connectors: 1,
  connector_links: 0,
  store_bindings: 1,
  knowledge_sources: 5,
  test_cases: 0,
  waitlist: 0,
  templates: 0,
  partner_keys_primary: 0,
  partner_key_links: 0,
  partner_webhooks: 0,
  n8n_subscriptions: 0,
  scheduled_messages: 0,
  automation_handlers: [],
};

const zeroSummary = {
  agent_config: 0,
  connectors: 0,
  connector_links: 0,
  store_bindings: 0,
  knowledge_sources: 0,
  test_cases: 0,
  waitlist: 0,
  templates: 0,
  partner_keys_primary: 0,
  partner_key_links: 0,
  partner_webhooks: 0,
  n8n_subscriptions: 0,
  scheduled_messages: 0,
  automation_handlers: [],
};

describe("useSetupMoveCandidates", () => {
  let mockAccounts: any[];
  let rpcSummaries: Record<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccounts = [];
    rpcSummaries = {};

    const builder: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockImplementation(() => Promise.resolve({ data: mockAccounts, error: null })),
      then: (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) => {
        return Promise.resolve({ data: mockAccounts, error: null }).then(resolve, reject);
      },
    };

    vi.mocked(supabase.from).mockReturnValue(builder);

    vi.mocked(supabase.rpc).mockImplementation((name: string, args: any) => {
      if (name === "get_whatsapp_account_setup_summary") {
        const summary = rpcSummaries[args?.p_account_id] ?? zeroSummary;
        return Promise.resolve({ data: summary, error: null }) as any;
      }
      return Promise.resolve({ data: null, error: null }) as any;
    });
  });

  it("returns an empty array when activeAccount is null", async () => {
    const { result } = renderHook(() => useSetupMoveCandidates(null), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(getCandidates(result)).toEqual([]);
    });
  });

  it("returns inactive candidate with same normalized number for evolution_qr connection (digits of platform_user_id)", async () => {
    const activeAccount = {
      id: "active-1",
      platform_user_id: "+965 (9795) 0350",
      connection_mode: "evolution_qr",
      account_metadata: {},
    };

    mockAccounts = [
      {
        id: "active-1",
        platform_user_id: "+965 (9795) 0350",
        platform_username: "Current WhatsApp",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "inactive-qr-1",
        platform_user_id: "96597950350",
        platform_username: "Old WhatsApp QR",
        is_active: false,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T12:00:00Z",
        account_metadata: {},
      },
    ];

    rpcSummaries["inactive-qr-1"] = nonZeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const candidates = getCandidates(result);
      expect(candidates.length).toBe(1);
      const candId = candidates[0]?.from?.id ?? candidates[0]?.id;
      expect(candId).toBe("inactive-qr-1");
    });
  });

  it("returns candidate with same normalized number for retired_ connection (digits of account_metadata.retired_number)", async () => {
    const activeAccount = {
      id: "active-1",
      platform_user_id: "96597950350",
      connection_mode: "evolution_qr",
      account_metadata: {},
    };

    mockAccounts = [
      {
        id: "active-1",
        platform_user_id: "96597950350",
        platform_username: "Current WhatsApp",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "retired-1",
        platform_user_id: "retired_20261001_oldid",
        platform_username: "Retired WhatsApp",
        is_active: false,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T10:00:00Z",
        account_metadata: { retired_number: "+965-9795-0350" },
      },
    ];

    rpcSummaries["retired-1"] = nonZeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const candidates = getCandidates(result);
      expect(candidates.length).toBe(1);
      const candId = candidates[0]?.from?.id ?? candidates[0]?.id;
      expect(candId).toBe("retired-1");
    });
  });

  it("returns candidate with same normalized number for meta connection (digits of account_metadata.display_phone_number)", async () => {
    const activeAccount = {
      id: "active-1",
      platform_user_id: "phone_number_id_123",
      connection_mode: "cloud_api",
      account_metadata: { display_phone_number: "+965 9795 0350" },
    };

    mockAccounts = [
      {
        id: "active-1",
        platform_user_id: "phone_number_id_123",
        platform_username: "Current Meta WhatsApp",
        is_active: true,
        connection_mode: "cloud_api",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: { display_phone_number: "+965 9795 0350" },
      },
      {
        id: "inactive-meta-1",
        platform_user_id: "phone_number_id_old",
        platform_username: "Old Meta WhatsApp",
        is_active: false,
        connection_mode: "cloud_api",
        updated_at: "2026-10-01T10:00:00Z",
        account_metadata: { display_phone_number: "96597950350" },
      },
    ];

    rpcSummaries["inactive-meta-1"] = nonZeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const candidates = getCandidates(result);
      expect(candidates.length).toBe(1);
      const candId = candidates[0]?.from?.id ?? candidates[0]?.id;
      expect(candId).toBe("inactive-meta-1");
    });
  });

  it("returns the most recently updated inactive row when the user has exactly one active WhatsApp account, even with a different number", async () => {
    const activeAccount = {
      id: "active-single",
      platform_user_id: "96511111111",
      connection_mode: "evolution_qr",
      account_metadata: {},
    };

    mockAccounts = [
      {
        id: "active-single",
        platform_user_id: "96511111111",
        platform_username: "Only Active Account",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "inactive-older",
        platform_user_id: "96522222222",
        platform_username: "Older Inactive",
        is_active: false,
        connection_mode: "evolution_qr",
        updated_at: "2026-09-20T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "inactive-recent",
        platform_user_id: "96533333333",
        platform_username: "Most Recent Inactive",
        is_active: false,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T15:00:00Z",
        account_metadata: {},
      },
    ];

    rpcSummaries["inactive-older"] = nonZeroSummary;
    rpcSummaries["inactive-recent"] = nonZeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const candidates = getCandidates(result);
      expect(candidates.length).toBe(1);
      const candId = candidates[0]?.from?.id ?? candidates[0]?.id;
      expect(candId).toBe("inactive-recent");
    });
  });

  it("does not return different-number inactive row when the user has multiple active WhatsApp accounts", async () => {
    const activeAccount = {
      id: "active-1",
      platform_user_id: "96511111111",
      connection_mode: "evolution_qr",
      account_metadata: {},
    };

    mockAccounts = [
      {
        id: "active-1",
        platform_user_id: "96511111111",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "active-2",
        platform_user_id: "96544444444",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "inactive-diff-num",
        platform_user_id: "96599999999",
        is_active: false,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T10:00:00Z",
        account_metadata: {},
      },
    ];

    rpcSummaries["inactive-diff-num"] = nonZeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(getCandidates(result)).toEqual([]);
    });
  });

  it("excludes candidate if its setup summary is zero (no agent, connectors, bindings, etc.)", async () => {
    const activeAccount = {
      id: "active-1",
      platform_user_id: "96597950350",
      connection_mode: "evolution_qr",
      account_metadata: {},
    };

    mockAccounts = [
      {
        id: "active-1",
        platform_user_id: "96597950350",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "inactive-zero-setup",
        platform_user_id: "96597950350",
        is_active: false,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T10:00:00Z",
        account_metadata: {},
      },
    ];

    rpcSummaries["inactive-zero-setup"] = zeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(getCandidates(result)).toEqual([]);
    });
  });

  it("excludes active non-retired WhatsApp rows from candidates", async () => {
    const activeAccount = {
      id: "active-1",
      platform_user_id: "96597950350",
      connection_mode: "evolution_qr",
      account_metadata: {},
    };

    mockAccounts = [
      {
        id: "active-1",
        platform_user_id: "96597950350",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "another-active-same-num",
        platform_user_id: "96597950350",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T10:00:00Z",
        account_metadata: {},
      },
    ];

    rpcSummaries["another-active-same-num"] = nonZeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(getCandidates(result)).toEqual([]);
    });
  });

  it("excludes candidate ids listed in activeAccount.account_metadata.setup_move_dismissed", async () => {
    const activeAccount = {
      id: "active-1",
      platform_user_id: "96597950350",
      connection_mode: "evolution_qr",
      account_metadata: {
        setup_move_dismissed: ["inactive-dismissed-1"],
      },
    };

    mockAccounts = [
      {
        id: "active-1",
        platform_user_id: "96597950350",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "inactive-dismissed-1",
        platform_user_id: "96597950350",
        is_active: false,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T10:00:00Z",
        account_metadata: {},
      },
    ];

    rpcSummaries["inactive-dismissed-1"] = nonZeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(getCandidates(result)).toEqual([]);
    });
  });

  it("always includes account_metadata.setup_move_pending.from even if dismissed", async () => {
    const activeAccount = {
      id: "active-1",
      platform_user_id: "96597950350",
      connection_mode: "evolution_qr",
      account_metadata: {
        setup_move_dismissed: ["pending-from-acc"],
        setup_move_pending: { from: "pending-from-acc", at: "2026-10-01T12:00:00Z" },
      },
    };

    mockAccounts = [
      {
        id: "active-1",
        platform_user_id: "96597950350",
        is_active: true,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-02T10:00:00Z",
        account_metadata: {},
      },
      {
        id: "pending-from-acc",
        platform_user_id: "96597950350",
        platform_username: "Pending From Account",
        is_active: false,
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T10:00:00Z",
        account_metadata: {},
      },
    ];

    rpcSummaries["pending-from-acc"] = nonZeroSummary;

    const { result } = renderHook(() => useSetupMoveCandidates(activeAccount), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      const candidates = getCandidates(result);
      expect(candidates.length).toBe(1);
      const candId = candidates[0]?.from?.id ?? candidates[0]?.id;
      expect(candId).toBe("pending-from-acc");
    });
  });
});
