import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCreateDeal,
  useMoveDeal,
  usePipelines,
  useUpdateDeal,
  useWhatsAppPipelineRealtime,
} from "../useWhatsAppPipelines";
import { groupDealsByStage } from "@/lib/whatsappPipeline";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    channel: mocks.channel,
    removeChannel: mocks.removeChannel,
  },
}));

vi.mock("../useAuth", () => ({
  useAuth: () => ({ user: { id: "test-user-id" } }),
}));

vi.mock("@/hooks/use-toast", () => ({ toast: mocks.toast }));

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function pipeline(id: string, workspaceId: string) {
  return {
    id,
    workspace_id: workspaceId,
    name: "Sales Pipeline",
    is_default: true,
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
  };
}

function cachedDeal(id: string, stageId: string, position: number, status = "open") {
  return {
    id,
    workspace_id: "workspace-move",
    pipeline_id: "pipeline-move",
    stage_id: stageId,
    contact_id: `contact-${id}`,
    conversation_cache_id: null,
    title: id,
    amount: 100,
    currency: "USD",
    status,
    position,
    assigned_to: null,
    created_by: "test-user-id",
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
    contact: {
      id: `contact-${id}`,
      display_name: id,
      phone_number: "+96500000000",
    },
    conversation: null,
  };
}

function mockPipelineList(rows: ReturnType<typeof pipeline>[]) {
  const order = vi.fn().mockResolvedValue({ data: rows, error: null });
  const eq = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eq });
  mocks.from.mockReturnValue({ select });
}

