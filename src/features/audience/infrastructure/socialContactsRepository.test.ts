import { describe, it, expect, vi, beforeEach } from "vitest";

const from = vi.fn();
const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) } }));

import { listContacts, fetchContactStats, fetchAllContacts, updateContact } from "./socialContactsRepository";
import { EMPTY_FILTERS } from "../domain/socialContact";

function chain(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "limit", "update", "delete"]) q[m] = vi.fn(() => q);
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q as Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
}

beforeEach(() => { from.mockReset(); rpc.mockReset(); });

describe("listContacts", () => {
  it("calls the search RPC with nulls for 'all', the raw term, and a 50-row window", async () => {
    rpc.mockResolvedValue({ data: [{ row_count: 120, contact: { id: "1" } }], error: null });
    const page = await listContacts({ search: "da,na%", platform: "instagram", source: "all", tags: ["lead"] }, 2);
    expect(rpc).toHaveBeenCalledWith("search_social_contacts", {
      p_query: "da,na%", p_platform: "instagram", p_source: null, p_tags: ["lead"], p_limit: 50, p_offset: 100,
    });
    expect(page).toEqual({ rows: [{ id: "1" }], total: 120 });
  });
  it("sends null for an empty search and empty tags", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const page = await listContacts(EMPTY_FILTERS, 0);
    expect(rpc).toHaveBeenCalledWith("search_social_contacts", { p_query: null, p_platform: null, p_source: null, p_tags: null, p_limit: 50, p_offset: 0 });
    expect(page).toEqual({ rows: [], total: 0 });
  });
  it("throws the Supabase error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(listContacts(EMPTY_FILTERS, 0)).rejects.toMatchObject({ message: "nope" });
  });
});

describe("fetchAllContacts", () => {
  it("pages through the RPC until a short page", async () => {
    rpc
      .mockResolvedValueOnce({ data: Array.from({ length: 200 }, (_, i) => ({ row_count: 201, contact: { id: String(i) } })), error: null })
      .mockResolvedValueOnce({ data: [{ row_count: 201, contact: { id: "200" } }], error: null });
    const { rows, truncated } = await fetchAllContacts(EMPTY_FILTERS);
    expect(rows).toHaveLength(201);
    expect(truncated).toBe(false);
    expect(rpc).toHaveBeenNthCalledWith(2, "search_social_contacts", expect.objectContaining({ p_limit: 200, p_offset: 200 }));
  });
});

describe("fetchContactStats", () => {
  it("reads the first row of the set-returning RPC", async () => {
    rpc.mockResolvedValue({ data: [{ total: 3, workflow_leads: 1, enriched: 2, top_platform: "instagram" }], error: null });
    expect(await fetchContactStats()).toEqual({ total: 3, workflow_leads: 1, enriched: 2, top_platform: "instagram" });
    expect(rpc).toHaveBeenCalledWith("get_social_contacts_stats");
  });
  it("returns zeros when the RPC yields no row", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchContactStats()).toEqual({ total: 0, workflow_leads: 0, enriched: 0, top_platform: null });
  });
});

describe("updateContact", () => {
  it("updates by id with the patch", async () => {
    const q = chain({ data: null, error: null });
    from.mockReturnValue(q);
    await updateContact("1", { tags: ["vip"] });
    expect(from).toHaveBeenCalledWith("social_contacts");
    expect(q.update).toHaveBeenCalledWith({ tags: ["vip"] });
    expect(q.eq).toHaveBeenCalledWith("id", "1");
  });
});
