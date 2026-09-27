import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ScheduledMessageManager } from "@/components/messaging/ScheduledMessageManager";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, options?: Record<string, unknown>) => {
      const template = typeof fallback === "string" ? fallback : key;
      const vars = (typeof fallback === "object" && fallback ? fallback : options) ?? undefined;
      if (!vars) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
    },
  }),
}));

const OWN = [
  { id: "acc-1", platform_username: "My Shop", platform_user_id: "965111", connection_mode: "cloud_api" },
  { id: "acc-2", platform_username: null, platform_user_id: "965222", connection_mode: "evolution_qr" },
];

/** A datetime-local value one day ahead of the real clock, so the suite never ages out. */
function futureLocal(): string {
  const when = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
const FUTURE = futureLocal();
const PHONE_ERROR = "Enter a phone number with 8–15 digits. Letters, @ and extensions are not allowed.";

let accounts: Array<(typeof OWN)[number]> = [];
let insertError: { code?: string; message: string } | null = null;
let inserted: Record<string, unknown> | null = null;
let insertSelect: string | null = null;
let accountFilters: [string, unknown][] = [];

function builder(table: string) {
  const filters: [string, unknown][] = [];
  if (table === "social_accounts") accountFilters = filters;
  let inserting = false;
  const api = {
    select: (columns?: string) => {
      if (inserting) insertSelect = columns ?? null;
      return api;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return api;
    },
    order: () => {
      if (table !== "social_accounts") return Promise.resolve({ data: [], error: null });
      const owned = filters.some(([column, value]) => column === "user_id" && value === "user-1")
        && filters.some(([column, value]) => column === "platform" && value === "whatsapp")
        && filters.some(([column, value]) => column === "is_active" && value === true);
      return Promise.resolve({
        data: owned
          ? accounts
          : [{ id: "shared", platform_username: "Shared Workspace", platform_user_id: "999", connection_mode: "cloud_api" }],
        error: null,
      });
    },
    insert: (row: Record<string, unknown>) => {
      inserting = true;
      inserted = row;
      return api;
    },
    single: () => Promise.resolve(
      insertError ? { data: null, error: insertError } : { data: { id: "sched-1" }, error: null },
    ),
  };
  return api;
}

function renderManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ScheduledMessageManager />, { wrapper });
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
  expect(await screen.findByRole("heading", { name: "Schedule message" })).toBeInTheDocument();
}

async function chooseOption(label: string, optionName: string) {
  const trigger = screen.getByLabelText(label);
  fireEvent.pointerDown(trigger, { button: 0, buttons: 1, pointerType: "mouse" });
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

async function fillReady(phone = "+965 5000 1111") {
  await waitFor(() => expect(screen.getByLabelText("WhatsApp account")).toHaveTextContent("My Shop"));
  fireEvent.change(screen.getByLabelText("Recipient phone"), { target: { value: phone } });
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "See you then" } });
  fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: FUTURE } });
}

describe("ScheduleMessageDialog", () => {
  beforeEach(() => {
    accounts = [OWN[0]];
    insertError = null;
    inserted = null;
    insertSelect = null;
    accountFilters = [];
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(supabase.from).mockImplementation((table: string) => builder(table) as never);
  });

  it("lists only the signed-in user's active WhatsApp accounts", async () => {
    accounts = OWN;
    renderManager();
    await openDialog();
    await waitFor(() => expect(accountFilters).toEqual([
      ["user_id", "user-1"],
      ["platform", "whatsapp"],
      ["is_active", true],
    ]));

    const trigger = screen.getByLabelText("WhatsApp account");
    fireEvent.pointerDown(trigger, { button: 0, buttons: 1, pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("option", { name: "My Shop" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "965222" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Shared Workspace" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "My Shop" }));
    expect(screen.getByText(/outside_session_window/)).toBeInTheDocument();

    await chooseOption("WhatsApp account", "965222");
    expect(screen.queryByText(/outside_session_window/)).not.toBeInTheDocument();
  });

  it("explains an empty account list and disables submit", async () => {
    accounts = [];
    renderManager();
    await openDialog();
    expect(await screen.findByText("No active WhatsApp account. Connect one you own before scheduling.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
  });

  it("rejects invalid phones, a past time, and media type without a URL", async () => {
    renderManager();
    await openDialog();
    await fillReady();

    for (const phone of ["+96555512345 ext 99", "96550001111@lid", "12345"]) {
      fireEvent.change(screen.getByLabelText("Recipient phone"), { target: { value: phone } });
      fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
      expect(await screen.findByText(PHONE_ERROR)).toBeInTheDocument();
    }

    fireEvent.change(screen.getByLabelText("Recipient phone"), { target: { value: "+965 5000 1111" } });
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: "2020-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Pick a time at least 1 minute from now.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: FUTURE } });
    await chooseOption("Media type", "Image");
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Choose a media type and an https URL together.")).toBeInTheDocument();
    expect(inserted).toBeNull();
  });

  it("updates the character counter", async () => {
    renderManager();
    await openDialog();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello" } });
    expect(screen.getByText("5 / 4096")).toBeInTheDocument();
  });

  it("choosing None for media clears the URL and lets the message schedule", async () => {
    renderManager();
    await openDialog();
    await fillReady();
    await chooseOption("Media type", "Image");
    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://cdn.example/a.jpg" } });
    await chooseOption("Media type", "None");
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(inserted).not.toBeNull());
    expect((inserted as Record<string, unknown>).media_url).toBeNull();
  });

  it("caps the text at the 1024-character caption limit when image media is attached", async () => {
    renderManager();
    await openDialog();
    await fillReady();
    await chooseOption("Media type", "Image");
    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://cdn.example/a.jpg" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "x".repeat(1025) } });
    expect(screen.getByText("1025 / 1024")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Message must be 1024 characters or fewer.")).toBeInTheDocument();
    expect(inserted).toBeNull();
  });

  it("inserts a pending row and confirms the scheduled time", async () => {
    renderManager();
    await openDialog();
    await fillReady();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    const scheduledAt = new Date(FUTURE).toISOString();
    await waitFor(() => expect(inserted).toEqual({
      user_id: "user-1",
      social_account_id: "acc-1",
      recipient_phone: "96550001111",
      recipient_name: null,
      message_text: "See you then",
      media_url: null,
      media_type: null,
      scheduled_at: scheduledAt,
      status: "pending",
    }));
    expect(insertSelect).toBe("id");
    expect(inserted).not.toHaveProperty("claimed_at");
    expect(inserted).not.toHaveProperty("claim_token");
    expect(inserted).not.toHaveProperty("attempts");
    expect(inserted).not.toHaveProperty("sent_at");
    expect(new Date(String(inserted?.scheduled_at)).getTime()).toBeGreaterThan(Date.now());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/^Message scheduled for /)));
  });

  it("toasts an insert failure and maps 42501 to the own-account message", async () => {
    insertError = { message: "database down" };
    renderManager();
    await openDialog();
    await fillReady();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("database down"));

    insertError = { code: "42501", message: "new row violates row-level security policy" };
    vi.mocked(toast.error).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You can only schedule from your own WhatsApp accounts."));
  });
});
