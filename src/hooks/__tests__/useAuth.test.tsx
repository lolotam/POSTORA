import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "../useAuth";
import { supabase } from "@/integrations/supabase/client";

// Mock Supabase client
vi.mock("@/integrations/supabase/client", () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
            onAuthStateChange: vi.fn(),
            signInWithPassword: vi.fn(),
            signInWithOAuth: vi.fn(),
            signUp: vi.fn(),
            signOut: vi.fn(),
        },
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    maybeSingle: vi.fn(),
                })),
            })),
        })),
    },
}));

describe("useAuth Hook", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Default mock implementation for auth state
        const mockSubscription = { subscription: { unsubscribe: vi.fn() } };
        (supabase.auth.onAuthStateChange as Mock).mockReturnValue({
            data: mockSubscription,
        });

        // Default mock for getSession
        vi.mocked(supabase.auth.getSession).mockResolvedValue({
            data: { session: null },
            error: null,
        });
    });

    it("should initialize with loading state", async () => {
        const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
        // Initially matches whatever state, but we check if it resolves loading
        await waitFor(() => expect(result.current.isLoading).toBe(false));
    });

    it("should handle sign in", async () => {
        (supabase.auth.signInWithPassword as Mock).mockResolvedValue({
            data: { user: { id: "123" }, session: {} },
            error: null,
        });

        const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        await act(async () => {
            await result.current.signIn("test@example.com", "password");
        });

        expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
            email: "test@example.com",
            password: "password",
        });
    });

    it("should handle sign out", async () => {
        const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
        await waitFor(() => expect(result.current.isLoading).toBe(false));

        await act(async () => {
            await result.current.signOut();
        });

        expect(supabase.auth.signOut).toHaveBeenCalled();
    });
    describe("profile read deduplication", () => {
        // `onAuthStateChange` fires INITIAL_SESSION on subscribe and `getSession()`
        // resolves with the same session moments later. Both used to fetch the
        // profile, so every page load issued two identical reads.
        const session = { user: { id: "user-1" }, access_token: "t" };

        function mockProfileReads(...results: Array<{ data: unknown; error: unknown }>) {
            const maybeSingle = vi.fn();
            results.forEach((r) => maybeSingle.mockResolvedValueOnce(r));
            maybeSingle.mockResolvedValue(results[results.length - 1]);
            (supabase.from as Mock).mockReturnValue({
                select: () => ({ eq: () => ({ maybeSingle }) }),
            });
            return maybeSingle;
        }

        function driveBothAuthArms() {
            (supabase.auth.onAuthStateChange as Mock).mockImplementation((cb: (event: string, s: typeof session) => void) => {
                setTimeout(() => cb("INITIAL_SESSION", session), 0);
                return { data: { subscription: { unsubscribe: vi.fn() } } };
            });
            (supabase.auth.getSession as Mock).mockResolvedValue({
                data: { session },
                error: null,
            });
        }

        it("reads the profile once when both auth arms report the same user", async () => {
            driveBothAuthArms();
            const maybeSingle = mockProfileReads({
                data: { id: "user-1", email: "a@b.c", full_name: "A" },
                error: null,
            });

            const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

            await waitFor(() => expect(result.current.profile?.id).toBe("user-1"));
            expect(maybeSingle).toHaveBeenCalledTimes(1);
        });

        // Regression, PR #185: deduplicating the two arms removed the retry the
        // duplicate request used to provide. It only bites when the second arm
        // arrives while the first read is still in flight, so the first read is
        // held open here until both arms have asked for it.
        it("retries when the first read is still in flight and then fails", async () => {
            let failFirstRead!: () => void;
            const firstRead = new Promise((resolve) => {
                failFirstRead = () => resolve({ data: null, error: { message: "network" } });
            });

            const maybeSingle = vi
                .fn()
                .mockReturnValueOnce(firstRead)
                .mockResolvedValue({
                    data: { id: "user-1", email: "a@b.c", full_name: "A" },
                    error: null,
                });
            (supabase.from as Mock).mockReturnValue({
                select: () => ({ eq: () => ({ maybeSingle }) }),
            });
            driveBothAuthArms();

            const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });

            // Both arms have now asked; only one request went out.
            await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1));
            await act(async () => {
                failFirstRead();
                await firstRead;
            });

            await waitFor(() => expect(result.current.profile?.id).toBe("user-1"));
            expect(maybeSingle).toHaveBeenCalledTimes(2);
        });
    });
});
