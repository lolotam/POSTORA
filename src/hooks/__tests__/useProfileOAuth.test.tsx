import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useProfileOAuth } from "../useProfileOAuth";
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

function installLocation() {
    const assigned: string[] = [];
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: { href: string; assign: (url: string) => void } }).location = {
        href: "",
        assign: (url: string) => {
            assigned.push(url);
        },
    };
    return assigned;
}

const invokeMock = supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>;

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

    it("should start Facebook connection through the backend authorization", async () => {
        const assigned = installLocation();
        invokeMock.mockResolvedValue({
            data: { success: true, url: "https://www.facebook.com/v22.0/dialog/oauth?state=abc" },
            error: null,
        });

        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });

        await act(async () => {
            await result.current.handleConnectPlatform("profile_123", "facebook");
        });

        expect(supabase.functions.invoke).toHaveBeenCalledWith("facebook-oauth", expect.any(Object));
        const call = invokeMock.mock.calls[0];
        expect(call[1].body).toMatchObject({
            action: "authorize",
            target_platform: "facebook",
            social_profile_id: "profile_123",
        });
        expect(assigned).toEqual(["https://www.facebook.com/v22.0/dialog/oauth?state=abc"]);
    });

    it("navigates only after the backend returned the authorization URL", async () => {
        const assigned = installLocation();
        let release: (value: { data: unknown; error: unknown }) => void = () => {};
        invokeMock.mockImplementation(
            () => new Promise((resolve) => { release = resolve; }),
        );

        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });

        let pending: Promise<void> | undefined;
        await act(async () => {
            pending = result.current.handleConnectPlatform("profile_123", "facebook");
        });

        // The capture is still in flight: the browser must not have navigated.
        expect(assigned).toEqual([]);

        await act(async () => {
            release({ data: { success: true, url: "https://www.facebook.com/authorize" }, error: null });
            await pending;
        });

        expect(assigned).toEqual(["https://www.facebook.com/authorize"]);
    });

    it("names the owned target account when reconnecting", async () => {
        const assigned = installLocation();
        invokeMock.mockResolvedValue({
            data: { success: true, url: "https://www.facebook.com/authorize" },
            error: null,
        });

        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });

        await act(async () => {
            await result.current.handleReconnectPlatform("profile_123", "facebook", "account_9");
        });

        const call = invokeMock.mock.calls[0];
        expect(call[1].body).toMatchObject({
            action: "authorize",
            intent: "reconnect",
            target_social_account_id: "account_9",
        });
    });

    it("reports a failed authorization and does not navigate", async () => {
        const assigned = installLocation();
        invokeMock.mockResolvedValue({
            data: null,
            error: new Error("connection refused"),
        });

        const { result } = renderHook(() => useProfileOAuth(), { wrapper: createWrapper() });

        await act(async () => {
            await result.current.handleConnectPlatform("profile_123", "facebook");
        });

        expect(assigned).toEqual([]);
        expect(mockToast).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Connection failed",
                variant: "destructive",
            })
        );
    });
});
