import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSocialProfiles, useCreateProfile } from "../useSocialProfiles";
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
                    order: vi.fn(),
                })),
            })),
            insert: vi.fn(() => ({
                select: vi.fn(() => ({
                    single: vi.fn(),
                })),
            })),
        })),
    },
}));

// Wrapper for React Query
const createWrapper = () => {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                retry: false,
            },
        },
    });
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
};

describe("useSocialProfiles Hook", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should fetch social profiles", async () => {
        const mockProfiles = [
            { id: "1", name: "Profile 1", user_id: "test-user-id", created_at: "2023-01-01" },
        ];

        // Mock query chain
        (supabase.from as Mock).mockReturnValue({
            select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    order: vi.fn().mockResolvedValue({ data: mockProfiles, error: null }),
                }),
            }),
        });

        const { result } = renderHook(() => useSocialProfiles(), {
            wrapper: createWrapper(),
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual(mockProfiles);
    });

    it("should create a new profile", async () => {
        const newProfile = { id: "2", name: "New Profile", user_id: "test-user-id" };

        // Mock insert chain
        (supabase.from as Mock).mockReturnValue({
            insert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: newProfile, error: null }),
                }),
            }),
        });

        const { result } = renderHook(() => useCreateProfile(), {
            wrapper: createWrapper(),
        });

        await result.current.mutateAsync("New Profile");

        await waitFor(() => {
            if (!result.current.isSuccess) {
                console.log("Creation failed. Status:", result.current.status);
                console.log("Error:", result.current.error);
            }
            expect(result.current.isSuccess).toBe(true);
        });
        expect(result.current.data).toEqual(newProfile);
    });
});
