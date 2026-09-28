import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ScheduledMessageManager } from "@/components/messaging/ScheduledMessageManager";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    functions: { invoke: vi.fn() },
    storage: { from: vi.fn(() => ({ getPublicUrl: () => ({ data: { publicUrl: "https://storage.example/object" } }) })) },
  },
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));
vi.mock("@/hooks/useQuotas", () => ({
  useQuotas: () => ({
    canUploadMedia: async () => (quotaGate.allowed ? { allowed: true } : { allowed: false, message: quotaGate.message }),
    incrementMediaUpload: async () => quotaGate.increment,
    quota: null,
    planLimits: { max_media_uploads_per_day: 20 },
  }),
}));
vi.mock("@/hooks/useCdnConfig", () => ({ useCdnConfig: () => ({ data: undefined }) }));
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

interface LibraryRow {
  id: string;
  file_path: string;
  file_type: string;
  file_size: number | null;
  mime_type: string | null;
  metadata: Record<string, unknown> | null;
  storage_bucket: string | null;
  current_object_version: number | null;
  media_file_providers?: unknown[];
}

const LIB: LibraryRow[] = [
  {
    id: "mf-doc",
    file_path: "https://res.cloudinary.com/demo/raw/upload/postora_doc1.pdf",
    file_type: "document",
    file_size: 2048,
    mime_type: "application/pdf",
    metadata: { kind: "document", original_filename: "invoice.pdf" },
    storage_bucket: "cloudinary",
    current_object_version: 1,
  },
  {
    id: "mf-zip",
    file_path: "https://res.cloudinary.com/demo/raw/upload/postora_zip9.zip",
    file_type: "document",
    file_size: 4096,
    mime_type: "application/zip",
    metadata: { kind: "archive", original_filename: "pack.zip" },
    storage_bucket: "cloudinary",
    current_object_version: 1,
  },
  {
    id: "mf-webp",
    file_path: "https://res.cloudinary.com/demo/image/upload/postora_img3.webp",
    file_type: "image",
    file_size: 1024,
    mime_type: "image/webp",
    metadata: { kind: "image", original_filename: "photo.webp" },
    storage_bucket: "cloudinary",
    current_object_version: 1,
  },
];

const quotaGate = { allowed: true, increment: true, message: "limit reached" };

class StubFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  error: unknown = null;
  readAsDataURL() {
    this.result = "data:application/octet-stream;base64,SGVsbG8=";
    this.onload?.();
  }
}

