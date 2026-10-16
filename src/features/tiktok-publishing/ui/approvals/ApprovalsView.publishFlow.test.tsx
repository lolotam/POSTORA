import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import "@/i18n";
import { TikTokReviewGatewayProvider, type TikTokReviewGateway } from "../../application/ports";
import { TikTokMediaUploaderProvider } from "../../application/mediaUploadPort";
import type { CreatorInfo, ReviewDraft } from "../../domain/types";
import { ApprovalsView } from "./ApprovalsView";

vi.mock("@/components/post/MediaLibraryPicker", () => ({ MediaLibraryPicker: () => null }));

// An unaudited TikTok app only offers "Only me", which is what the reporting user has.
const creator: CreatorInfo = {
  nickname: "Saad Abdullah",
  username: "saad.abdullah7619",
  avatarUrl: null,
  privacyLevelOptions: ["SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoPostDurationSec: 600,
  postingBlocked: false,
  postingBlockedReason: null,
};

const readyDraft: ReviewDraft = {
  id: "d1",
  accountId: "acc-1",
  revision: 1,
  state: "pending_review",
  caption: "abc",
  mediaFileId: "media-1",
  mediaDurationSec: 30,
  settings: {
    privacy: "SELF_ONLY",
    allowComment: false,
    allowDuet: false,
    allowStitch: false,
    disclose: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
  },
  rejectionReason: null,
  updatedAt: "2026-10-14T10:00:00.000Z",
  submission: null,
};

function setup() {
  let stored = readyDraft;
  const gateway: TikTokReviewGateway = {
    listAccounts: vi.fn(() => Promise.resolve([{ id: "acc-1", username: "saad.abdullah7619", avatarUrl: null }])),
    creatorInfo: vi.fn(() => Promise.resolve(creator)),
    list: vi.fn(() => Promise.resolve([stored])),
    get: vi.fn(() => Promise.resolve(stored)),
    create: vi.fn(),
    save: vi.fn((_id, _rev, patch) => {
      stored = { ...stored, ...patch, revision: stored.revision + 1 };
      return Promise.resolve(stored);
    }),
    reject: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    reopen: vi.fn(),
    submit: vi.fn(() => Promise.resolve({ submissionId: "s1", postId: "p1", state: "queued" as const })),
    status: vi.fn(() => Promise.resolve({
      state: "queued" as const, updatedAt: "2026-10-14T10:00:00.000Z", reason: null, postUrl: null, reopenable: false,
    })),
    resolveMediaPreview: vi.fn(() => Promise.resolve(null)),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TikTokReviewGatewayProvider gateway={gateway}>
        <TikTokMediaUploaderProvider uploader={{ uploadVideo: vi.fn() }}>
          <MemoryRouter initialEntries={["/approvals"]}>
            <ApprovalsView />
          </MemoryRouter>
        </TikTokMediaUploaderProvider>
      </TikTokReviewGatewayProvider>
    </QueryClientProvider>,
  );
  return gateway;
}

const approve = () => screen.getByRole("button", { name: /^Approve$/ });
const schedule = () => screen.getByRole("button", { name: /^Schedule$/ });

async function confirmSettings() {
  fireEvent.click(await screen.findByRole("button", { name: "TikTok settings" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: /I consent to send this content/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
}

describe("Approve / Schedule enablement (reported: both buttons unclickable)", () => {
  it("starts disabled, and the reason points at the TikTok settings", async () => {
    setup();
    await screen.findByRole("button", { name: "TikTok settings" });
    expect(approve()).toBeDisabled();
    expect(schedule()).toBeDisabled();
    expect(await screen.findByText(/Open TikTok settings and confirm this post/)).toBeInTheDocument();
  });

  it("confirming the settings enables Approve", async () => {
    setup();
    await confirmSettings();
    await waitFor(() => expect(approve()).toBeEnabled());
  });

  it("confirming the settings first, then choosing 'In 1 hour', keeps Schedule enabled", async () => {
    setup();
    await confirmSettings();
    await waitFor(() => expect(approve()).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    await waitFor(() => expect(schedule()).toBeEnabled());
  });

  it("choosing 'In 1 hour' first, then confirming the settings, enables Schedule", async () => {
    setup();
    await screen.findByRole("button", { name: "TikTok settings" });
    fireEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    await confirmSettings();
    await waitFor(() => expect(schedule()).toBeEnabled());
  });

  it("confirming, scheduling, then going back to 'Now' enables Approve again", async () => {
    setup();
    await confirmSettings();
    await waitFor(() => expect(approve()).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "In 1 hour" }));
    fireEvent.click(screen.getByRole("button", { name: "Now" }));
    await waitFor(() => expect(approve()).toBeEnabled());
  });
});
