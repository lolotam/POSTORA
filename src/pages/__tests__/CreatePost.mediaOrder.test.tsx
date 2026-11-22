import { startTransition, Suspense, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessingJobsProvider } from "@/contexts/ProcessingJobsContext";
import CreatePost from "../CreatePost";

const fixture = vi.hoisted(() => ({
  enqueue: vi.fn(),
  invoke: vi.fn(),
  track: vi.fn(),
  clearTracking: vi.fn(),
  inserts: [] as Array<Record<string, unknown>>,
  persistenceAttempts: 0,
  persistenceWait: null as Promise<void> | null,
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
  failPersistence: false,
  post: null as Record<string, unknown> | null,
  mediaRows: [] as Array<Record<string, unknown>>,
  mediaError: null as { message: string } | null,
  postRead: null as Promise<void> | null,
  profile: { preferred_timezone: "UTC", full_name: "Owner" } as { preferred_timezone: string; full_name: string } | null,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "owner" }, profile: fixture.profile }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [{ id: "account", platform: "instagram", platform_username: "fixture", is_active: true }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useFeatureFlags", () => ({ useFeatureFlags: () => ({ flags: {}, isLoading: false }) }));
vi.mock("@/hooks/useUserRole", () => ({ useUserRole: () => ({ isAdmin: false }) }));
vi.mock("@/hooks/useQuotas", () => ({ useQuotas: () => ({ canCreatePost: async () => ({ allowed: true }) }) }));
vi.mock("@/contexts/PublishingContext", () => ({
  usePublishing: () => ({ trackPublishingPost: fixture.track, clearPublishingPost: fixture.clearTracking }),
}));
vi.mock("@/features/publishing/infrastructure/enqueuePostPublish", () => ({
  enqueuePostPublish: (input: unknown) => fixture.enqueue(input),
}));
vi.mock("@/features/media-upload", () => ({ useMediaUploadLimits: () => ({}), uploadLargeMedia: vi.fn() }));
vi.mock("@/components/layout/DashboardLayout", () => ({ DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/post/CaptionSection", () => ({
  CaptionSection: ({ caption, setCaption }: { caption: string; setCaption: (caption: string) => void }) => (
    <label>Caption<textarea value={caption} onChange={(event) => setCaption(event.target.value)} /></label>
  ),
}));
vi.mock("@/components/post/AccountSelectionSidebar", () => ({
  AccountSelectionSidebar: ({ onAccountToggle }: { onAccountToggle: (id: string, platform: string) => void }) => (
    <button type="button" onClick={() => onAccountToggle("account", "instagram")}>Choose account</button>
  ),
}));
vi.mock("@/components/post/SchedulingSection", () => ({
  SchedulingSection: ({ setScheduleEnabled, setScheduledAt }: {
    setScheduleEnabled: (enabled: boolean) => void;
    setScheduledAt: (date: Date) => void;
  }) => <button type="button" onClick={() => {
    setScheduleEnabled(true);
    setScheduledAt(new Date("2027-01-02T03:04:00Z"));
  }}>Set schedule</button>,
}));
vi.mock("@/components/post/UploadMethodSelector", () => ({
  UploadMethodSelector: ({ setUploadMethod }: { setUploadMethod: (method: "local" | "url" | "text") => void }) => (
    <button type="button" onClick={() => setUploadMethod("url")}>URL mode</button>
  ),
}));
vi.mock("@/components/post/PlatformSettingsSection", () => ({ PlatformSettingsSection: () => null }));
vi.mock("@/components/post/MediaEditorDialogs", () => ({ MediaEditorDialogs: () => null }));
vi.mock("@/components/post/MediaSummaryBanner", () => ({ MediaSummaryBanner: () => null }));
vi.mock("@/components/post/TikTokForYouPreview", () => ({ TikTokForYouPreview: () => null }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "media_files") {
        return {
          select: () => ({
            in: async () => ({ data: fixture.mediaError ? null : fixture.mediaRows, error: fixture.mediaError }),
          }),
        };
      }
      if (table === "posts") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => {
                if (fixture.postRead) await fixture.postRead;
                return { data: fixture.post, error: fixture.post ? null : { message: "not found" } };
              },
            }),
          }),
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                fixture.persistenceAttempts++;
                if (fixture.persistenceWait) await fixture.persistenceWait;
                if (fixture.failPersistence) return { data: null, error: { message: "database unavailable" } };
                fixture.inserts.push(payload);
                return { data: { ...payload, id: `new-post-${fixture.inserts.length}` }, error: null };
              },
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_column: string, id: string) => ({
              select: () => ({
                single: async () => {
                  if (fixture.failPersistence) return { data: null, error: { message: "database unavailable" } };
                  fixture.updates.push({ id, payload });
                  return { data: { ...payload, id }, error: null };
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) },
    functions: { invoke: fixture.invoke },
  },
}));

