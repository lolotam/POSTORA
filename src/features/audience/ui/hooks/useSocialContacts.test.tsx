import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
const toasts: Array<{ title?: string; description?: string; variant?: string }> = [];
vi.mock("@/hooks/use-toast", () => ({
  toast: (t: { title?: string; description?: string; variant?: string }) => toasts.push(t),
}));
const listContacts = vi.fn();
const updateContact = vi.fn();
const findWhatsAppContactByPhone = vi.fn();
vi.mock("../../infrastructure/socialContactsRepository", () => ({
  listContacts: (...a: unknown[]) => listContacts(...a),
  fetchContactStats: vi.fn(),
  fetchDistinctTags: vi.fn(),
  updateContact: (...a: unknown[]) => updateContact(...a),
  deleteContact: vi.fn(),
  findWhatsAppContactByPhone: (...a: unknown[]) => findWhatsAppContactByPhone(...a),
  CONTACTS_PAGE_SIZE: 50,
}));

import { useSocialContacts, useUpdateSocialContact, useWhatsAppContactMatch } from "./useSocialContacts";
import { EMPTY_FILTERS } from "../../domain/socialContact";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSocialContacts", () => {
  it("passes filters and page to the repository", async () => {
    listContacts.mockResolvedValue({ rows: [], total: 0 });
    const { result } = renderHook(() => useSocialContacts({ ...EMPTY_FILTERS, platform: "threads" }, 1), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listContacts).toHaveBeenCalledWith({ ...EMPTY_FILTERS, platform: "threads" }, 1);
  });
});

describe("useUpdateSocialContact", () => {
  it("calls the repository with id and patch", async () => {
    updateContact.mockResolvedValue(undefined);
    const { result } = renderHook(() => useUpdateSocialContact(), { wrapper: wrapper() });
    result.current.mutate({ id: "1", patch: { notes: "x" } });
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith("1", { notes: "x" }));
  });

  // The composite FK (whatsapp_contact_id, user_id) rejects a WhatsApp contact
  // from another owner; the repository surfaces that Supabase error here.
  it("toasts destructively when the update is rejected", async () => {
    updateContact.mockRejectedValue(new Error("violates foreign key constraint"));
    const { result } = renderHook(() => useUpdateSocialContact(), { wrapper: wrapper() });
    result.current.mutate({ id: "1", patch: { whatsapp_contact_id: "wa-1" } });
    await waitFor(() =>
      expect(toasts.some((t) => t.variant === "destructive" && t.description === "violates foreign key constraint"))
        .toBe(true));
  });
});

describe("useWhatsAppContactMatch", () => {
  it("is disabled without a phone and queries by phone when one exists", async () => {
    const disabled = renderHook(() => useWhatsAppContactMatch(null), { wrapper: wrapper() });
    expect(disabled.result.current.fetchStatus).toBe("idle");
    expect(findWhatsAppContactByPhone).not.toHaveBeenCalled();

    findWhatsAppContactByPhone.mockResolvedValue({ id: "wa-1", display_name: "Dana WA" });
    const enabled = renderHook(() => useWhatsAppContactMatch("96550000000"), { wrapper: wrapper() });
    await waitFor(() => expect(enabled.result.current.data).toEqual({ id: "wa-1", display_name: "Dana WA" }));
    expect(findWhatsAppContactByPhone).toHaveBeenCalledWith("u1", "96550000000");
  });
});
