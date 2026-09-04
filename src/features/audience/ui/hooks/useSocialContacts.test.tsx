import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
const listContacts = vi.fn();
const updateContact = vi.fn();
vi.mock("../../infrastructure/socialContactsRepository", () => ({
  listContacts: (...a: unknown[]) => listContacts(...a),
  fetchContactStats: vi.fn(),
  fetchDistinctTags: vi.fn(),
  updateContact: (...a: unknown[]) => updateContact(...a),
  deleteContact: vi.fn(),
  CONTACTS_PAGE_SIZE: 50,
}));

import { useSocialContacts, useUpdateSocialContact } from "./useSocialContacts";
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
});
