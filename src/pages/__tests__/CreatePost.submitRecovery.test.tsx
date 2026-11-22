/**
 * Lost-acknowledgement recovery through the real CreatePost entrypoint.
 *
 * The fake backend commits the insert and then loses the response; the client
 * sees a 23505 on its retry and must read back its OWN row by the stable id,
 * verify owner and immutable intent, and enqueue exactly once. A changed draft
 * must be refused instead of silently reusing the original submission.
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
  inserted: [] as Array<Record<string, unknown>>,
  stored: null as Record<string, unknown> | null,
  toasts: [] as string[],
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "owner" }, profile: { preferred_timezone: "UTC", full_name: "Owner" } }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [{ id: "account", platform: "instagram", platform_username: "fixture", is_active: true }],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: (input: { title?: string; description?: string }) => fixture.toasts.push(`${input.title ?? ""} ${input.description ?? ""}`) }) }));
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
    <button type="button" onClick={() => onAccountToggle("account", "instagram")}>Choose account</button>
  ),
}));
vi.mock("@/components/post/SchedulingSection", () => ({ SchedulingSection: () => null }));
vi.mock("@/components/post/UploadMethodSelector", () => ({ UploadMethodSelector: () => null }));
vi.mock("@/components/post/PlatformSettingsSection", () => ({ PlatformSettingsSection: () => null }));
vi.mock("@/components/post/MediaEditorDialogs", () => ({ MediaEditorDialogs: () => null }));
vi.mock("@/components/post/MediaSummaryBanner", () => ({ MediaSummaryBanner: () => null }));
vi.mock("@/components/post/TikTokForYouPreview", () => ({ TikTokForYouPreview: () => null }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "posts") {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              maybeSingle: async () => ({
                data: fixture.stored && fixture.stored.id === id ? fixture.stored : null,
                error: null,
              }),
            }),
          }),
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                fixture.inserted.push(payload);
                // First attempt commits but its acknowledgement is lost.
                if (!fixture.stored) {
                  fixture.stored = { ...payload };
                  return { data: null, error: { message: "network lost" } };
                }
                // The reload retries the same deliberate submission and the
                // database correctly reports the existing primary key.
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

async function submit(user: ReturnType<typeof userEvent.setup>, caption: string) {
  await user.type(screen.getByLabelText("Caption"), caption);
  await user.click(screen.getByRole("button", { name: "Next: Select Platforms" }));
  await user.click(screen.getByRole("button", { name: "Choose account" }));
  await user.click(screen.getByRole("button", { name: "Next: Review & Schedule" }));
  await user.click(screen.getByRole("button", { name: "Post Now" }));
}

beforeEach(() => {
  sessionStorage.clear();
  fixture.enqueue.mockReset().mockResolvedValue({ accepted: true });
  fixture.inserted = [];
  fixture.stored = null;
  fixture.toasts = [];
});

describe("CreatePost lost acknowledgement recovery", () => {
  it("recovers the committed post and enqueues exactly once after a lost ACK and reload", async () => {
    const user = userEvent.setup();
    const first = render(<CreatePost />, { wrapper: wrapper() });
    await submit(user, "Original intent");
    await waitFor(() => expect(fixture.inserted).toHaveLength(1));
    await waitFor(() => expect(fixture.toasts.join(" ")).toMatch(/network lost|failed/i));
    const id = fixture.inserted[0].id;
    // Reload: the composer draft is cleared but the stable submit id survives.
    first.unmount();
    sessionStorage.removeItem("postora_post_draft");

    const second = render(<CreatePost />, { wrapper: wrapper() });
    await submit(user, "Original intent");
    await waitFor(() => expect(fixture.enqueue).toHaveBeenCalledTimes(1));
    // The retry is an INSERT attempt against the same primary key; exactly one
    // post row exists and every attempt carried the same stable identity.
    expect(fixture.inserted.every((payload) => payload.id === id)).toBe(true);
    expect(fixture.stored?.id).toBe(id);
    expect(fixture.enqueue.mock.calls[0][0]).toMatchObject({ postId: id });
    second.unmount();
  });

  it("refuses to reuse the submission when the reloaded draft intent changed", async () => {
    const user = userEvent.setup();
    const first = render(<CreatePost />, { wrapper: wrapper() });
    await submit(user, "Original intent");
    await waitFor(() => expect(fixture.inserted).toHaveLength(1));
    await waitFor(() => expect(fixture.toasts.join(" ")).toMatch(/network lost|failed/i));
    first.unmount();
    sessionStorage.removeItem("postora_post_draft");

    const second = render(<CreatePost />, { wrapper: wrapper() });
    await submit(user, "A different intent");
    await waitFor(() => expect(fixture.toasts.join(" ")).toMatch(/failed|conflict|Post error/i));
    expect(fixture.enqueue).not.toHaveBeenCalled();
    second.unmount();
  });
});
