import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  ACTIVE_WHATSAPP_STATUSES,
  CALENDAR_WHATSAPP_STATUSES,
  WHATSAPP_RANGE_LIMIT,
} from "@/features/scheduled/domain/whatsAppSchedule";
import { useWhatsAppScheduledMutations } from "@/hooks/useWhatsAppScheduledMessages";
import Calendar from "@/pages/Calendar";
import ScheduledPosts from "@/pages/ScheduledPosts";

const translate = vi.hoisted(() => (
  key: string,
  fallback?: string | Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const template = typeof fallback === "string" ? fallback : key;
  const vars = typeof fallback === "string" ? options : fallback;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, session: { user: { id: "user-1" } } }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));

interface QueryOp {
  method: string;
  args: unknown[];
}

const calls: { table: string; ops: QueryOp[] }[] = [];

function tableBuilder(table: string) {
  const ops: QueryOp[] = [];
  let writing = false;
  calls.push({ table, ops });
  const builder: Record<string, unknown> = {};
  const chain = (...method: [string, ...unknown[]]) => {
    const [name, ...args] = method;
    if (name === "update") writing = true;
    ops.push({ method: name, args });
    return builder;
  };
  for (const method of ["select", "eq", "in", "gte", "lte", "gt", "order", "limit", "update", "insert"]) {
    builder[method] = (...args: unknown[]) => chain(method, ...args);
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    const result = writing
      ? { data: [{ id: "msg-1" }], error: null }
      : { data: [], error: null, count: 0 };
    return Promise.resolve(result).then(resolve, reject);
  };
  return builder;
}

function whatsAppCalls() {
  return calls.filter((call) => call.table === "whatsapp_scheduled_messages");
}

function statusFilter(ops: QueryOp[]): unknown {
  return ops.find((op) => op.method === "in" && op.args[0] === "status")?.args[1];
}

function renderPage(page: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

describe("scheduled pages do not list every WhatsApp message", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.mocked(supabase.from).mockImplementation((table: string) => tableBuilder(table) as never);
    vi.mocked(supabase.rpc).mockResolvedValue({ data: "user", error: null } as never);
  });

  it("loads the calendar through the range-scoped read model only", async () => {
    renderPage(<Calendar />);
    await waitFor(() => expect(whatsAppCalls().length).toBeGreaterThan(0));
    expect(whatsAppCalls().length).toBeGreaterThan(0);
    for (const call of whatsAppCalls()) {
      expect(statusFilter(call.ops)).toEqual([...CALENDAR_WHATSAPP_STATUSES]);
      expect(call.ops.some((op) => op.method === "gte" && op.args[0] === "scheduled_at")).toBe(true);
      expect(call.ops.some((op) => op.method === "lte" && op.args[0] === "scheduled_at")).toBe(true);
      expect(call.ops).toContainEqual({ method: "limit", args: [WHATSAPP_RANGE_LIMIT] });
      expect(call.ops.some((op) => op.method === "eq" && op.args[0] === "user_id" && op.args[1] === "user-1")).toBe(true);
    }
  });

  it("loads the scheduled board through the active-status read model only", async () => {
    renderPage(<ScheduledPosts />);
    await waitFor(() => expect(whatsAppCalls().length).toBeGreaterThan(0));
    expect(whatsAppCalls().length).toBeGreaterThan(0);
    for (const call of whatsAppCalls()) {
      expect(statusFilter(call.ops)).toEqual([...ACTIVE_WHATSAPP_STATUSES]);
      expect(call.ops.some((op) => op.method === "gte" || op.method === "lte" || op.method === "limit")).toBe(false);
      expect(call.ops.some((op) => op.method === "eq" && op.args[0] === "user_id" && op.args[1] === "user-1")).toBe(true);
    }
  });

  it("still refreshes the scheduled views after cancel and reschedule", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useWhatsAppScheduledMutations(), { wrapper });
    expect(whatsAppCalls()).toEqual([]);
    await result.current.reschedule.mutateAsync({ id: "msg-1", scheduledAt: "2026-12-01T12:30:00.000Z" });
    await result.current.cancel.mutateAsync("msg-1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-scheduled"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["posts"] });
    expect(whatsAppCalls().every((call) => call.ops.some((op) => op.method === "update"))).toBe(true);
    expect(whatsAppCalls().some((call) => call.ops.some((op) => op.method === "select" && op.args[0] === "*"))).toBe(false);
  });
});