Object.defineProperty(window, "navigator", {
  configurable: true,
  writable: true,
  value: { ...window.navigator, clipboard: { writeText: vi.fn(), readText: vi.fn() } },
});

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { post: {}, postmedia: {} } }, defaultNS: "post" });

function wrapper(initialEntry: string) {
  return ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18n}><TooltipProvider><ProcessingJobsProvider><MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter></ProcessingJobsProvider></TooltipProvider></I18nextProvider>
  );
}

function libraryPayload(ids: string[]) {
  sessionStorage.setItem("mediaLibrarySelection", JSON.stringify(ids.map((id) => ({
    id,
    url: `https://images.example/${id}.png`,
    fileType: "image",
    fileName: `${id}.png`,
    size: 1,
    storageBucket: "cloudinary",
  }))));
}

async function chooseAccountAndReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
  await user.click(screen.getByRole("button", { name: "Choose account" }));
  await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
}

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem("unrelated-preference", "keep");
  fixture.inserts = [];
  fixture.persistenceAttempts = 0;
  fixture.persistenceWait = null;
  fixture.updates = [];
  fixture.failPersistence = false;
  fixture.post = null;
  fixture.mediaRows = [];
  fixture.mediaError = null;
  fixture.postRead = null;
  fixture.profile = { preferred_timezone: "UTC", full_name: "Owner" };
  fixture.enqueue.mockReset().mockResolvedValue({ accepted: true });
  fixture.invoke.mockReset();
  fixture.track.mockClear();
  fixture.clearTracking.mockClear();
});

