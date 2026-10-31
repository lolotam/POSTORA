import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAdminNotifications, useMarkNotificationRead } from "../useNotifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

vi.mock("../useAuth", () => ({
    useAuth: () => ({ user: { id: "test-user-id" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        from: vi.fn(),
    },
}));

const createWrapper = () => {
    const queryClient = new QueryClient();
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
};

describe("useNotifications Hook", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should fetch admin notifications and merge read status", async () => {
        const mockNotifs = [{ id: "n1", title: "Update" }];
        const mockReads = [{ notification_id: "n1" }];

        // Mock separate calls for notifications and reads
        (supabase.from as Mock).mockImplementation((table: string) => {
            if (table === "admin_notifications") {
                return {
                    select: vi.fn().mockReturnValue({
                        order: vi.fn().mockResolvedValue({ data: mockNotifs, error: null }),
                    }),
                };
            }
            if (table === "user_notification_reads") {
                return {
                    select: vi.fn().mockReturnValue({
                        eq: vi.fn().mockResolvedValue({ data: mockReads, error: null }),
                    }),
                };
            }
            return { select: vi.fn() };
        });

        const { result } = renderHook(() => useAdminNotifications(), { wrapper: createWrapper() });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual([{ ...mockNotifs[0], is_read: true }]);
    });

    it("should mark notification as read", async () => {
        (supabase.from as Mock).mockImplementation((table: string) => {
            if (table === "user_notification_reads") {
                return {
                    insert: vi.fn().mockResolvedValue({ error: null }),
                };
            }
            return {};
        });

        const { result } = renderHook(() => useMarkNotificationRead(), { wrapper: createWrapper() });
        await result.current.mutateAsync("n1");
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
});
