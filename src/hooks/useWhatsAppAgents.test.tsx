import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useConversationAssignments } from "./useWhatsAppAgents";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("./useAuth", () => ({ useAuth: () => ({ session: { user: { id: "owner-a" } } }) }));

type Row = Record<string, unknown>;

// Filter-aware database boundary: a text-key-only lookup really does see the
// other tenant. Capture persisted payloads rather than asserting hook success.
function assignmentDatabase(existing: Row[] = [], fail?: string) {
  const tables: Record<string, Row[]> = {
    whatsapp_agents: [{ id: "agent-a", workspace_id: "workspace-a" }],
    messaging_cache: [{ id: "cache-a", workspace_id: "workspace-a", conversation_id: "shared-key" }],
    whatsapp_conversation_assignments: existing,
    whatsapp_assignment_history: [],
  };
  const writes: { table: string; payload: Row }[] = [];
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    const filters: [string, unknown][] = [];
    let operation = "select";
    let payload: Row = {};
    let single = false;
    const result = () => {
      if (fail === `${table}:${operation}`) return { data: null, error: new Error("database failed") };
      const matches = tables[table].filter((row) => filters.every(([key, value]) => row[key] === value));
      if (operation === "insert") {
        writes.push({ table, payload });
        tables[table].push(payload);
        return { data: payload, error: null };
      }
      if (operation === "update") matches.forEach((row) => Object.assign(row, payload));
      return { data: single ? matches[0] ?? null : matches, error: null };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      order: () => query,
      insert: (row: Row) => { operation = "insert"; payload = row; return query; },
      update: (row: Row) => { operation = "update"; payload = row; return query; },
      single: () => { single = true; return Promise.resolve(result()); },
      maybeSingle: () => { single = true; return Promise.resolve(result()); },
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return query;
  // The fake implements only the PostgREST operations exercised at this boundary.
  }) as unknown as typeof supabase.from);
  return { tables, writes };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function activeAssignment(workspaceId: string): Row {
  return { id: `assignment-${workspaceId}`, workspace_id: workspaceId, conversation_id: "shared-key", agent_id: "old-agent", unassigned_at: null };
}

describe("human-agent assignment tenancy", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])("writes tenant and cache IDs for assignments and history (transfer=%s)", async (transfer) => {
    const db = assignmentDatabase(transfer ? [activeAssignment("workspace-a")] : []);
    const { result } = renderHook(() => useConversationAssignments("workspace-a"), { wrapper: createWrapper() });
    await act(async () => {
      await result.current.assignConversation.mutateAsync({ conversationId: "shared-key", agentId: "agent-a" });
    });
    expect(db.writes.find((write) => write.table === "whatsapp_conversation_assignments")?.payload).toMatchObject({
      workspace_id: "workspace-a", conversation_cache_id: "cache-a", conversation_id: "shared-key", agent_id: "agent-a",
    });
    expect(db.writes.find((write) => write.table === "whatsapp_assignment_history")?.payload).toMatchObject({
      workspace_id: "workspace-a", action: transfer ? "transferred" : "assigned",
    });
  });

  it.each(["assign", "unassign"] as const)("%s does not find or unassign another workspace's same text key", async (operation) => {
    const foreign = activeAssignment("workspace-b");
    const db = assignmentDatabase([foreign]);
    const { result } = renderHook(() => useConversationAssignments("workspace-a"), { wrapper: createWrapper() });
    await act(async () => {
      if (operation === "assign") {
        await result.current.assignConversation.mutateAsync({ conversationId: "shared-key", agentId: "agent-a" });
      } else {
        await result.current.unassignConversation.mutateAsync({ conversationId: "shared-key" });
      }
    });
    expect(foreign.unassigned_at).toBeNull();
    expect(db.tables.whatsapp_assignment_history.map((row) => row.action)).toEqual(operation === "assign" ? ["assigned"] : []);
  });

  it("unassignment history inherits the current agent's resolved workspace", async () => {
    const own = activeAssignment("workspace-a");
    const db = assignmentDatabase([own]);
    const { result } = renderHook(() => useConversationAssignments("workspace-a"), { wrapper: createWrapper() });
    await act(async () => {
      await result.current.unassignConversation.mutateAsync({ conversationId: "shared-key", reason: "resolved" });
    });
    expect(own.unassigned_at).toEqual(expect.any(String));
    expect(db.writes[0].payload).toMatchObject({ workspace_id: "workspace-a", action: "unassigned", reason: "resolved" });
  });

  it("cache-less conversations still write tenancy on both tables", async () => {
    const db = assignmentDatabase();
    db.tables.messaging_cache = [];
    const { result } = renderHook(() => useConversationAssignments(), { wrapper: createWrapper() });
    await act(async () => {
      await result.current.assignConversation.mutateAsync({ conversationId: "shared-key", agentId: "agent-a" });
    });
    expect(db.writes.every((write) => write.payload.workspace_id === "workspace-a")).toBe(true);
    expect(db.tables.whatsapp_conversation_assignments[0].conversation_cache_id).toBeNull();
  });

  it("unassignment refuses to guess when the current agent has no resolved workspace", async () => {
    const db = assignmentDatabase([activeAssignment("workspace-a")]);
    const { result } = renderHook(() => useConversationAssignments(), { wrapper: createWrapper() });
    await act(async () => {
      await expect(result.current.unassignConversation.mutateAsync({ conversationId: "shared-key" })).rejects.toThrow("No workspace found");
    });
    expect(db.tables.whatsapp_conversation_assignments[0].unassigned_at).toBeNull();
    expect(db.writes).toEqual([]);
  });

  it.each(["select", "update"])("unassignment surfaces an existing-assignment %s failure", async (operation) => {
    const db = assignmentDatabase([activeAssignment("workspace-a")], `whatsapp_conversation_assignments:${operation}`);
    const { result } = renderHook(() => useConversationAssignments("workspace-a"), { wrapper: createWrapper() });
    await act(async () => {
      await expect(result.current.unassignConversation.mutateAsync({ conversationId: "shared-key" })).rejects.toThrow("database failed");
    });
    expect(db.tables.whatsapp_conversation_assignments[0].unassigned_at).toBeNull();
    expect(db.writes).toEqual([]);
  });

  it.each(["whatsapp_agents:select", "messaging_cache:select", "whatsapp_conversation_assignments:select", "whatsapp_conversation_assignments:update"])("stops assignment on %s failure", async (fail) => {
    const db = assignmentDatabase([activeAssignment("workspace-a")], fail);
    const { result } = renderHook(() => useConversationAssignments(), { wrapper: createWrapper() });
    await act(async () => {
      await expect(result.current.assignConversation.mutateAsync({ conversationId: "shared-key", agentId: "agent-a" })).rejects.toThrow("database failed");
    });
    expect(db.writes).toEqual([]);
  });
});
