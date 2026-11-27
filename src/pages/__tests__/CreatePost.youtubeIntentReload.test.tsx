/**
 * A YouTube-customized draft survives a lost acknowledgement and reload.
 *
 * The creator set private visibility, both D3 answers, an owned thumbnail and
 * an external video source. On reload the persisted source intent must be
 * restored BEFORE the immutable intent is compared, so the original submission
 * is recovered instead of being rejected as a changed draft.
 */
import { Suspense, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessingJobsProvider } from "@/contexts/ProcessingJobsContext";
import CreatePost from "../CreatePost";

const fixture = vi.hoisted(() => ({
  enqueue: vi.fn(),
  stored: null as Record<string, unknown> | null,
  toasts: [] as string[],
  scheduledIso: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "owner" }, profile: { preferred_timezone: "UTC", full_name: "Owner" } }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [{ id: "account", platform: "youtube", platform_username: "fixture", is_active: true }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (input: { title?: string; description?: string }) => fixture.toasts.push(`${input.title ?? ""} ${input.description ?? ""}`) }),
}));
vi.mock("@/hooks/useFeatureFlags", () => ({ useFeatureFlags: () => ({ flags: {}, isLoading: false }) }));
vi.mock("@/hooks/useUserRole", () => ({ useUserRole: () => ({ isAdmin: false }) }));
vi.mock("@/hooks/useQuotas", () => ({ useQuotas: () => ({ canCreatePost: async () => ({ allowed: true }) }) }));
vi.mock("@/contexts/PublishingContext", () => ({
  usePublishing: () => ({ trackPublishingPost: vi.fn(), clearPublishingPost: vi.fn() }),
}));
vi.mock("@/features/publishing/infrastructure/enqueuePostPublish", () => ({
  enqueuePostPublish: (input: unknown) => fixture.enqueue(input),
}));
vi.mock("@/features/media-upload", () => ({ useMediaUploadLimits: () => ({}), uploadLargeMedia: vi.fn() }));
vi.mock("@/components/layout/DashboardLayout", () => ({ DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/post/CaptionSection", () => ({
  CaptionSection: ({ caption, setCaption }: { caption: string; setCaption: (value: string) => void }) => (
    <label>Caption<textarea value={caption} onChange={(event) => setCaption(event.target.value)} /></label>
  ),
}));
vi.mock("@/components/post/AccountSelectionSidebar", () => ({
  AccountSelectionSidebar: ({ onAccountToggle }: { onAccountToggle: (id: string, platform: string) => void }) => (
    <button type="button" onClick={() => onAccountToggle("account", "youtube")}>Choose account</button>
  ),
}));
vi.mock("@/components/post/SchedulingSection", () => ({ SchedulingSection: () => null }));
vi.mock("@/components/post/UploadMethodSelector", () => ({ UploadMethodSelector: () => null }));
vi.mock("@/components/post/MediaEditorDialogs", () => ({ MediaEditorDialogs: () => null }));
vi.mock("@/components/post/MediaSummaryBanner", () => ({ MediaSummaryBanner: () => null }));
vi.mock("@/components/post/TikTokForYouPreview", () => ({ TikTokForYouPreview: () => null }));
vi.mock("@/hooks/useYouTubeCategories", () => ({
  useYouTubeCategories: () => ({ categories: [], loading: false, unavailable: false, region: "US", retry: vi.fn() }),
}));

