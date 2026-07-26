import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useProfileOAuth } from "../useProfileOAuth";
import { facebookLogin } from "@/lib/facebookSdk";
import { supabase } from "@/integrations/supabase/client";

// Mock dependencies
const mockSearchParams = new URLSearchParams();
const mockSetSearchParams = vi.fn();

vi.mock("react-router-dom", () => ({
    useSearchParams: () => [mockSearchParams, mockSetSearchParams],
}));

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
    useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/hooks/useAuth", () => ({
    useAuth: () => ({ user: { id: "test-user-id" } }),
}));

vi.mock("@/lib/facebookSdk", () => ({
    facebookLogin: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        functions: {
            invoke: vi.fn(),
        },
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        eq: vi.fn(() => ({
                            order: vi.fn(() => ({
                                limit: vi.fn().mockResolvedValue({ data: [{ id: "acc_123" }], error: null }),
                            })),
                        })),
                    })),
                })),
            })),
            update: vi.fn(() => ({
                eq: vi.fn().mockResolvedValue({ error: null }),
            })),
        })),
    },
}));

// useProfileOAuth now runs React Query calls, so it needs a client in scope.
function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
}

describe("useProfileOAuth Hook", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSearchParams.delete("error");
        mockSearchParams.delete("connected");
        mockToast.mockClear();
        try { sessionStorage.clear(); } catch { /* ignore */ }
    });

    it("should handle error in URL params", () => {
        mockSearchParams.set("error", "access_denied");
        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });
        expect(mockSetSearchParams).toHaveBeenCalledWith({});
    });

    it("should start Facebook connection successfully", async () => {
        (facebookLogin as any).mockResolvedValue({
            success: true,
            response: {
                status: "connected",
                authResponse: { accessToken: "fb-token" },
            },
            diagnostics: { origin: "https://postora.cloud", timestamp: new Date().toISOString(), sdkLoaded: true, loginStatus: "connected" },
        });

        (supabase.functions.invoke as any).mockResolvedValue({
            data: { success: true },
            error: null,
        });

        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });

        await act(async () => {
            await result.current.handleConnectPlatform("profile_123", "facebook");
        });

        expect(facebookLogin).toHaveBeenCalled();
        expect(supabase.functions.invoke).toHaveBeenCalledWith("facebook-oauth", expect.any(Object));
    });

    it("should handle user_cancelled Facebook login", async () => {
        (facebookLogin as any).mockResolvedValue({
            success: false,
            response: { status: "unknown" },
            failureReason: "user_cancelled",
            diagnostics: { origin: "https://postora.cloud", timestamp: new Date().toISOString(), sdkLoaded: true, loginStatus: "unknown" },
        });

        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });

        await act(async () => {
            await result.current.handleConnectPlatform("profile_123", "facebook");
        });

        expect(mockToast).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Connection failed",
                variant: "destructive",
            })
        );
        expect(supabase.functions.invoke).not.toHaveBeenCalled();
    });

    it("should handle not_authorized Facebook login", async () => {
        (facebookLogin as any).mockResolvedValue({
            success: false,
            response: { status: "not_authorized" },
            failureReason: "not_authorized",
            diagnostics: { origin: "https://postora.cloud", timestamp: new Date().toISOString(), sdkLoaded: true, loginStatus: "not_authorized" },
        });

        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });

        await act(async () => {
            await result.current.handleConnectPlatform("profile_123", "facebook");
        });

        expect(mockToast).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "destructive",
            })
        );
        // Should store debug info
        const stored = sessionStorage.getItem("fb_last_oauth_debug");
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        expect(parsed.reason).toBe("not_authorized");
    });

    it("should handle SDK load failure", async () => {
        (facebookLogin as any).mockResolvedValue({
            success: false,
            response: { status: "unknown" },
            failureReason: "sdk_load_failed",
            diagnostics: { origin: "https://postora.cloud", timestamp: new Date().toISOString(), sdkLoaded: false, loginStatus: "sdk_not_loaded" },
        });

        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });

        await act(async () => {
            await result.current.handleConnectPlatform("profile_123", "facebook");
        });

        expect(mockToast).toHaveBeenCalledWith(
            expect.objectContaining({
                description: expect.stringContaining("ad-blocker"),
            })
        );
    });
});