/** A datetime-local value one day ahead of the real clock, so the suite never ages out. */
function futureLocal(): string {
  const when = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
const FUTURE = futureLocal();
const PHONE_ERROR = "Enter a phone number with 8–15 digits. Letters, @ and extensions are not allowed.";
const CLOUD_REFUSED = (extension: string) => `WhatsApp Cloud API doesn't accept .${extension} files. Use a QR account or convert it.`;

let accounts: Array<(typeof OWN)[number]> = [];
let insertError: { code?: string; message: string } | null = null;
let inserted: Record<string, unknown> | null = null;
let insertCount = 0;
let insertSelect: string | null = null;
let holdInsert = false;
let releaseInsert: (() => void) | null = null;
let accountFilters: [string, unknown][] = [];
let mediaFilters: [string, unknown][] = [];
let libraryRows: LibraryRow[] = [];
let libraryError: { message: string } | null = null;
interface MediaQueryCapture {
  eqs: [string, unknown][];
  or: string | null;
  range: [number, number] | null;
  select: string | null;
}
let lastMediaQuery: MediaQueryCapture = { eqs: [], or: null, range: null, select: null };
let invokeQueue: Array<{ data?: unknown; error?: unknown }> = [];
const invokeCalls: Array<{ path: string; body: Record<string, unknown> }> = [];

function builder(table: string) {
  const filters: [string, unknown][] = [];
  if (table === "social_accounts") accountFilters = filters;
  if (table === "media_files") {
    mediaFilters = filters;
    lastMediaQuery = { eqs: filters, or: null, range: null, select: null };
  }
  let inserting = false;
  const api = {
    select: (columns?: string) => {
      if (inserting) insertSelect = columns ?? null;
      if (table === "media_files") lastMediaQuery.select = columns ?? null;
      return api;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return api;
    },
    or: (expression: string) => {
      if (table === "media_files") lastMediaQuery.or = expression;
      return api;
    },
    order: () => {
      if (table === "media_files") return api;
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
    range: (from: number, to: number) => {
      if (table === "media_files") lastMediaQuery.range = [from, to];
      const owned = filters.some(([column, value]) => column === "user_id" && value === "user-1");
      if (libraryError) return Promise.resolve({ data: null, error: libraryError });
      return Promise.resolve({ data: owned ? libraryRows.slice(from, to + 1) : [], error: null });
    },
    limit: () => {
      const owned = filters.some(([column, value]) => column === "user_id" && value === "user-1");
      return Promise.resolve({ data: owned ? libraryRows : [], error: null });
    },
    insert: (row: Record<string, unknown>) => {
      inserting = true;
      inserted = row;
      insertCount += 1;
      return api;
    },
    single: () => {
      if (holdInsert) {
        return new Promise<{ data: unknown; error: unknown }>((resolve) => {
          releaseInsert = () => resolve({ data: { id: "sched-1" }, error: null });
        }) as never;
      }
      return Promise.resolve(
        insertError ? { data: null, error: insertError } : { data: { id: "sched-1" }, error: null },
      );
    },
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

/** Radix tab triggers activate on mousedown, not click. */
function openSourceTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
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

function pickFile(name: string, type = "application/octet-stream") {
  fireEvent.change(screen.getByLabelText("Choose a file"), {
    target: { files: [new File(["content"], name, { type })] },
  });
}

describe("ScheduleMessageDialog", () => {
  beforeEach(() => {
    accounts = [OWN[0]];
    insertError = null;
    inserted = null;
    insertCount = 0;
    insertSelect = null;
    holdInsert = false;
    releaseInsert = null;
    accountFilters = [];
    mediaFilters = [];
    libraryRows = [];
    libraryError = null;
    lastMediaQuery = { eqs: [], or: null, range: null, select: null };
    invokeQueue = [];
    invokeCalls.length = 0;
    quotaGate.allowed = true;
    quotaGate.increment = true;
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(supabase.from).mockImplementation((table: string) => builder(table) as never);
    vi.mocked(supabase.functions.invoke).mockClear();
    vi.mocked(supabase.functions.invoke).mockImplementation(async (path: string, opts?: { body?: unknown }) => {
      invokeCalls.push({ path, body: (opts?.body ?? {}) as Record<string, unknown> });
      const next = invokeQueue.shift();
      if (!next) return { data: undefined, error: null };
      if (next.error) throw next.error;
      return { data: next.data, error: null };
    });
    vi.stubGlobal("FileReader", StubFileReader);
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

  it("rejects invalid phones, a past time, and a link type without a URL", async () => {
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
    openSourceTab("Paste link");
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

  it("switching back to None clears the link and lets the message schedule", async () => {
    renderManager();
    await openDialog();
    await fillReady();
    openSourceTab("Paste link");
    await chooseOption("Media type", "Image");
    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://cdn.example/a.jpg" } });
    openSourceTab("None");
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(inserted).not.toBeNull());
    expect((inserted as Record<string, unknown>).media_url).toBeNull();
  });

  it("caps the text at the 1024-character caption limit when image media is linked", async () => {
    renderManager();
    await openDialog();
    await fillReady();
    openSourceTab("Paste link");
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
      media_filename: null,
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

  it("an upload success fills the URL, type and filename, and the insert carries media_filename", async () => {
    invokeQueue = [{ data: { success: true, mediaFileId: "mf-1", url: "https://res.cloudinary.com/demo/image/upload/postora_x1.jpg" } }];
    renderManager();
    await openDialog();
    await fillReady();
    openSourceTab("Upload file");
    pickFile("invoice.jpg", "image/jpeg");

    expect(await screen.findByText("Selected: invoice.jpg")).toBeInTheDocument();
    expect(invokeCalls[0]).toMatchObject({ path: "cloudinary-upload", body: { fileName: "invoice.jpg", fileType: "image" } });
    expect(String(invokeCalls[0].body.fileData)).toContain("base64");

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(inserted).not.toBeNull());
    expect(inserted).toMatchObject({
      media_url: "https://res.cloudinary.com/demo/image/upload/postora_x1.jpg",
      media_type: "image",
      media_filename: "invoice.jpg",
    });
  });

  it("an upload refusal shows the backend message", async () => {
    invokeQueue = [{ data: { success: false, error: "Unsupported fileType" } }];
    renderManager();
    await openDialog();
    openSourceTab("Upload file");
    pickFile("invoice.jpg", "image/jpeg");
    expect(await screen.findByText("Unsupported fileType")).toBeInTheDocument();
    expect(inserted).toBeNull();
  });

  it("the Library picker lists documents and archives, and selecting one fills the fields", async () => {
    accounts = [OWN[1]];
    libraryRows = LIB;
    renderManager();
    await openDialog();
    openSourceTab("Choose from Library");

    expect(await screen.findByText("invoice.pdf")).toBeInTheDocument();
    expect(screen.getByText("pack.zip")).toBeInTheDocument();
    expect(screen.getByText("photo.webp")).toBeInTheDocument();
    expect(mediaFilters).toContainEqual(["user_id", "user-1"]);

    fireEvent.click(screen.getByText("pack.zip"));
    fireEvent.change(screen.getByLabelText("Recipient phone"), { target: { value: "+965 5000 1111" } });
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: FUTURE } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));

    await waitFor(() => expect(inserted).not.toBeNull());
    expect(inserted).toMatchObject({
      media_url: "https://res.cloudinary.com/demo/raw/upload/postora_zip9.zip",
      media_type: "document",
      media_filename: "pack.zip",
    });
  });

  it("a Cloud API account blocks zip and webp while a QR account allows them, re-validating on switch", async () => {
    accounts = OWN;
    libraryRows = LIB;
    renderManager();
    await openDialog();
    await waitFor(() => expect(screen.getByLabelText("WhatsApp account")).toBeInTheDocument());
    await chooseOption("WhatsApp account", "My Shop");
    openSourceTab("Choose from Library");
    fireEvent.click(await screen.findByText("pack.zip"));

    expect(await screen.findByText(CLOUD_REFUSED("zip"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();

    fireEvent.click(screen.getByText("photo.webp"));
    expect(await screen.findByText(CLOUD_REFUSED("webp"))).toBeInTheDocument();

    await chooseOption("WhatsApp account", "965222");
    await waitFor(() => expect(screen.queryByText(CLOUD_REFUSED("zip"))).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Schedule" })).toBeEnabled();

    fireEvent.click(screen.getByText("pack.zip"));
    fireEvent.change(screen.getByLabelText("Recipient phone"), { target: { value: "+965 5000 1111" } });
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: FUTURE } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(inserted).not.toBeNull());
    expect(inserted).toMatchObject({ media_type: "document", media_filename: "pack.zip" });
  });

  it("a pasted link on a Cloud account needs a known whatsappCloud extension matching the type; QR allows the rest", async () => {
    accounts = OWN;
    renderManager();
    await openDialog();
    await waitFor(() => expect(screen.getByLabelText("WhatsApp account")).toBeInTheDocument());
    await chooseOption("WhatsApp account", "My Shop");
    await fillReady();
    openSourceTab("Paste link");
    await chooseOption("Media type", "Image");

    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://cdn.example/pack.zip" } });
    expect(await screen.findByText(CLOUD_REFUSED("zip"))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://cdn.example/redirect" } });
    expect(await screen.findByText("WhatsApp Cloud API needs a link that ends in a known file extension.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://cdn.example/a.jpg" } });
    await chooseOption("Media type", "Document");
    expect(await screen.findByText("This link is a .jpg file — pick Image as the media type.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();

    await chooseOption("WhatsApp account", "965222");
    await waitFor(() => expect(screen.queryByText(/WhatsApp Cloud API/)).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Media URL"), { target: { value: "https://cdn.example/redirect" } });
    expect(screen.getByRole("button", { name: "Schedule" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(inserted).not.toBeNull());
    expect(inserted).toMatchObject({ media_url: "https://cdn.example/redirect", media_type: "document" });
  });

  it("a stale upload completion is ignored and the latest pick wins", async () => {
    const pending: Array<(value: unknown) => void> = [];
    vi.mocked(supabase.functions.invoke).mockImplementation(
      () => new Promise((resolve) => { pending.push((value: unknown) => resolve(value as never)); }),
    );
    renderManager();
    await openDialog();
    openSourceTab("Upload file");
    pickFile("a.jpg", "image/jpeg");
    await waitFor(() => expect(pending.length).toBe(1));
    pickFile("b.jpg", "image/jpeg");
    await waitFor(() => expect(pending.length).toBe(2));

    pending[1]({ data: { success: true, mediaFileId: "mf-2", url: "https://res.cloudinary.com/demo/image/upload/b.jpg" }, error: null });
    expect(await screen.findByText("Selected: b.jpg")).toBeInTheDocument();

    pending[0]({ data: { success: true, mediaFileId: "mf-1", url: "https://res.cloudinary.com/demo/image/upload/a.jpg" }, error: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Schedule" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Recipient phone"), { target: { value: "+965 5000 1111" } });
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: FUTURE } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(inserted).not.toBeNull());
    expect(inserted).toMatchObject({ media_url: "https://res.cloudinary.com/demo/image/upload/b.jpg" });
  });

  it("a duplicate submit while the insert is in flight does not schedule twice", async () => {
    holdInsert = true;
    renderManager();
    await openDialog();
    await fillReady();
    const submit = screen.getByRole("button", { name: "Schedule" });
    fireEvent.click(submit);
    await waitFor(() => expect(insertCount).toBe(1));
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(insertCount).toBe(1);
    releaseInsert?.();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(insertCount).toBe(1);
  });

  it("a rejected replacement file clears the in-flight upload so Schedule is enabled", async () => {
    accounts = [OWN[1]];
    const pending: Array<(value: unknown) => void> = [];
    vi.mocked(supabase.functions.invoke).mockImplementation(
      () => new Promise((resolve) => { pending.push((value: unknown) => resolve(value as never)); }),
    );
    renderManager();
    await openDialog();
    openSourceTab("Upload file");
    const schedule = screen.getByRole("button", { name: "Schedule" });

    pickFile("a.jpg", "image/jpeg");
    await waitFor(() => expect(pending.length).toBe(1));
    expect(schedule).toBeDisabled();

    pickFile("notes.exe");
    expect(await screen.findByText("notes.exe is not an allowed file type.")).toBeInTheDocument();
    expect(schedule).toBeEnabled();

    pickFile("b.jpg", "image/jpeg");
    await waitFor(() => expect(pending.length).toBe(2));
    expect(schedule).toBeDisabled();

    const oversized = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(oversized, "size", { value: 10 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("Choose a file"), { target: { files: [oversized] } });
    expect(await screen.findByText("photo.jpg is over the 10 MB limit.")).toBeInTheDocument();
    expect(schedule).toBeEnabled();

    pending[0]({ data: { success: true, mediaFileId: "mf-stale", url: "https://cdn.example/a.jpg" }, error: null });
    pending[1]({ data: { success: true, mediaFileId: "mf-stale-2", url: "https://cdn.example/b.jpg" }, error: null });
    await waitFor(() => expect(schedule).toBeEnabled());
    expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
  });

  it("an unresolvable library file clears the previous selection and stays disabled", async () => {
    const UNAVAILABLE = "This file isn't available right now. Pick another file or upload it again.";
    libraryRows = [
      {
        id: "mf-a",
        file_path: "https://res.cloudinary.com/demo/image/upload/postora_a.webp",
        file_type: "image",
        file_size: 1024,
        mime_type: "image/webp",
        metadata: { kind: "image", original_filename: "photo.webp" },
        storage_bucket: "cloudinary",
        current_object_version: 1,
      },
      {
        id: "mf-b",
        file_path: "https://res.cloudinary.com/demo/image/upload/postora_b.jpg",
        file_type: "image",
        file_size: 2048,
        mime_type: "image/jpeg",
        metadata: { kind: "image", original_filename: "pending.jpg" },
        storage_bucket: "cloudinary",
        current_object_version: 1,
        media_file_providers: [
          { provider: "cloudinary", object_version: 1, status: "pending" },
          { provider: "cloudinary", object_version: 1, status: "failed", delivery_url: "https://cdn.example/failed.jpg" },
          { provider: "cloudinary", object_version: 1, status: "deleted", delivery_url: "https://cdn.example/deleted.jpg" },
        ],
      },
      {
        id: "mf-c",
        file_path: "https://res.cloudinary.com/demo/image/upload/postora_c.jpg",
        file_type: "image",
        file_size: 1500,
        mime_type: "image/jpeg",
        metadata: { kind: "image", original_filename: "ready.jpg" },
        storage_bucket: "cloudinary",
        current_object_version: 1,
      },
    ];
    renderManager();
    await openDialog();
    await fillReady();
    openSourceTab("Choose from Library");

    const pending = await screen.findByRole("button", { name: /pending.jpg/ });
    expect(pending).toBeDisabled();
    expect(pending).toHaveTextContent("unavailable");
    expect(screen.getByRole("button", { name: "Schedule" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /photo\.webp/ }));
    expect(await screen.findByText(CLOUD_REFUSED("webp"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();

    // The disabled control does not take the click. The row behind it does,
    // which is also where a pointer event lands (pointer-events-none).
    fireEvent.click(pending.parentElement as HTMLElement);
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText(CLOUD_REFUSED("webp"))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(inserted).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /ready\.jpg/ }));
    await waitFor(() => expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument());
    expect(screen.queryByText(CLOUD_REFUSED("webp"))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(inserted).not.toBeNull());
    expect(inserted).toMatchObject({
      media_url: "https://res.cloudinary.com/demo/image/upload/postora_c.jpg",
      media_type: "image",
      media_filename: "ready.jpg",
    });
  });

  it("library search is sent to the server and does not hide rows the query returns", async () => {
    libraryRows = LIB;
    renderManager();
    await openDialog();
    openSourceTab("Choose from Library");
    expect(await screen.findByText("photo.webp")).toBeInTheDocument();
    expect(lastMediaQuery.or).toBeNull();
    expect(lastMediaQuery.select).toContain("media_file_providers");
    expect(lastMediaQuery.range).toEqual([0, 49]);

    fireEvent.change(screen.getByPlaceholderText("Search files"), { target: { value: "invoice" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastMediaQuery.or).toBeNull();

    await waitFor(() => {
      expect(lastMediaQuery.or).toBe(
        'metadata->>original_filename.ilike."%invoice%",file_path.ilike."%invoice%"',
      );
      expect(screen.getByText("photo.webp")).toBeInTheDocument();
    });
    expect(screen.getByText("pack.zip")).toBeInTheDocument();
  });

  it.each([
    ["100%", 'metadata->>original_filename.ilike."%100\\\\%%",file_path.ilike."%100\\\\%%"'],
    ["a,b", 'metadata->>original_filename.ilike."%a,b%",file_path.ilike."%a,b%"'],
    ["a(b)", 'metadata->>original_filename.ilike."%a(b)%",file_path.ilike."%a(b)%"'],
    ["a_b", 'metadata->>original_filename.ilike."%a\\\\_b%",file_path.ilike."%a\\\\_b%"'],
  ])("library search escapes %s inside the PostgREST or filter", async (term, expected) => {
    libraryRows = LIB;
    renderManager();
    await openDialog();
    openSourceTab("Choose from Library");
    await screen.findByText("photo.webp");
    fireEvent.change(screen.getByPlaceholderText("Search files"), { target: { value: term } });
    await waitFor(() => expect(lastMediaQuery.or).toBe(expected));
  });

  it("Load more requests the next 50-row range", async () => {
    libraryRows = Array.from({ length: 60 }, (_, index) => ({
      id: `mf-${index}`,
      file_path: `https://cdn.example/f${index}.jpg`,
      file_type: "image",
      file_size: 10,
      mime_type: "image/jpeg",
      metadata: { kind: "image", original_filename: `file-${index}.jpg` },
      storage_bucket: "cloudinary",
      current_object_version: 1,
      media_file_providers: [{ provider: "cloudinary", object_version: 1, status: "ready" }],
    }));
    renderManager();
    await openDialog();
    openSourceTab("Choose from Library");
    expect(await screen.findByText("file-0.jpg")).toBeInTheDocument();
    expect(lastMediaQuery.range).toEqual([0, 49]);
    expect(screen.queryByText("file-50.jpg")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("file-50.jpg")).toBeInTheDocument();
    expect(screen.getByText("file-0.jpg")).toBeInTheDocument();
    expect(lastMediaQuery.range).toEqual([50, 99]);
  });

  it.each([
    ["Images", "image"],
    ["Videos", "video"],
    ["Audio", "audio"],
  ] as const)("kind %s queries file_type %s from the first page", async (label, fileType) => {
    libraryRows = LIB;
    renderManager();
    await openDialog();
    openSourceTab("Choose from Library");
    await screen.findByText("photo.webp");
    await chooseOption("Kind", label);
    await waitFor(() => expect(lastMediaQuery.eqs).toContainEqual(["file_type", fileType]));
    expect(lastMediaQuery.or).toBeNull();
    expect(lastMediaQuery.range).toEqual([0, 49]);
    expect(lastMediaQuery.eqs).toContainEqual(["user_id", "user-1"]);
  });

  it("document and archive kinds are filtered on the server, and a kind change restarts the page", async () => {
    libraryRows = Array.from({ length: 60 }, (_, index) => ({
      id: `mf-${index}`,
      file_path: `https://cdn.example/f${index}.pdf`,
      file_type: "document",
      file_size: 10,
      mime_type: "application/pdf",
      metadata: { kind: "document", original_filename: `doc-${index}.pdf` },
      storage_bucket: "cloudinary",
      current_object_version: 1,
    }));
    renderManager();
    await openDialog();
    openSourceTab("Choose from Library");
    await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(lastMediaQuery.range).toEqual([50, 99]));

    await chooseOption("Kind", "Documents");
    await waitFor(() => expect(lastMediaQuery.or).toContain("metadata->>kind.neq.archive"));
    expect(lastMediaQuery.eqs).toContainEqual(["file_type", "document"]);
    expect(lastMediaQuery.or).toContain('file_path.not.ilike."%.zip"');
    expect(lastMediaQuery.or).toContain('file_path.not.ilike."%.7z"');
    expect(lastMediaQuery.or).toContain("metadata->>kind.is.null");
    expect(lastMediaQuery.range).toEqual([0, 49]);

    await chooseOption("Kind", "Archives");
    await waitFor(() => expect(lastMediaQuery.or).toContain("metadata->>kind.eq.archive"));
    expect(lastMediaQuery.eqs).toContainEqual(["file_type", "document"]);
    expect(lastMediaQuery.or).toContain('file_path.ilike."%.zip"');
    expect(lastMediaQuery.or).toContain('file_path.ilike."%.gz"');
    expect(lastMediaQuery.range).toEqual([0, 49]);
  });

  it("a library load failure and an empty page each have their own message", async () => {
    libraryError = { message: "statement timeout" };
    renderManager();
    await openDialog();
    openSourceTab("Choose from Library");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load your library.");

    libraryError = null;
    libraryRows = [];
    openSourceTab("Upload file");
    openSourceTab("Choose from Library");
    expect(await screen.findByText("No files match.")).toBeInTheDocument();
  });
});