// A thin real settings surface: the controls call the same change callback the
// real YouTubeSettings uses, so buildPostMetadata sees the same state.
vi.mock("@/components/post/PlatformSettingsSection", () => ({
  PlatformSettingsSection: ({ youtubeSettingsState, onYoutubeSettingsChange }: {
    youtubeSettingsState: {
      visibility: string; madeForKids: boolean | null;
      containsSyntheticMedia: boolean | null; thumbnailMediaId: string | null;
      publishAt?: string; scheduleRequested?: boolean; playlist: string;
    };
    onYoutubeSettingsChange: (changes: Record<string, unknown>) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onYoutubeSettingsChange({ visibility: "unlisted" })}>Set unlisted</button>
      <button type="button" onClick={() => onYoutubeSettingsChange({ visibility: "public" })}>Set public</button>
      <button type="button" onClick={() => onYoutubeSettingsChange({ madeForKids: false })}>Audience No</button>
      <button type="button" onClick={() => onYoutubeSettingsChange({ containsSyntheticMedia: true })}>Synthetic Yes</button>
      <button type="button" onClick={() => onYoutubeSettingsChange({ thumbnailMediaId: "owned-thumb-1" })}>Owned thumbnail</button>
      <button type="button" onClick={() => onYoutubeSettingsChange({ publishAt: fixture.scheduledIso, scheduleRequested: true })}>Schedule on YouTube</button>
      <button type="button" onClick={() => onYoutubeSettingsChange({ publishAt: "", scheduleRequested: true })}>Request schedule without time</button>
      <button type="button" onClick={() => onYoutubeSettingsChange({ publishAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), scheduleRequested: true })}>Schedule too soon</button>
      <button type="button" onClick={() => onYoutubeSettingsChange({ playlist: "PLfixture1" })}>Set playlist</button>
      <span data-testid="youtube-values">{JSON.stringify({
        visibility: youtubeSettingsState.visibility,
        madeForKids: youtubeSettingsState.madeForKids,
        containsSyntheticMedia: youtubeSettingsState.containsSyntheticMedia,
        thumbnailMediaId: youtubeSettingsState.thumbnailMediaId,
        publishAt: youtubeSettingsState.publishAt,
        scheduleRequested: youtubeSettingsState.scheduleRequested,
        playlist: youtubeSettingsState.playlist,
      })}</span>
    </div>
  ),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "posts") {
        const selection = (filters: Record<string, string> = {}): Record<string, unknown> => ({
          eq: (column: string, value: string) => selection({ ...filters, [column]: value }),
          maybeSingle: async () => {
            const row = fixture.stored;
            const matches = row && Object.entries(filters).every(([column, value]) => row[column] === value);
            return { data: matches ? row : null, error: null };
          },
        });
        return {
          select: () => selection(),
          update: () => ({ eq: () => ({ is: async () => ({ error: null }) }) }),
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                if (!fixture.stored) {
                  fixture.stored = {
                    ...payload,
                    publish_requested_at: "2026-11-22T10:00:00.000Z",
                  };
                  return { data: null, error: { message: "network lost" } };
                }
                return { data: null, error: { code: "23505", message: "duplicate key" } };
              },
            }),
          }),
        };
      }
      return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
    },
    storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) },
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
  },
}));

Object.defineProperty(window, "navigator", {
  configurable: true,
  writable: true,
  value: { ...window.navigator, clipboard: { writeText: vi.fn(), readText: vi.fn() } },
});

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { post: {}, postmedia: {} } }, defaultNS: "post" });

function wrapper() {
  return ({ children }: { children: ReactNode }) => (
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <ProcessingJobsProvider>
          <MemoryRouter initialEntries={["/post"]}>
            <Suspense fallback={null}>{children}</Suspense>
          </MemoryRouter>
        </ProcessingJobsProvider>
      </TooltipProvider>
    </I18nextProvider>
  );
}

async function customize(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Set unlisted" }));
  await user.click(screen.getByRole("button", { name: "Audience No" }));
  await user.click(screen.getByRole("button", { name: "Synthetic Yes" }));
  await user.click(screen.getByRole("button", { name: "Owned thumbnail" }));
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Caption"), "YouTube customized");
  await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
  await user.click(screen.getByRole("button", { name: "Choose account" }));
  await customize(user);
  await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
  await user.click(screen.getByRole("button", { name: "Post Now" }));
}

beforeEach(() => {
  sessionStorage.clear();
  fixture.enqueue.mockReset().mockResolvedValue({ accepted: true });
  fixture.stored = null;
  fixture.toasts = [];
});

