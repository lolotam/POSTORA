import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSocialProfiles, useCreateProfile, useDisconnectAccountFromProfile } from "../useSocialProfiles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";

const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({
    toast: mockToast,
    useToast: () => ({ toast: mockToast }),
}));

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
        functions: {
            invoke: vi.fn(),
        },
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

describe("useDisconnectAccountFromProfile", () => {
    const invoke = supabase.functions.invoke as unknown as Mock;
    const from = supabase.from as unknown as Mock;
    const deleteEq = vi.fn(async () => ({ error: null }));

    beforeEach(() => {
        vi.clearAllMocks();
        from.mockImplementation(() => ({
            select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { platform: "instagram" }, error: null })) })) })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));
    });

    it.each(["facebook", "instagram"])("withdraws the Meta grant before removing a %s account", async (platform) => {
        from.mockImplementation(() => ({
            select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { platform }, error: null })) })) })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));
        invoke.mockResolvedValue({ data: { success: true, revoked: true, reason: null }, error: null });
        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper: createWrapper() });
        await result.current.mutateAsync("acc-1");
        expect(invoke).toHaveBeenCalledWith("facebook-oauth", { body: { action: "disconnect", social_account_id: "acc-1" } });
        expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(deleteEq.mock.invocationCallOrder[0]);
    });

    it("still removes the account when the grant withdrawal fails", async () => {
        invoke.mockResolvedValue({ data: null, error: new Error("offline") });
        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper: createWrapper() });
        await result.current.mutateAsync("acc-1");
        expect(deleteEq).toHaveBeenCalledWith("id", "acc-1");
    });

    it("does not call Meta for a Threads account", async () => {
        from.mockImplementation(() => ({
            select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { platform: "threads" }, error: null })) })) })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));
        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper: createWrapper() });
        await result.current.mutateAsync("acc-1");
        expect(invoke).not.toHaveBeenCalled();
        expect(deleteEq).toHaveBeenCalledWith("id", "acc-1");
    });

    it("calls youtube-oauth disconnect before removing a native YouTube account", async () => {
        from.mockImplementation(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                        data: { platform: "youtube", auth_provider: "native" },
                        error: null,
                    })),
                })),
            })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));
        invoke.mockResolvedValue({ data: { success: true, revoked: true, reason: null }, error: null });

        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper: createWrapper() });
        await result.current.mutateAsync("acc-yt");

        expect(invoke).toHaveBeenCalledWith("youtube-oauth", {
            body: { action: "disconnect", account_id: "acc-yt" },
        });
        expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(deleteEq.mock.invocationCallOrder[0]);
        expect(deleteEq).toHaveBeenCalledWith("id", "acc-yt");
        expect(mockToast).not.toHaveBeenCalled();
    });

    it("rejects with the upstream message and keeps the YouTube account in UI state when revoke fails", async () => {
        const ytAccount = {
            id: "acc-yt",
            user_id: "test-user-id",
            platform: "youtube",
            platform_user_id: "UC-test",
            platform_username: "Test Channel",
            avatar_url: null,
            is_active: true,
            connected_at: "2026-11-19T00:00:00Z",
            updated_at: "2026-11-19T00:00:00Z",
            social_profile_id: "prof-1",
            token_expires_at: null,
            account_metadata: null,
            ig_auth_type: null,
        };
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        queryClient.setQueryData(["all_social_accounts", "test-user-id"], [ytAccount]);
        queryClient.setQueryData(["social_accounts", "prof-1"], [ytAccount]);
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );

        from.mockImplementation(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                        data: { platform: "youtube", auth_provider: "native" },
                        error: null,
                    })),
                })),
            })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));
        invoke.mockResolvedValue({
            data: null,
            error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
                context: new Response(
                    JSON.stringify({ error: "Failed to disconnect YouTube account. Please try again." }),
                    { status: 502, headers: { "content-type": "application/json" } },
                ),
            }),
        });

        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper });
        await expect(result.current.mutateAsync("acc-yt")).rejects.toThrow(
            "Failed to disconnect YouTube account. Please try again.",
        );

        expect(invoke).toHaveBeenCalledWith("youtube-oauth", {
            body: { action: "disconnect", account_id: "acc-yt" },
        });
        expect(deleteEq).not.toHaveBeenCalled();
        expect(queryClient.getQueryData(["all_social_accounts", "test-user-id"])).toEqual([ytAccount]);
        expect(queryClient.getQueryData(["social_accounts", "prof-1"])).toEqual([ytAccount]);
        // The page shows the localized error toast from its own catch; the hook stays silent.
        expect(mockToast).not.toHaveBeenCalled();
    });

    it("does not invoke youtube-oauth when disconnecting a Composio-managed YouTube account", async () => {
        from.mockImplementation(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                        data: { platform: "youtube", auth_provider: "composio" },
                        error: null,
                    })),
                })),
            })),
            delete: vi.fn(() => ({ eq: deleteEq })),
        }));

        const { result } = renderHook(() => useDisconnectAccountFromProfile(), { wrapper: createWrapper() });
        await result.current.mutateAsync("acc-yt-composio");

        expect(invoke).not.toHaveBeenCalled();
        expect(deleteEq).toHaveBeenCalledWith("id", "acc-yt-composio");
    });
});