describe("useWhatsAppPipelines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads workspace pipelines in display order", async () => {
    const rows = [pipeline("pipeline-1", "workspace-load")];
    mockPipelineList(rows);
    const { wrapper } = createHarness();

    const { result } = renderHook(() => usePipelines("workspace-load"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mocks.from).toHaveBeenCalledWith("whatsapp_pipelines");
  });

  it("coalesces concurrent default-pipeline creation into exactly one RPC", async () => {
    let pipelineCreated = false;
    let finishCreation: (() => void) | undefined;
    const creation = new Promise<{ data: string; error: null }>((resolve) => {
      finishCreation = () => {
        pipelineCreated = true;
        resolve({ data: "pipeline-default", error: null });
      };
    });
    const createdPipeline = pipeline("pipeline-default", "workspace-empty");
    const order = vi.fn().mockImplementation(() => Promise.resolve({
      data: pipelineCreated ? [createdPipeline] : [],
      error: null,
    }));
    mocks.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ order }),
      }),
    });
    mocks.rpc.mockReturnValue(creation);
    const firstHarness = createHarness();
    const secondHarness = createHarness();

    const first = renderHook(() => usePipelines("workspace-empty"), {
      wrapper: firstHarness.wrapper,
    });
    const second = renderHook(() => usePipelines("workspace-empty"), {
      wrapper: secondHarness.wrapper,
    });

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    finishCreation?.();
    await waitFor(() => expect(first.result.current.data).toEqual([createdPipeline]));
    await waitFor(() => expect(second.result.current.data).toEqual([createdPipeline]));
    expect(mocks.rpc).toHaveBeenCalledWith("create_default_whatsapp_pipeline", {
      p_workspace_id: "workspace-empty",
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects deal creation with a missing contact before touching Supabase", async () => {
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useCreateDeal(), { wrapper });

    await expect(result.current.mutateAsync({
      workspaceId: "workspace-1",
      pipelineId: "pipeline-1",
      stage: { id: "stage-open", stage_type: "open" },
      contactId: "",
      title: "Renewal",
      amount: 50,
      currency: "USD",
    })).rejects.toMatchObject({
      name: "WhatsAppDealValidationError",
      issues: [{ field: "contactId", code: "required" }],
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("moves a deal through move_whatsapp_deal and never updates stage_id directly", async () => {
    mocks.rpc.mockResolvedValue({ data: undefined, error: null });
    const { queryClient, wrapper } = createHarness();
    queryClient.setQueryData(
      ["whatsapp_deals", "test-user-id", "pipeline-move"],
      [cachedDeal("deal-a", "stage-open", 0)],
    );
    const { result } = renderHook(() => useMoveDeal(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        pipelineId: "pipeline-move",
        dealId: "deal-a",
        sourceStageId: "stage-open",
        destinationStage: { id: "stage-won", stage_type: "won" },
        destinationIndex: 0,
      });
    });

    expect(mocks.rpc).toHaveBeenCalledWith("move_whatsapp_deal", {
      p_deal_id: "deal-a",
      p_stage_id: "stage-won",
      p_position: 0,
    });
    expect(mocks.from).not.toHaveBeenCalledWith("whatsapp_deals");
  });

  it("rolls an optimistic move back to the exact prior ordering when the RPC fails", async () => {
    const rpcError = new Error("Deal changed during move; retry the operation");
    let rejectMove: ((error: Error) => void) | undefined;
    mocks.rpc.mockReturnValue(new Promise((_, reject) => {
      rejectMove = reject;
    }));
    const initialDeals = [
      cachedDeal("open-a", "stage-open", 0),
      cachedDeal("open-b", "stage-open", 1),
      cachedDeal("won-a", "stage-won", 0, "won"),
    ];
    const queryKey = ["whatsapp_deals", "test-user-id", "pipeline-move"] as const;
    const { queryClient, wrapper } = createHarness();
    queryClient.setQueryData(queryKey, initialDeals);
    const { result } = renderHook(() => useMoveDeal(), { wrapper });

    let mutation: Promise<unknown> | undefined;
    act(() => {
      mutation = result.current.mutateAsync({
        pipelineId: "pipeline-move",
        dealId: "open-b",
        sourceStageId: "stage-open",
        destinationStage: { id: "stage-won", stage_type: "won" },
        destinationIndex: 0,
      });
    });

    await waitFor(() => {
      const optimisticDeals = queryClient.getQueryData<typeof initialDeals>(queryKey) ?? [];
      expect(groupDealsByStage(optimisticDeals)["stage-won"].map(({ id }) => id)).toEqual([
        "open-b",
        "won-a",
      ]);
    });
    rejectMove?.(rpcError);
    await expect(mutation).rejects.toBe(rpcError);
    await waitFor(() => expect(queryClient.getQueryData(queryKey)).toEqual(initialDeals));
  });

  it("surfaces a Supabase conflict to the mutation caller", async () => {
    const conflict = new Error("Deal was updated by another agent");
    const single = vi.fn().mockResolvedValue({ data: null, error: conflict });
    const secondEq = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) });
    const firstEq = vi.fn().mockReturnValue({ eq: secondEq });
    mocks.from.mockReturnValue({
      update: vi.fn().mockReturnValue({ eq: firstEq }),
    });
    const { wrapper } = createHarness();
    const { result } = renderHook(() => useUpdateDeal(), { wrapper });

    await expect(result.current.mutateAsync({
      dealId: "deal-a",
      pipelineId: "pipeline-1",
      changes: { title: "Updated renewal" },
    })).rejects.toBe(conflict);
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Failed to update deal",
      variant: "destructive",
    }));
  });

  it("subscribes to workspace CRM changes and removes the channel on unmount", () => {
    const callbacks: Array<() => void> = [];
    const channel = {
      on: vi.fn((_event, _config, callback: () => void) => {
        callbacks.push(callback);
        return channel;
      }),
      subscribe: vi.fn(() => channel),
    };
    mocks.channel.mockReturnValue(channel);
    const { queryClient, wrapper } = createHarness();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { unmount } = renderHook(
      () => useWhatsAppPipelineRealtime("workspace-realtime"),
      { wrapper },
    );

    expect(channel.on).toHaveBeenNthCalledWith(
      1,
      "postgres_changes",
      expect.objectContaining({
        table: "whatsapp_deals",
        filter: "workspace_id=eq.workspace-realtime",
      }),
      expect.any(Function),
    );
    expect(channel.on).toHaveBeenNthCalledWith(
      2,
      "postgres_changes",
      expect.objectContaining({
        table: "whatsapp_pipeline_stages",
        filter: "workspace_id=eq.workspace-realtime",
      }),
      expect.any(Function),
    );

    act(() => callbacks.forEach((callback) => callback()));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["whatsapp_deals", "test-user-id"],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["whatsapp_pipeline_stages", "test-user-id"],
    });

    unmount();
    expect(mocks.removeChannel).toHaveBeenCalledWith(channel);
  });
});


