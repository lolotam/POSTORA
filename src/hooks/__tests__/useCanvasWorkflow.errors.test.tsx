import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useCanvasWorkflow } from "../useCanvasWorkflow";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
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
    vi.mocked(supabase.from).mockReturnValue(query as ReturnType<typeof supabase.from>);
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
          expect(outcome).toEqual({ success: false, errors: [message] });
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
