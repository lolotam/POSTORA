import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useCanvasWorkflow } from "../useCanvasWorkflow";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));

// Supply the authenticated user, quota response and notification sink without
// mounting the application providers or contacting their backing services.
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/hooks/useQuotas", () => ({
  useQuotas: () => ({ canCreatePost: async () => ({ allowed: true }) }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

describe("Canvas workflow database errors", () => {
  const message = "permission denied for table workflows";

  beforeEach(() => {
    vi.clearAllMocks();
    const query = {
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      // PostgREST returns a plain JSON error unless throwOnError is enabled.
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { message, code: "42501", details: "", hint: "" },
      }),
    };
    (supabase.from as Mock).mockReturnValue(query);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["insert", "update", "load", "publish"] as const)(
    "preserves the database message when %s fails",
    async (operation) => {
      const queryClient = new QueryClient();
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);
      const { result } = renderHook(() => useCanvasWorkflow(), { wrapper });

      await act(async () => {
        if (operation === "load") {
          expect(await result.current.loadWorkflow("workflow-1")).toBeNull();
        } else if (operation === "publish") {
          const outcome = await result.current.executeWorkflow([
            { id: "platform-1", type: "platform", position: { x: 0, y: 0 }, data: { enabledPlatforms: ["facebook"] } },
          ], []);
          expect(outcome).toEqual({ status: "failed", errors: [message] });
        } else {
          expect(await result.current.saveWorkflow({
            id: operation === "update" ? "workflow-1" : undefined,
            name: "Workflow", nodes: [], edges: [],
          })).toBeNull();
        }
      });

      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        description: message, variant: "destructive",
      }));
    },
  );
});


describe("Canvas publish submission", () => {
  const nodes = [{ id: "platform-1", type: "platform", position: { x: 0, y: 0 }, data: { enabledPlatforms: ["facebook"], selectedAccountIds: ["account-1"] } }];
  const insert = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { id: "post-1" }, error: null }) }) });
    (supabase.from as Mock).mockReturnValue({ insert });
  });

  function renderWorkflow() {
    const client = new QueryClient();
    return renderHook(() => useCanvasWorkflow(), { wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) });
  }

  it("inserts a durable pending request, submits it, and never claims publication", async () => {
    (supabase.functions.invoke as Mock).mockResolvedValue({ data: { accepted: true, post_id: "post-1", status: "processing" }, error: null });
    const { result } = renderWorkflow();
    await act(async () => {
      expect(await result.current.executeWorkflow(nodes, [])).toEqual({ status: "submitted", postId: "post-1" });
    });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: "pending", scheduled_at: null, publish_requested_at: expect.any(String) }));
    expect(supabase.from).not.toHaveBeenCalledWith("platform_posts");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Submitted, publishing" }));
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Published!" }));
  });

  it("reports enqueue refusal as an error without a submitted toast", async () => {
    (supabase.functions.invoke as Mock).mockResolvedValue({ data: null, error: new Error("offline") });
    const { result } = renderWorkflow();
    await act(async () => {
      expect(await result.current.executeWorkflow(nodes, [])).toEqual({ status: "failed", errors: ["Could not confirm the publish request. Check History for its status."] });
    });
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Submitted, publishing" }));
  });

  it("keeps scheduled posts free of immediate requests and platform placeholder rows", async () => {
    const { result } = renderWorkflow();
    const scheduledAt = new Date("2026-12-01T10:00:00Z");
    await act(async () => {
      expect(await result.current.executeWorkflow(nodes, [], scheduledAt)).toEqual({ status: "scheduled", postId: "post-1" });
    });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: "pending", scheduled_at: scheduledAt.toISOString(), publish_requested_at: null }));
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalledWith("platform_posts");
  });
});