describe("CreatePost media ordering and saved completion", () => {
  it("writes a stable client-generated post id and immutable intent fingerprint, then clears it on success", async () => {
    const user = userEvent.setup();
    const view = render(<CreatePost />, { wrapper: wrapper("/post") });
    await user.type(screen.getByLabelText("Caption"), "Stable submission");
    await chooseAccountAndReview(user);
    await user.click(screen.getByRole("button", { name: "Post Now" }));

    await waitFor(() => expect(fixture.inserts).toHaveLength(1));
    const insert = fixture.inserts[0];
    expect(typeof insert.id).toBe("string");
    expect(String(insert.id)).toMatch(/^[0-9a-f-]{36}$/);
    const metadata = insert.metadata as Record<string, unknown>;
    expect(metadata.submit_id).toBe(insert.id);
    expect(typeof metadata.submit_fingerprint).toBe("string");
    expect(String(metadata.submit_fingerprint)).toContain("Stable submission");

    await screen.findByTestId("saved-post-id");
    expect(sessionStorage.getItem("youtube-stage3-submit:owner:new")).toBeNull();
    view.unmount();
  });

  it.each(["saving", "enqueueing"])("does not restore a submitted draft when profile timezone arrives during %s", async (phase) => {
    fixture.profile = null;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    if (phase === "saving") fixture.persistenceWait = pending;
    else fixture.enqueue.mockImplementation(async () => { await pending; return { accepted: true }; });
    const user = userEvent.setup();
    const { rerender } = render(<CreatePost />, { wrapper: wrapper("/post") });
    try {
      await user.type(screen.getByLabelText("Caption"), "Successfully submitted");
      await chooseAccountAndReview(user);
      await user.click(screen.getByRole("button", { name: "Post Now" }));
      await waitFor(() => phase === "saving"
        ? expect(fixture.persistenceAttempts).toBe(1)
        : expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      fixture.profile = { preferred_timezone: "Asia/Kuwait", full_name: "Owner" };
      rerender(<CreatePost />);
      await act(async () => { release(); await pending; });
      await screen.findByTestId("saved-post-id");
      expect(sessionStorage.getItem("postora_post_draft")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Create new post" }));
      expect(screen.getByLabelText("Caption")).toHaveValue("");
      expect(fixture.inserts).toHaveLength(1);
    } finally {
      await act(async () => { release(); await pending; });
    }
  });

  it("keeps completion on the committed route when another navigation render suspends", async () => {
    let releaseEnqueue!: () => void;
    let releaseNavigation!: () => void;
    const enqueueWait = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
    const navigationWait = new Promise<void>((resolve) => { releaseNavigation = resolve; });
    let navigationBlocked = true;
    fixture.enqueue.mockImplementation(async () => { await enqueueWait; return { accepted: true }; });
    const reachedSuspension = vi.fn();
    function Navigation() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => startTransition(() => { navigate("/post?suspend=1"); })}>Suspend navigation</button>;
    }
    function NavigationResource() {
      const location = useLocation();
      if (navigationBlocked && location.search.includes("suspend=1")) {
        reachedSuspension();
        throw navigationWait;
      }
      return null;
    }
    const RouterWrapper = wrapper("/post");
    const user = userEvent.setup();
    const { unmount } = render(<><Navigation /><CreatePost /><NavigationResource /></>, {
      wrapper: ({ children }) => <Suspense fallback={<div>Suspended navigation</div>}><RouterWrapper>{children}</RouterWrapper></Suspense>,
    });
    try {
      await user.type(screen.getByLabelText("Caption"), "Committed route post");
      await chooseAccountAndReview(user);
      await user.click(screen.getByRole("button", { name: "Post Now" }));
      await waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole("button", { name: "Suspend navigation" }));
      await waitFor(() => expect(reachedSuspension).toHaveBeenCalled());
      expect(screen.queryByText("Suspended navigation")).not.toBeInTheDocument();
      await act(async () => { releaseEnqueue(); await enqueueWait; });
      await screen.findByTestId("saved-post-id");
      expect(screen.queryByRole("button", { name: "Post Now" })).not.toBeInTheDocument();
      expect(fixture.inserts).toHaveLength(1);
    } finally {
      unmount();
      navigationBlocked = false;
      await act(async () => { releaseEnqueue(); releaseNavigation(); await enqueueWait; });
    }
  });

  it.each(["saving", "enqueueing"])("clears its submitted draft after leaving for History during %s", async (phase) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    if (phase === "saving") fixture.persistenceWait = pending;
    else fixture.enqueue.mockImplementation(async () => { await pending; return { accepted: true }; });
    function Navigation() {
      const navigate = useNavigate();
      return <>
        <button type="button" onClick={() => navigate("/history")}>Go History</button>
        <button type="button" onClick={() => navigate("/post")}>Return composer</button>
      </>;
    }
    const user = userEvent.setup();
    render(<><Navigation /><Routes>
      <Route path="/post" element={<CreatePost />} />
      <Route path="/history" element={<div>History route</div>} />
    </Routes></>, { wrapper: wrapper("/post") });
    try {
      await user.type(screen.getByLabelText("Caption"), "Successfully submitted");
      await chooseAccountAndReview(user);
      await user.click(screen.getByRole("button", { name: "Post Now" }));
      await waitFor(() => phase === "saving"
        ? expect(fixture.persistenceAttempts).toBe(1)
        : expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole("button", { name: "Go History" }));
      await screen.findByText("History route");
      await act(async () => { release(); await pending; });
      expect(fixture.inserts).toHaveLength(1);
      expect(sessionStorage.getItem("postora_post_draft")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Return composer" }));
      expect(screen.getByLabelText("Caption")).toHaveValue("");
      expect(fixture.updates).toHaveLength(0);
    } finally {
      await act(async () => { release(); await pending; });
    }
  });

  it.each([
    ["saving", false], ["enqueueing", false], ["saving", true], ["enqueueing", true],
  ])("preserves the new draft when %s finishes after another edit identity (return=%s)", async (phase, returnToOriginalRoute) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    if (phase === "saving") fixture.persistenceWait = pending;
    else fixture.enqueue.mockImplementation(async () => { await pending; return { accepted: true }; });
    fixture.post = { id: "other-post", caption: "Other saved post", media_file_ids: [], metadata: { selected_account_ids: ["account"] } };
    function Navigation() {
      const navigate = useNavigate();
      return <>
        <button type="button" onClick={() => navigate("/post?edit=other-post")}>Edit another</button>
        <button type="button" onClick={() => navigate("/post")}>Return to composer</button>
      </>;
    }
    const user = userEvent.setup();
    render(<><Navigation /><CreatePost /></>, { wrapper: wrapper("/post") });
    try {
      await user.type(screen.getByLabelText("Caption"), "Original submission");
      await chooseAccountAndReview(user);
      await user.click(screen.getByRole("button", { name: "Post Now" }));
      await waitFor(() => phase === "saving"
        ? expect(fixture.persistenceAttempts).toBe(1)
        : expect(fixture.enqueue).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole("button", { name: "Edit another" }));
      await screen.findByDisplayValue("Other saved post");
      if (returnToOriginalRoute) await user.click(screen.getByRole("button", { name: "Return to composer" }));
      await act(async () => { release(); await pending; });
      expect(fixture.inserts).toHaveLength(1);
      expect(screen.queryByTestId("saved-post-id")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Caption")).toHaveValue("Other saved post");
      expect(JSON.parse(sessionStorage.getItem("postora_post_draft")!).caption).toBe("Other saved post");
      await user.clear(screen.getByLabelText("Caption"));
      await user.type(screen.getByLabelText("Caption"), "Keep the new draft");
      expect(JSON.parse(sessionStorage.getItem("postora_post_draft")!).caption).toBe("Keep the new draft");
      expect(fixture.updates).toHaveLength(0);
    } finally {
      await act(async () => { release(); await pending; });
    }
  });

  it.each(["saving", "enqueueing"])("shows completion after same-route navigation during %s without allowing another submission", async (phase) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    if (phase === "saving") fixture.persistenceWait = pending;
    else fixture.enqueue.mockImplementation(async () => { await pending; return { accepted: true }; });
    function SidebarNavigation() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate("/post")}>Sidebar Create Post</button>;
    }
    const user = userEvent.setup();
    render(<><SidebarNavigation /><CreatePost /></>, { wrapper: wrapper("/post") });
    await user.type(screen.getByLabelText("Caption"), "Pending post");
    await chooseAccountAndReview(user);
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await waitFor(() => phase === "saving"
      ? expect(fixture.persistenceAttempts).toBe(1)
      : expect(fixture.enqueue).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Sidebar Create Post" }));
    release();
    await screen.findByTestId("saved-post-id");
    expect(screen.queryByRole("button", { name: "Post Now" })).not.toBeInTheDocument();
    expect(fixture.inserts).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Create new post" }));
    expect(screen.getByLabelText("Caption")).toHaveValue("");
  });

  it("keeps completion after saving but opens a fresh composer on a new same-route navigation", async () => {
    function SidebarNavigation() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate("/post")}>Sidebar Create Post</button>;
    }
    const user = userEvent.setup();
    render(<><SidebarNavigation /><CreatePost /></>, { wrapper: wrapper("/post") });
    await user.type(screen.getByLabelText("Caption"), "First post");
    await chooseAccountAndReview(user);
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await screen.findByTestId("saved-post-id");
    expect(screen.queryByLabelText("Caption")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sidebar Create Post" }));
    expect(screen.getByLabelText("Caption")).toHaveValue("");
    expect(screen.queryByTestId("saved-post-id")).not.toBeInTheDocument();
    expect(fixture.inserts).toHaveLength(1);
  });

  it("removes an interrupted draft attachment without discarding the caption or other media", async () => {
    sessionStorage.setItem("postora_post_draft", JSON.stringify({
      caption: "Retain my caption", selectedAccountIds: [], savedAt: Date.now(),
      uploadMethod: "local", fileMetadata: [
        { id: "pending", fileType: "image", previewUrl: "https://images.example/pending.png", uploaded: false },
        { id: "good", fileType: "image", previewUrl: "https://images.example/good.png", storagePath: "good" },
      ],
    }));
    const user = userEvent.setup();
    render(<CreatePost />, { wrapper: wrapper("/post") });
    await user.click(screen.getByRole("button", { name: "Remove media 1" }));
    expect(screen.getByRole("textbox", { name: "Caption" })).toHaveValue("Retain my caption");
    expect(screen.getAllByRole("img")).toHaveLength(1);
    await chooseAccountAndReview(user);
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await screen.findByText("Submitted for publishing. Check History for the final result.");
    expect(fixture.inserts[0].media_file_ids).toEqual(["good"]);
    expect(fixture.inserts[0].caption).toBe("Retain my caption");
  });

  it("persists the reordered gallery and never treats submission as completed publishing", async () => {
    libraryPayload(["a", "b", "c"]);
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const handle = this.querySelector("button[aria-label^='Move media']") ?? this;
      const position = Number(handle.getAttribute("aria-label")?.match(/Move media (\d+)/)?.[1] ?? 1) - 1;
      const x = (position % 2) * 120;
      const y = Math.floor(position / 2) * 120;
      return { x, y, top: y, left: x, right: x + 100, bottom: y + 100, width: 100, height: 100, toJSON: () => ({}) };
    });
    render(<CreatePost />, { wrapper: wrapper("/post?from=media-library") });
    await screen.findByRole("button", { name: "Move media 1" });
    screen.getByRole("button", { name: "Move media 1" }).focus();
    await user.keyboard("[Space][ArrowRight][Space]");
    await waitFor(() => expect(screen.getAllByRole("img").map((image) => image.getAttribute("src"))).toEqual([
      "https://images.example/b.png", "https://images.example/a.png", "https://images.example/c.png",
    ]));
    await chooseAccountAndReview(user);
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await screen.findByText("Submitted for publishing. Check History for the final result.");
    expect(fixture.inserts).toHaveLength(1);
    expect(fixture.inserts[0].media_file_ids).toEqual(["b", "a", "c"]);
    expect(screen.queryByRole("button", { name: "Post Now" })).not.toBeInTheDocument();
    expect(screen.getByTestId("saved-post-id")).toHaveTextContent("new-post-1");
  });

  it("saves an edit, creates a genuinely fresh composer, then inserts instead of updating the old post", async () => {
    fixture.post = {
      id: "old-post", caption: "Old caption", media_file_ids: ["b", "a"],
      scheduled_at: "2027-02-03T04:05:00Z",
      metadata: { selected_account_ids: ["account"], timezone: "Asia/Kuwait" },
    };
    fixture.mediaRows = [
      { id: "a", file_type: "image", file_path: "https://images.example/a.png" },
      { id: "b", file_type: "image", file_path: "https://images.example/b.png" },
    ];
    fixture.enqueue.mockResolvedValue({ accepted: true });
    const user = userEvent.setup();
    render(<CreatePost />, { wrapper: wrapper("/post?edit=old-post") });
    await screen.findByDisplayValue("Old caption");
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Schedule Post" }));
    await screen.findByText("Scheduled. Check History for the publishing time and status.");
    expect(fixture.updates).toEqual([expect.objectContaining({ id: "old-post" })]);

    await user.click(screen.getByRole("button", { name: "Create new post" }));
    expect(screen.getByLabelText("Caption")).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Move media/ })).not.toBeInTheDocument();
    expect(sessionStorage.getItem("unrelated-preference")).toBe("keep");
    await user.type(screen.getByLabelText("Caption"), "Fresh caption");
    await chooseAccountAndReview(user);
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await screen.findByText("Submitted for publishing. Check History for the final result.");
    expect(fixture.updates).toHaveLength(1);
    expect(fixture.inserts).toHaveLength(1);
    expect(fixture.inserts[0].caption).toBe("Fresh caption");
    expect(fixture.inserts[0].media_file_ids).toBeNull();
  });

  it("keeps History and saved identity when enqueue is unconfirmed", async () => {
    fixture.enqueue.mockResolvedValue({ accepted: false, reason: "error" });
    const user = userEvent.setup();
    render(<CreatePost />, { wrapper: wrapper("/post") });
    await user.type(screen.getByLabelText("Caption"), "Queued caption");
    await chooseAccountAndReview(user);
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await screen.findByText("Saved, but publishing could not be confirmed. Check History before retrying.");
    expect(screen.getByRole("link", { name: "View History" })).toBeInTheDocument();
    expect(screen.getByTestId("saved-post-id")).toHaveTextContent("new-post-1");
    expect(fixture.inserts).toHaveLength(1);
  });

  it("retains the draft on persistence failure and prevents double submission", async () => {
    fixture.failPersistence = true;
    let releasePersistence!: () => void;
    fixture.persistenceWait = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const user = userEvent.setup();
    render(<CreatePost />, { wrapper: wrapper("/post") });
    await user.type(screen.getByLabelText("Caption"), "Do not lose this");
    await chooseAccountAndReview(user);
    await user.dblClick(screen.getByRole("button", { name: "Post Now" }));
    releasePersistence();
    await waitFor(() => expect(screen.getByRole("button", { name: "Post Now" })).toBeEnabled());
    expect(fixture.inserts).toHaveLength(0);
    expect(fixture.persistenceAttempts).toBe(1);
    expect(screen.queryByText("Post saved")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Caption")).toHaveValue("Do not lose this");
  });

  it("rejects a partial URL upload and preserves the entered URLs without saving a subset", async () => {
    fixture.invoke.mockImplementation(async (_name: string, { body }: { body: Record<string, unknown> }) => {
      if (String(body.externalUrl).includes("bad")) return { data: { success: false, error: "invalid URL" }, error: null };
      return { data: { success: true, mediaFileId: "url-good", url: "https://images.example/good.png" }, error: null };
    });
    const user = userEvent.setup();
    render(<CreatePost />, { wrapper: wrapper("/post") });
    await user.type(screen.getByLabelText("Caption"), "URL draft");
    await user.click(screen.getByRole("button", { name: "URL mode" }));
    await user.type(screen.getByPlaceholderText("Enter image URLs (one per line, max 10)"), "https://images.example/good.png\nhttps://images.example/bad.png");
    await chooseAccountAndReview(user);
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Post Now" })).toBeEnabled());
    expect(fixture.inserts).toHaveLength(0);
    expect(fixture.enqueue).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByPlaceholderText("Enter image URLs (one per line, max 10)")).toHaveValue("https://images.example/good.png\nhttps://images.example/bad.png");
    expect(screen.getByLabelText("Caption")).toHaveValue("URL draft");
  });

  it("does not let a delayed edit response overwrite a fresh draft", async () => {
    let releaseRead!: () => void;
    fixture.postRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    fixture.post = { id: "old-post", caption: "Stale caption", media_file_ids: [], metadata: {} };
    function NavigationControl() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate("/post", { replace: true })}>Leave edit</button>;
    }
    const user = userEvent.setup();
    render(<><NavigationControl /><CreatePost /></>, { wrapper: wrapper("/post?edit=old-post") });
    await user.type(screen.getByLabelText("Caption"), "Fresh draft");
    await user.click(screen.getByRole("button", { name: "Leave edit" }));
    releaseRead();
    await waitFor(() => expect(screen.getByLabelText("Caption")).toHaveValue("Fresh draft"));
    expect(screen.queryByDisplayValue("Stale caption")).not.toBeInTheDocument();
  });
});
