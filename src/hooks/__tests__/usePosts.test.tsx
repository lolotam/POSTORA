import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePosts, usePostStats } from "../usePosts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

// Mock useAuth
vi.mock("../useAuth", () => ({
    useAuth: () => ({
        user: { id: "test-user-id" },
    }),
}));

// Mock Supabase
vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    order: vi.fn(() => ({
                        limit: vi.fn(),
                    })),
                })),
                in: vi.fn(),
            })),
        })),
    },
}));

const createWrapper = () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
};

describe("usePosts Hook", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should fetch posts", async () => {
        const mockPosts = [{ id: "1", caption: "Test Post", user_id: "test-user-id" }];

        // Mock chain
        (supabase.from as Mock).mockReturnValue({
            select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: mockPosts, error: null }),
                }),
            }),
        });

        const { result } = renderHook(() => usePosts(), { wrapper: createWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual(mockPosts);
    });
});

describe("usePostStats Hook", () => {
    it("should calculate stats correctly", async () => {
        const mockPosts = [
            { id: "1", status: "completed" },
            { id: "2", status: "failed" },
            { id: "3", status: "pending", scheduled_at: new Date(Date.now() + 86400000).toISOString() }, // Future
        ];

        (supabase.from as Mock).mockReturnValue({
            select: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({ data: mockPosts, error: null }),
            }),
        });

        const { result } = renderHook(() => usePostStats(), { wrapper: createWrapper() });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));

        expect(result.current.data).toEqual({
            total: 3,
            completed: 1,
            failed: 1,
            scheduled: 1,
            successRate: 33, // 1/3 * 100 rounded
        });
    });
});
