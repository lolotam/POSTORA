import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { YouTubePublishEvidence } from "../YouTubePublishEvidence";

async function renderUi(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { history: {} } }, defaultNS: "history" });
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

describe("YouTube publish evidence in History", () => {
  it("keeps requested privacy apart from an unknown effective result", async () => {
    await renderUi(
      <YouTubePublishEvidence
        evidence={{
          requested_privacy: "unlisted",
          effective_privacy: "unknown",
          thumbnail: { state: "unknown", reason: null },
          first_comment: { state: "not_requested", reason: null },
        }}
      />,
    );
    const block = screen.getByTestId("youtube-publish-evidence");
    expect(block.textContent).toContain("unlisted");
    expect(block.textContent).toContain("Verified privacy: unknown");
    expect(block.textContent).toContain("Thumbnail: Unconfirmed");
    expect(block.textContent).toContain("First comment: Not requested");
  });

  it("shows independent follow-up failures without claiming the other failed", async () => {
    await renderUi(
      <YouTubePublishEvidence
        evidence={{
          requested_privacy: "private",
          effective_privacy: "private",
          thumbnail: { state: "failed", reason: "download_failed" },
          first_comment: { state: "applied", reason: null },
        }}
      />,
    );
    const block = screen.getByTestId("youtube-publish-evidence");
    expect(block.textContent).toContain("Thumbnail: Failed (download_failed)");
    expect(block.textContent).toContain("First comment: Applied");
  });

  it("shows the playlist outcome next to the thumbnail and the first comment", async () => {
    await renderUi(
      <YouTubePublishEvidence
        evidence={{
          requested_privacy: "private",
          effective_privacy: "private",
          thumbnail: { state: "applied", reason: null },
          first_comment: { state: "not_requested", reason: null },
          playlist: { state: "applied", reason: null },
        }}
      />,
    );
    const block = screen.getByTestId("youtube-publish-evidence");
    expect(block.textContent).toContain("Playlist: Applied");
  });

  it("reports the playlist as not requested when the row never carried one", async () => {
    await renderUi(
      <YouTubePublishEvidence
        evidence={{
          requested_privacy: "private",
          effective_privacy: "private",
          thumbnail: { state: "applied", reason: null },
          first_comment: { state: "not_requested", reason: null },
        }}
      />,
    );
    const block = screen.getByTestId("youtube-publish-evidence");
    expect(block.textContent).toContain("Playlist: Not requested");
  });

  it("keeps a failed playlist from claiming the other follow-ups failed", async () => {
    await renderUi(
      <YouTubePublishEvidence
        evidence={{
          requested_privacy: "private",
          effective_privacy: "private",
          thumbnail: { state: "applied", reason: null },
          first_comment: { state: "applied", reason: null },
          playlist: { state: "failed", reason: "not_owned" },
        }}
      />,
    );
    const block = screen.getByTestId("youtube-publish-evidence");
    expect(block.textContent).toContain("Playlist: Failed (not_owned)");
    expect(block.textContent).toContain("Thumbnail: Applied");
    expect(block.textContent).toContain("First comment: Applied");
  });

  it("renders nothing when no evidence was recorded", async () => {
    const { container } = await renderUi(<YouTubePublishEvidence evidence={null} />);
    expect(container.firstChild).toBeNull();
  });
});