describe("CreatePost YouTube customized lost-ACK reload", () => {
  it("restores the YouTube intent before comparing it and does not reject the original submission", async () => {
    const user = userEvent.setup();
    const first = render(<CreatePost />, { wrapper: wrapper() });
    await submit(user);
    await waitFor(() => expect(fixture.stored).toBeTruthy());
    expect("youtube_publish_at" in (fixture.stored!.metadata as Record<string, unknown>)).toBe(false);
    first.unmount();
    // Only the composer draft is cleared; the stable submit id and the source
    // intent snapshot survive, just as after a browser reload.
    sessionStorage.removeItem("postora_post_draft");

    const second = render(<CreatePost />, { wrapper: wrapper() });
    await user.type(screen.getByLabelText("Caption"), "YouTube customized");
    // The restored draft is at step 1; reach step 2 so the real settings
    // surface is mounted and displays the hydrated state.
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Choose account" }));
    await waitFor(() => expect(screen.getByTestId("youtube-values")).toHaveTextContent("unlisted"));
    expect(screen.getByTestId("youtube-values")).toHaveTextContent('"madeForKids":false');
    expect(screen.getByTestId("youtube-values")).toHaveTextContent('"containsSyntheticMedia":true');
    expect(screen.getByTestId("youtube-values")).toHaveTextContent('"thumbnailMediaId":"owned-thumb-1"');

    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await waitFor(() => expect(fixture.toasts.join(" ")).toMatch(/Already submitted/i));
    expect(fixture.toasts.join(" ")).not.toMatch(/Submission changed/i);
    expect(fixture.enqueue).not.toHaveBeenCalled();
    second.unmount();
  });

  it("serializes youtube_publish_at when scheduled and restores publishAt across a lost-ACK reload", async () => {
    const user = userEvent.setup();
    const first = render(<CreatePost />, { wrapper: wrapper() });
    await user.type(screen.getByLabelText("Caption"), "YouTube scheduled");
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Choose account" }));
    await customize(user);
    await user.click(screen.getByRole("button", { name: "Schedule on YouTube" }));
    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await waitFor(() => expect(fixture.stored).toBeTruthy());
    expect((fixture.stored!.metadata as Record<string, unknown>).youtube_publish_at).toBe(fixture.scheduledIso);
    expect((fixture.stored!.metadata as Record<string, unknown>).youtube_visibility).toBe("private");
    first.unmount();

    sessionStorage.removeItem("postora_post_draft");

    const second = render(<CreatePost />, { wrapper: wrapper() });
    await user.type(screen.getByLabelText("Caption"), "YouTube scheduled");
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Choose account" }));
    await waitFor(() => expect(screen.getByTestId("youtube-values")).toHaveTextContent(fixture.scheduledIso));

    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await waitFor(() => expect(fixture.toasts.join(" ")).toMatch(/Already submitted/i));
    expect(fixture.toasts.join(" ")).not.toMatch(/Submission changed/i);
    expect(fixture.enqueue).not.toHaveBeenCalled();
    second.unmount();
  });

  it("blocks submit when Schedule on YouTube is chosen without a time, never publishing public early", async () => {
    const user = userEvent.setup();
    const view = render(<CreatePost />, { wrapper: wrapper() });
    await user.type(screen.getByLabelText("Caption"), "YouTube schedule missing time");
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Choose account" }));
    await customize(user);
    await user.click(screen.getByRole("button", { name: "Set public" }));
    await user.click(screen.getByRole("button", { name: "Request schedule without time" }));
    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Post Now" }));

    await waitFor(() =>
      expect(fixture.toasts.join(" ")).toMatch(/Choose a YouTube scheduled publish date and time/i),
    );
    expect(fixture.stored).toBeNull();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    view.unmount();
  });

  it("blocks submit when the YouTube publish time is inside the 15-minute lead window", async () => {
    const user = userEvent.setup();
    const view = render(<CreatePost />, { wrapper: wrapper() });
    await user.type(screen.getByLabelText("Caption"), "YouTube schedule too soon");
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Choose account" }));
    await customize(user);
    await user.click(screen.getByRole("button", { name: "Schedule too soon" }));
    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Post Now" }));

    await waitFor(() =>
      expect(fixture.toasts.join(" ")).toMatch(/at least 15 minutes in the future/i),
    );
    expect(fixture.stored).toBeNull();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    view.unmount();
  });

  it("serializes youtube_playlist_id when a playlist is chosen and restores it across a lost-ACK reload", async () => {
    const user = userEvent.setup();
    const first = render(<CreatePost />, { wrapper: wrapper() });
    await user.type(screen.getByLabelText("Caption"), "YouTube playlist");
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Choose account" }));
    await customize(user);
    await user.click(screen.getByRole("button", { name: "Set playlist" }));
    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await waitFor(() => expect(fixture.stored).toBeTruthy());
    expect((fixture.stored!.metadata as Record<string, unknown>).youtube_playlist_id).toBe("PLfixture1");
    first.unmount();

    sessionStorage.removeItem("postora_post_draft");

    const second = render(<CreatePost />, { wrapper: wrapper() });
    await user.type(screen.getByLabelText("Caption"), "YouTube playlist");
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Choose account" }));
    await waitFor(() => expect(screen.getByTestId("youtube-values")).toHaveTextContent('"playlist":"PLfixture1"'));

    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await waitFor(() => expect(fixture.toasts.join(" ")).toMatch(/Already submitted/i));
    expect(fixture.toasts.join(" ")).not.toMatch(/Submission changed/i);
    second.unmount();
  });

  it("sends no playlist key when no playlist was chosen", async () => {
    const user = userEvent.setup();
    const view = render(<CreatePost />, { wrapper: wrapper() });
    await user.type(screen.getByLabelText("Caption"), "YouTube without playlist");
    await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
    await user.click(screen.getByRole("button", { name: "Choose account" }));
    await customize(user);
    await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
    await user.click(screen.getByRole("button", { name: "Post Now" }));
    await waitFor(() => expect(fixture.stored).toBeTruthy());
    expect("youtube_playlist_id" in (fixture.stored!.metadata as Record<string, unknown>)).toBe(false);
    view.unmount();
  });
});
